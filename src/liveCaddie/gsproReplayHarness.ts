export type GsproReplayConnection = 'connected' | 'disconnected' | 'reconnected'

export type GsproReplaySource = {
  text: string | null
  modifiedAtMs: number | null
  sizeBytes?: number | null
}

export type GsproReplayExpectation = {
  roundHole?: number | null
  logHole?: number | null
  effectiveHole?: number | null
  latestShotId?: string | null
  integrity?: 'healthy' | 'degraded' | 'stale'
  epoch?: number
  recoveredMissedShot?: boolean
  duplicateSuppressed?: boolean
  roundState?: 'available' | 'missing' | 'invalid'
}

export type GsproReplayFrame = {
  id: string
  label: string
  atMs: number
  connection?: GsproReplayConnection
  currentRound: GsproReplaySource
  outputLog: GsproReplaySource
  expect?: GsproReplayExpectation
}

export type GsproReplayFixture = {
  schemaVersion: 1
  name: string
  description?: string
  courseHint?: string
  frames: GsproReplayFrame[]
}

export type GsproReplayFrameResult = {
  id: string
  label: string
  pass: boolean
  failures: string[]
  connection: GsproReplayConnection
  roundState: 'available' | 'missing' | 'invalid'
  logState: 'available' | 'missing' | 'invalid'
  roundId: number | null
  courseKey: string | null
  roundHole: number | null
  logHole: number | null
  effectiveHole: number | null
  latestShotId: string | null
  epoch: number
  epochReason: string
  integrity: 'healthy' | 'degraded' | 'stale'
  logFallbackActive: boolean
  logFallbackExpired: boolean
  quarantined: boolean
  recoveredMissedShot: boolean
  duplicateSuppressed: boolean
}

export type GsproReplayRun = {
  fixtureName: string
  pass: boolean
  passedFrames: number
  totalFrames: number
  results: GsproReplayFrameResult[]
}

type RoundRecord = {
  ShotID?: unknown
  RoundID?: unknown
  Hole?: unknown
  HoleShot?: unknown
  GlobalShotNumber?: unknown
  CourseKey?: unknown
}

type RoundIdentity = {
  roundId: number | null
  courseKey: string | null
  holeNumber: number | null
  latestShotId: string | null
}

type Watermark = {
  key: string
  roundSignature: string | null
}

const OUTPUT_LOG_FALLBACK_GRACE_MS = 5_000

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const parseRoundCandidates = (text: string): RoundRecord[] => {
  const parsed = JSON.parse(text) as unknown
  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>).flatMap((value) => Array.isArray(value) ? value : [])
      : []

  return candidates.flatMap((candidate): RoundRecord[] =>
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? [candidate as RoundRecord]
      : [],
  )
}

const recordSortValue = (record: RoundRecord) =>
  asNumber(record.GlobalShotNumber) ?? asNumber(record.HoleShot) ?? 0

export const parseReplayRoundIdentity = (text: string): RoundIdentity | null => {
  const records = parseRoundCandidates(text)
    .filter((record) => asString(record.ShotID) != null)
    .sort((left, right) => recordSortValue(left) - recordSortValue(right))

  const latest = records[records.length - 1]
  if (!latest) return null

  const rawHole = asNumber(latest.Hole)
  const holeNumber = rawHole == null ? null : Math.round(rawHole) + 1
  return {
    roundId: asNumber(latest.RoundID),
    courseKey: asString(latest.CourseKey),
    holeNumber: holeNumber != null && holeNumber >= 1 && holeNumber <= 18 ? holeNumber : null,
    latestShotId: asString(latest.ShotID),
  }
}

export const parseReplayOutputLogHole = (text: string) => {
  const matches = [...text.matchAll(/currentHole\s*:\s*(-?\d+)/gi)]
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const raw = Number(matches[index][1])
    if (Number.isFinite(raw) && raw >= 0 && raw < 18) return raw + 1
  }
  return null
}

const sourceSize = (source: GsproReplaySource) => {
  if (source.text == null) return null
  return source.sizeBytes ?? new TextEncoder().encode(source.text).byteLength
}

const sourceSignature = (source: GsproReplaySource) => {
  const size = sourceSize(source)
  return source.text == null || source.modifiedAtMs == null || size == null
    ? null
    : `${size}:${source.modifiedAtMs}`
}

const assertExpectation = (
  expectation: GsproReplayExpectation | undefined,
  result: Omit<GsproReplayFrameResult, 'pass' | 'failures'>,
) => {
  if (!expectation) return []
  const failures: string[] = []
  const check = <K extends keyof GsproReplayExpectation>(key: K, actual: GsproReplayExpectation[K]) => {
    if (expectation[key] !== undefined && expectation[key] !== actual) {
      failures.push(`${String(key)} expected ${String(expectation[key])}, got ${String(actual)}`)
    }
  }
  check('roundHole', result.roundHole)
  check('logHole', result.logHole)
  check('effectiveHole', result.effectiveHole)
  check('latestShotId', result.latestShotId)
  check('integrity', result.integrity)
  check('epoch', result.epoch)
  check('recoveredMissedShot', result.recoveredMissedShot)
  check('duplicateSuppressed', result.duplicateSuppressed)
  check('roundState', result.roundState)
  return failures
}

export const runGsproReplayFixture = (fixture: GsproReplayFixture): GsproReplayRun => {
  let epoch = 1
  let epochReason = 'fixture-start'
  let previousRoundIdentityKey: string | null = null
  let previousLogSize: number | null = null
  let previousLogModified: number | null = null
  let lastLogSeenAt: number | null = null
  let restartBoundaryAt: number | null = null
  let watermark: Watermark | null = null
  let connected = true

  const results: GsproReplayFrameResult[] = []

  for (const frame of fixture.frames) {
    const connection = frame.connection ?? (connected ? 'connected' : 'disconnected')
    if (connection === 'disconnected') connected = false
    if (connection === 'connected' || connection === 'reconnected') connected = true

    const logSize = sourceSize(frame.outputLog)
    const roundSignature = sourceSignature(frame.currentRound)

    let roundState: GsproReplayFrameResult['roundState'] = frame.currentRound.text == null ? 'missing' : 'available'
    let logState: GsproReplayFrameResult['logState'] = frame.outputLog.text == null ? 'missing' : 'available'
    let identity: RoundIdentity | null = null
    let logHole: number | null = null

    if (frame.currentRound.text != null) {
      try {
        identity = parseReplayRoundIdentity(frame.currentRound.text)
      } catch {
        roundState = 'invalid'
      }
    }

    if (frame.outputLog.text != null) {
      try {
        logHole = parseReplayOutputLogHole(frame.outputLog.text)
      } catch {
        logState = 'invalid'
      }
    }

    const identityKey = identity
      ? `${identity.roundId ?? 'round'}:${identity.courseKey ?? 'course'}`
      : null
    if (
      previousRoundIdentityKey != null
      && identityKey != null
      && identityKey !== previousRoundIdentityKey
    ) {
      epoch += 1
      epochReason = 'current-round-identity-change'
      restartBoundaryAt = null
    }
    previousRoundIdentityKey = identityKey ?? previousRoundIdentityKey

    if (frame.outputLog.text != null && frame.outputLog.modifiedAtMs != null && logSize != null) {
      const logReset =
        previousLogSize != null
        && previousLogModified != null
        && (logSize < previousLogSize || frame.outputLog.modifiedAtMs < previousLogModified)
      const logRecreatedAfterGap =
        lastLogSeenAt != null
        && frame.atMs - lastLogSeenAt > OUTPUT_LOG_FALLBACK_GRACE_MS
        && previousLogModified != null
        && frame.outputLog.modifiedAtMs > previousLogModified

      if (logReset || logRecreatedAfterGap) {
        epoch += 1
        epochReason = logReset ? 'output-log-reset' : 'output-log-recreated'
        restartBoundaryAt = frame.atMs
      }
      previousLogSize = logSize
      previousLogModified = frame.outputLog.modifiedAtMs
      lastLogSeenAt = frame.atMs
    }

    const logMissingForMs = frame.outputLog.text != null
      ? 0
      : lastLogSeenAt == null
        ? Number.POSITIVE_INFINITY
        : frame.atMs - lastLogSeenAt
    const logFallbackActive = frame.outputLog.text == null && logMissingForMs <= OUTPUT_LOG_FALLBACK_GRACE_MS
    const logFallbackExpired = frame.outputLog.text == null && !logFallbackActive

    const preRestartRound =
      restartBoundaryAt != null
      && frame.currentRound.modifiedAtMs != null
      && frame.currentRound.modifiedAtMs < restartBoundaryAt
      && logHole == null
    const quarantined = preRestartRound

    const integrity: GsproReplayFrameResult['integrity'] =
      roundState !== 'available' || preRestartRound
        ? 'stale'
        : logFallbackExpired || logState === 'invalid'
          ? 'degraded'
          : 'healthy'

    const effectiveHole = quarantined
      ? null
      : logFallbackExpired
        ? identity?.holeNumber ?? null
        : logHole ?? identity?.holeNumber ?? null

    const latestShotId = identity?.latestShotId ?? null
    const duplicateSuppressed =
      connected
      && latestShotId != null
      && watermark?.key === latestShotId
      && watermark.roundSignature === roundSignature

    const recoveredMissedShot =
      connection === 'reconnected'
      && latestShotId != null
      && watermark?.key != null
      && latestShotId !== watermark.key
      && roundSignature != null
      && roundSignature !== watermark.roundSignature
      && roundState === 'available'
      && integrity !== 'stale'

    const baseResult = {
      id: frame.id,
      label: frame.label,
      connection,
      roundState,
      logState,
      roundId: identity?.roundId ?? null,
      courseKey: identity?.courseKey ?? null,
      roundHole: identity?.holeNumber ?? null,
      logHole,
      effectiveHole,
      latestShotId,
      epoch,
      epochReason,
      integrity,
      logFallbackActive,
      logFallbackExpired,
      quarantined,
      recoveredMissedShot,
      duplicateSuppressed,
    }

    const failures = assertExpectation(frame.expect, baseResult)
    results.push({ ...baseResult, pass: failures.length === 0, failures })

    if (connected && latestShotId != null && !quarantined) {
      watermark = { key: latestShotId, roundSignature }
    }
  }

  const passedFrames = results.filter((result) => result.pass).length
  return {
    fixtureName: fixture.name,
    pass: passedFrames === results.length,
    passedFrames,
    totalFrames: results.length,
    results,
  }
}

export const parseGsproReplayFixture = (raw: string): GsproReplayFixture => {
  const parsed = JSON.parse(raw) as Partial<GsproReplayFixture>
  if (parsed.schemaVersion !== 1) throw new Error('Replay fixture must use schemaVersion 1.')
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) throw new Error('Replay fixture needs a name.')
  if (!Array.isArray(parsed.frames) || parsed.frames.length === 0) throw new Error('Replay fixture needs at least one frame.')
  return parsed as GsproReplayFixture
}
