import type { ActiveLiveCaddieRound } from '../liveCaddie/roundRuntime'
import type { CoursePointYds } from './types'

// A per-round playing HYPOTHESIS, not a GSPro/world registration or a locked
// tee cache. Preserves a measured native tee anchor across the first real shot.
const KEY = 'looper.live-tee-session-anchor.v1'
const MAX_AGE_MS = 3 * 60 * 60 * 1000

export type LiveTeeSessionAnchor = Readonly<{
  roundId: string
  courseId: string
  holeNumber: number
  normalizedTeeSet: string
  point: CoursePointYds
  measuredStraightToPinYds: number
  uncertaintyRadiusYds: number
  source: 'native-distance-matched-osm-tee' | 'native-distance-route-estimate'
  observedAt: string
}>

const validPoint = (point: unknown): point is CoursePointYds =>
  Array.isArray(point) && point.length === 2
  && point.every(v => typeof v === 'number' && Number.isFinite(v))

const valid = (record: Partial<LiveTeeSessionAnchor>): record is LiveTeeSessionAnchor =>
  typeof record.roundId === 'string' && record.roundId.length > 0
  && typeof record.courseId === 'string' && record.courseId.length > 0
  && Number.isInteger(record.holeNumber) && (record.holeNumber ?? 0) >= 1
  && (record.holeNumber ?? 19) <= 18
  && typeof record.normalizedTeeSet === 'string' && record.normalizedTeeSet.length > 0
  && validPoint(record.point)
  && typeof record.measuredStraightToPinYds === 'number'
  && Number.isFinite(record.measuredStraightToPinYds)
  && record.measuredStraightToPinYds > 45 && record.measuredStraightToPinYds < 750
  && typeof record.uncertaintyRadiusYds === 'number'
  && Number.isFinite(record.uncertaintyRadiusYds)
  && record.uncertaintyRadiusYds >= 15
  && (record.source === 'native-distance-matched-osm-tee'
    || record.source === 'native-distance-route-estimate')
  && typeof record.observedAt === 'string'
  && Number.isFinite(Date.parse(record.observedAt))

const readAll = (): Record<string, LiveTeeSessionAnchor> => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(KEY)
    const value = raw ? JSON.parse(raw) as unknown : null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, x]) =>
      x && typeof x === 'object' && valid(x as Partial<LiveTeeSessionAnchor>)
    )) as Record<string, LiveTeeSessionAnchor>
  } catch { return {} }
}

const idFor = (round: ActiveLiveCaddieRound, holeNumber: number) =>
  round.id + '::' + holeNumber

export const saveLiveTeeSessionAnchor = (
  round: ActiveLiveCaddieRound,
  input: Omit<LiveTeeSessionAnchor, 'roundId' | 'courseId' | 'normalizedTeeSet' | 'observedAt'>,
): LiveTeeSessionAnchor | null => {
  if (typeof window === 'undefined' || !round || round.phase !== 'armed') return null
  const record: LiveTeeSessionAnchor = {
    ...input, roundId: round.id, courseId: round.courseId,
    normalizedTeeSet: round.normalizedTeeSet,
    observedAt: new Date().toISOString(),
  }
  if (!valid(record)) return null
  const saved = readAll()
  saved[idFor(round, input.holeNumber)] = record
  try { window.localStorage.setItem(KEY, JSON.stringify(saved)) } catch { return null }
  return record
}

export const loadLiveTeeSessionAnchor = (
  round: ActiveLiveCaddieRound | null,
  holeNumber: number,
  nowMs = Date.now(),
): LiveTeeSessionAnchor | null => {
  if (!round) return null
  const record = readAll()[idFor(round, holeNumber)]
  if (!record || record.courseId !== round.courseId
    || record.normalizedTeeSet !== round.normalizedTeeSet
    || !Number.isFinite(Date.parse(round.startedAt))
    || Date.parse(record.observedAt) < Date.parse(round.startedAt)
    || nowMs - Date.parse(record.observedAt) > MAX_AGE_MS
    || nowMs < Date.parse(record.observedAt) - 30_000) return null
  return record
}
