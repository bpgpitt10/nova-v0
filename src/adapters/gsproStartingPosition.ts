export type GsproStartingWorldPoint = {
  x: number
  y: number
  z: number
}

export type GsproStartingPositionObservation = {
  world: GsproStartingWorldPoint
  holeNumber: number | null
  shotNumber: number | null
  shotId: string | null
  roundId: number | null
  courseKey: string | null
  distanceToPinYds: number | null
  surface: string | null
  surfaceRaw: number | null
  recordKey: string
}

type Vec3 = {
  x?: unknown
  y?: unknown
  z?: unknown
}

type CandidateRecord = {
  ShotID?: unknown
  RoundID?: unknown
  Hole?: unknown
  HoleShot?: unknown
  GlobalShotNumber?: unknown
  CourseKey?: unknown
  StartingPOS?: Vec3
  StartingSurface?: unknown
  DistanceToPin?: unknown
}

type Candidate = {
  record: CandidateRecord
  currentShot: boolean
  order: number
}

const METERS_TO_YARDS = 1.0936132983377078

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

const worldPoint = (value: unknown): GsproStartingWorldPoint | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Vec3
  const x = asNumber(candidate.x)
  const y = asNumber(candidate.y)
  const z = asNumber(candidate.z)
  return x == null || y == null || z == null ? null : { x, y, z }
}

const surfaceFromRaw = (value: number | null) => {
  switch (value) {
    case 1: return 'rough'
    case 2: return 'fairway'
    case 3: return 'sand'
    // Live testing showed raw surface 11 can also represent woods/scrub/deep rough.
    // Keep it ambiguous so course geometry can resolve the actual playable surface.
    case 11: return null
    case 5: return 'green'
    case 18: return 'tee'
    default: return null
  }
}

const asRecord = (value: unknown): CandidateRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as CandidateRecord
    : null

const parseCandidates = (text: string): Candidate[] => {
  const parsed = JSON.parse(text) as unknown
  if (Array.isArray(parsed)) {
    return parsed.flatMap((value, order) => {
      const record = asRecord(value)
      return record ? [{ record, currentShot: false, order }] : []
    })
  }
  if (!parsed || typeof parsed !== 'object') return []

  const root = parsed as Record<string, unknown>
  const ordered: Candidate[] = []
  const currentShot = asRecord(root.CurrentShot ?? root.currentShot)
  if (currentShot) ordered.push({ record: currentShot, currentShot: true, order: -1 })

  let order = 0
  for (const value of Object.values(root)) {
    if (!Array.isArray(value)) continue
    for (const item of value) {
      const record = asRecord(item)
      if (record) ordered.push({ record, currentShot: false, order })
      order += 1
    }
  }
  return ordered
}

const holeNumberFor = (record: CandidateRecord) => {
  const raw = asNumber(record.Hole)
  if (raw == null) return null
  const holeNumber = Math.round(raw) + 1
  return holeNumber >= 1 && holeNumber <= 18 ? holeNumber : null
}

const sortValue = (record: CandidateRecord) =>
  asNumber(record.GlobalShotNumber) ?? asNumber(record.HoleShot) ?? -1

export const parseGsproStartingPosition = (
  text: string,
  expectedHoleNumber: number | null = null,
): GsproStartingPositionObservation | null => {
  const candidates = parseCandidates(text)
    .map((candidate) => ({ ...candidate, world: worldPoint(candidate.record.StartingPOS) }))
    .filter((item): item is Candidate & { world: GsproStartingWorldPoint } => item.world != null)
    .filter((item) => (
      item.currentShot
      || expectedHoleNumber == null
      || holeNumberFor(item.record) === expectedHoleNumber
    ))

  if (candidates.length === 0) return null

  candidates.sort((left, right) => {
    if (left.currentShot !== right.currentShot) return left.currentShot ? -1 : 1
    const byShot = sortValue(right.record) - sortValue(left.record)
    return byShot !== 0 ? byShot : left.order - right.order
  })

  const selected = candidates[0]
  const holeNumber = holeNumberFor(selected.record)
  const shotNumber = asNumber(selected.record.HoleShot)
  const shotId = asString(selected.record.ShotID)
  const roundId = asNumber(selected.record.RoundID)
  const courseKey = asString(selected.record.CourseKey)
  const distanceToPin = asNumber(selected.record.DistanceToPin)
  const surfaceRaw = asNumber(selected.record.StartingSurface)
  const { x, y, z } = selected.world

  return {
    world: selected.world,
    holeNumber,
    shotNumber,
    shotId,
    roundId,
    courseKey,
    distanceToPinYds: distanceToPin == null ? null : distanceToPin * METERS_TO_YARDS,
    surface: surfaceFromRaw(surfaceRaw),
    surfaceRaw,
    recordKey: [
      roundId ?? 'round',
      holeNumber ?? 'hole',
      shotNumber ?? 'shot',
      shotId ?? 'unassigned',
      x.toFixed(4),
      y.toFixed(4),
      z.toFixed(4),
    ].join(':'),
  }
}
