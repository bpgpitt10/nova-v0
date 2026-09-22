export type TeeCalibrationStatus = 'candidate' | 'confirmed' | 'locked'

export type TeeCalibrationLocalPoint = readonly [number, number]

export type TeeCalibrationWorldPoint = Readonly<{
  x: number
  y: number
  z: number
}>

export type TeeCalibrationRecord = Readonly<{
  schemaVersion: 'looper-tee-calibration-v1'
  recordKey: string
  courseFingerprint: string
  holeNumber: number
  teeSet: string
  teeLabel?: string
  osmTeeId?: string
  courseLocalYds: TeeCalibrationLocalPoint
  gsproWorld?: TeeCalibrationWorldPoint
  expectedYardageYds?: number
  status: TeeCalibrationStatus
  confidence?: number
  confirmationMethod?: string
  createdAt: string
  updatedAt: string
  confirmedAt?: string
  lockedAt?: string
}>

export type TeeCalibrationInput = Readonly<{
  courseFingerprint: string
  holeNumber: number
  teeSet: string
  teeLabel?: string
  osmTeeId?: string | number
  courseLocalYds: TeeCalibrationLocalPoint
  gsproWorld?: TeeCalibrationWorldPoint
  expectedYardageYds?: number
  confidence?: number
  confirmationMethod?: string
}>

export type TeeCalibrationWriteResult =
  | Readonly<{ outcome: 'saved'; record: TeeCalibrationRecord }>
  | Readonly<{ outcome: 'unchanged'; record: TeeCalibrationRecord }>
  | Readonly<{
      outcome: 'locked-conflict'
      record: TeeCalibrationRecord
      conflictFields: readonly string[]
    }>
  | Readonly<{ outcome: 'invalid'; reason: string }>

const STORAGE_KEY = 'looper.tee-calibrations.v1'
export const TEE_CALIBRATION_UPDATED_EVENT = 'looper:tee-calibration-updated'

const LOCAL_POINT_TOLERANCE_YDS = 0.25
const WORLD_POINT_TOLERANCE = 0.05

const normalizeWhitespace = (value: string) => value.trim().replace(/\s+/g, ' ')
const normalizeTeeSet = (value: string) => normalizeWhitespace(value).toLowerCase()
const normalizeFingerprint = (value: string) => value.trim()

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const validHole = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 18

const validLocalPoint = (value: unknown): value is TeeCalibrationLocalPoint =>
  Array.isArray(value)
  && value.length === 2
  && finite(value[0])
  && finite(value[1])

const validWorldPoint = (value: unknown): value is TeeCalibrationWorldPoint => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const point = value as Record<string, unknown>
  return finite(point.x) && finite(point.y) && finite(point.z)
}

const clampConfidence = (value: number | undefined) => {
  if (value == null) return undefined
  if (!finite(value)) return undefined
  return Math.max(0, Math.min(1, value))
}

export const teeCalibrationRecordKey = (
  courseFingerprintInput: string,
  holeNumber: number,
  teeSetInput: string,
) => {
  const courseFingerprint = normalizeFingerprint(courseFingerprintInput)
  const teeSet = normalizeTeeSet(teeSetInput)
  if (!courseFingerprint || !validHole(holeNumber) || !teeSet) return null
  return `${encodeURIComponent(courseFingerprint)}::${holeNumber}::${encodeURIComponent(teeSet)}`
}

const normalizedInput = (input: TeeCalibrationInput) => {
  const courseFingerprint = normalizeFingerprint(input.courseFingerprint)
  const teeSet = normalizeTeeSet(input.teeSet)
  const recordKey = teeCalibrationRecordKey(courseFingerprint, input.holeNumber, teeSet)
  if (!recordKey) return { ok: false as const, reason: 'Invalid course fingerprint, hole number, or tee set.' }
  if (!validLocalPoint(input.courseLocalYds)) {
    return { ok: false as const, reason: 'courseLocalYds must contain two finite coordinates.' }
  }
  if (input.gsproWorld != null && !validWorldPoint(input.gsproWorld)) {
    return { ok: false as const, reason: 'gsproWorld must contain finite x/y/z coordinates.' }
  }
  if (input.expectedYardageYds != null && !finite(input.expectedYardageYds)) {
    return { ok: false as const, reason: 'expectedYardageYds must be finite when provided.' }
  }
  if (input.confidence != null && !finite(input.confidence)) {
    return { ok: false as const, reason: 'confidence must be finite when provided.' }
  }

  return {
    ok: true as const,
    value: {
      recordKey,
      courseFingerprint,
      holeNumber: input.holeNumber,
      teeSet,
      ...(normalizeWhitespace(input.teeLabel ?? '') ? { teeLabel: normalizeWhitespace(input.teeLabel ?? '') } : {}),
      ...(input.osmTeeId != null ? { osmTeeId: String(input.osmTeeId) } : {}),
      courseLocalYds: [input.courseLocalYds[0], input.courseLocalYds[1]] as const,
      ...(input.gsproWorld ? { gsproWorld: { ...input.gsproWorld } } : {}),
      ...(input.expectedYardageYds != null ? { expectedYardageYds: input.expectedYardageYds } : {}),
      ...(clampConfidence(input.confidence) != null ? { confidence: clampConfidence(input.confidence) } : {}),
      ...(normalizeWhitespace(input.confirmationMethod ?? '')
        ? { confirmationMethod: normalizeWhitespace(input.confirmationMethod ?? '') }
        : {}),
    },
  }
}

const pointDistance = (left: TeeCalibrationLocalPoint, right: TeeCalibrationLocalPoint) =>
  Math.hypot(left[0] - right[0], left[1] - right[1])

const worldDistance = (left: TeeCalibrationWorldPoint, right: TeeCalibrationWorldPoint) =>
  Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)

const lockedConflictFields = (
  existing: TeeCalibrationRecord,
  incoming: ReturnType<typeof normalizedInput> extends { ok: true; value: infer T } ? T : never,
) => {
  const conflicts: string[] = []
  if (pointDistance(existing.courseLocalYds, incoming.courseLocalYds) > LOCAL_POINT_TOLERANCE_YDS) {
    conflicts.push('courseLocalYds')
  }
  if (existing.osmTeeId && incoming.osmTeeId && existing.osmTeeId !== incoming.osmTeeId) {
    conflicts.push('osmTeeId')
  }
  if (
    existing.gsproWorld
    && incoming.gsproWorld
    && worldDistance(existing.gsproWorld, incoming.gsproWorld) > WORLD_POINT_TOLERANCE
  ) {
    conflicts.push('gsproWorld')
  }
  return conflicts
}

const statusRank: Record<TeeCalibrationStatus, number> = {
  candidate: 0,
  confirmed: 1,
  locked: 2,
}

const maxStatus = (left: TeeCalibrationStatus, right: TeeCalibrationStatus): TeeCalibrationStatus =>
  statusRank[left] >= statusRank[right] ? left : right

const sameRecord = (left: TeeCalibrationRecord, right: TeeCalibrationRecord) =>
  JSON.stringify(left) === JSON.stringify(right)

/**
 * Pure transition used by the browser store and regression tests.
 * Locked coordinates are immutable. A locked record may only be enriched with
 * previously absent metadata/GSPro coordinates; known locked coordinates are
 * never silently replaced.
 */
export const applyTeeCalibrationWrite = (
  existing: TeeCalibrationRecord | null,
  input: TeeCalibrationInput,
  requestedStatus: TeeCalibrationStatus,
  nowIso: string,
): TeeCalibrationWriteResult => {
  const normalized = normalizedInput(input)
  if (!normalized.ok) return { outcome: 'invalid', reason: normalized.reason }
  const incoming = normalized.value

  if (existing && existing.recordKey !== incoming.recordKey) {
    return { outcome: 'invalid', reason: 'Existing calibration key did not match the incoming calibration.' }
  }

  if (existing?.status === 'locked') {
    const conflictFields = lockedConflictFields(existing, incoming)
    if (conflictFields.length) {
      return { outcome: 'locked-conflict', record: existing, conflictFields }
    }

    const enriched: TeeCalibrationRecord = {
      ...existing,
      ...(!existing.teeLabel && incoming.teeLabel ? { teeLabel: incoming.teeLabel } : {}),
      ...(!existing.osmTeeId && incoming.osmTeeId ? { osmTeeId: incoming.osmTeeId } : {}),
      ...(!existing.gsproWorld && incoming.gsproWorld ? { gsproWorld: incoming.gsproWorld } : {}),
      ...(
        existing.expectedYardageYds == null && incoming.expectedYardageYds != null
          ? { expectedYardageYds: incoming.expectedYardageYds }
          : {}
      ),
      ...(
        incoming.confidence != null && (existing.confidence == null || incoming.confidence > existing.confidence)
          ? { confidence: incoming.confidence }
          : {}
      ),
      ...(!existing.confirmationMethod && incoming.confirmationMethod
        ? { confirmationMethod: incoming.confirmationMethod }
        : {}),
      updatedAt: nowIso,
    }
    if (sameRecord(existing, { ...enriched, updatedAt: existing.updatedAt })) {
      return { outcome: 'unchanged', record: existing }
    }
    return { outcome: 'saved', record: enriched }
  }

  const status = existing ? maxStatus(existing.status, requestedStatus) : requestedStatus
  const createdAt = existing?.createdAt ?? nowIso
  const record: TeeCalibrationRecord = {
    schemaVersion: 'looper-tee-calibration-v1',
    recordKey: incoming.recordKey,
    courseFingerprint: incoming.courseFingerprint,
    holeNumber: incoming.holeNumber,
    teeSet: incoming.teeSet,
    ...(incoming.teeLabel ? { teeLabel: incoming.teeLabel } : {}),
    ...(incoming.osmTeeId ? { osmTeeId: incoming.osmTeeId } : {}),
    courseLocalYds: incoming.courseLocalYds,
    ...(incoming.gsproWorld ? { gsproWorld: incoming.gsproWorld } : {}),
    ...(incoming.expectedYardageYds != null ? { expectedYardageYds: incoming.expectedYardageYds } : {}),
    ...(incoming.confidence != null ? { confidence: incoming.confidence } : {}),
    ...(incoming.confirmationMethod ? { confirmationMethod: incoming.confirmationMethod } : {}),
    status,
    createdAt,
    updatedAt: nowIso,
    ...(statusRank[status] >= statusRank.confirmed
      ? { confirmedAt: existing?.confirmedAt ?? nowIso }
      : {}),
    ...(status === 'locked' ? { lockedAt: nowIso } : {}),
  }
  return { outcome: 'saved', record }
}

type StoredCalibrations = Record<string, TeeCalibrationRecord>

const parseStoredCalibrations = (raw: string | null): StoredCalibrations => {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: StoredCalibrations = {}
    for (const [key, rawRecord] of Object.entries(parsed as Record<string, unknown>)) {
      if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) continue
      const record = rawRecord as Record<string, unknown>
      if (
        record.schemaVersion !== 'looper-tee-calibration-v1'
        || record.recordKey !== key
        || typeof record.courseFingerprint !== 'string'
        || !validHole(record.holeNumber)
        || typeof record.teeSet !== 'string'
        || !validLocalPoint(record.courseLocalYds)
        || !['candidate', 'confirmed', 'locked'].includes(String(record.status))
        || typeof record.createdAt !== 'string'
        || typeof record.updatedAt !== 'string'
      ) continue
      if (record.gsproWorld != null && !validWorldPoint(record.gsproWorld)) continue
      result[key] = record as unknown as TeeCalibrationRecord
    }
    return result
  } catch {
    return {}
  }
}

const readAll = (): StoredCalibrations => {
  if (typeof window === 'undefined') return {}
  try {
    return parseStoredCalibrations(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return {}
  }
}

const writeAll = (records: StoredCalibrations) => {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
    return true
  } catch {
    return false
  }
}

const emitUpdated = (record: TeeCalibrationRecord | null) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(TEE_CALIBRATION_UPDATED_EVENT, { detail: { record } }))
}

const persistTransition = (
  input: TeeCalibrationInput,
  requestedStatus: TeeCalibrationStatus,
): TeeCalibrationWriteResult => {
  const key = teeCalibrationRecordKey(input.courseFingerprint, input.holeNumber, input.teeSet)
  if (!key) return { outcome: 'invalid', reason: 'Invalid course fingerprint, hole number, or tee set.' }
  const records = readAll()
  const result = applyTeeCalibrationWrite(records[key] ?? null, input, requestedStatus, new Date().toISOString())
  if (result.outcome !== 'saved') return result
  records[key] = result.record
  if (!writeAll(records)) return { outcome: 'invalid', reason: 'Tee calibration storage was unavailable.' }
  emitUpdated(result.record)
  return result
}

export const saveTeeCalibrationCandidate = (input: TeeCalibrationInput) =>
  persistTransition(input, 'candidate')

export const confirmTeeCalibration = (input: TeeCalibrationInput) =>
  persistTransition(input, 'confirmed')

export const lockTeeCalibration = (input: TeeCalibrationInput) =>
  persistTransition(input, 'locked')

export const loadTeeCalibration = (
  courseFingerprint: string,
  holeNumber: number,
  teeSet: string,
): TeeCalibrationRecord | null => {
  const key = teeCalibrationRecordKey(courseFingerprint, holeNumber, teeSet)
  return key ? readAll()[key] ?? null : null
}

export const listTeeCalibrations = (courseFingerprint?: string) => {
  const records = Object.values(readAll())
  const fingerprint = courseFingerprint == null ? null : normalizeFingerprint(courseFingerprint)
  return records
    .filter((record) => fingerprint == null || record.courseFingerprint === fingerprint)
    .sort((left, right) => left.holeNumber - right.holeNumber || left.teeSet.localeCompare(right.teeSet))
}

/** Explicit invalidation only. Locked records are never removed automatically. */
export const invalidateTeeCalibration = (
  courseFingerprint: string,
  holeNumber: number,
  teeSet: string,
) => {
  const key = teeCalibrationRecordKey(courseFingerprint, holeNumber, teeSet)
  if (!key) return false
  const records = readAll()
  if (!(key in records)) return false
  delete records[key]
  if (!writeAll(records)) return false
  emitUpdated(null)
  return true
}
