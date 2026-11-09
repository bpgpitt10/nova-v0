import type { GsproPinDay } from '../courseGeometry/nativeGkd'
import type { CourseId } from '../courseGeometry/courseCatalog'
import { loadLastSelectedCourseId } from '../courseGeometry/courseSelection'
import { loadRoundTeeSelection } from '../courseGeometry/roundTeeSelection'

export const LIVE_CADDIE_START_ROUND_EVENT = 'looper:live-caddie-start-round'
export const LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT = 'looper:live-caddie-shot-state-changed'
export const LIVE_CADDIE_ACTIVE_ROUND_UPDATED_EVENT = 'looper:live-caddie-active-round-updated'

const ACTIVE_ROUND_STORAGE_KEY = 'looper.live-caddie.active-round.v1'

export type ActiveLiveCaddieRound = Readonly<{
  schemaVersion: 'looper-live-caddie-round-v1'
  id: string
  courseId: CourseId
  teeSet: string
  normalizedTeeSet: string
  /** The pin day picked in GSPro's round setup (Thursday..Sunday); null when not told. */
  pinDay?: GsproPinDay | null
  startedAt: string
  phase: 'armed' | 'live'
  startHoleNumber: 1
  startShotNumber: 1
  assumedTeeLocalYds: readonly [number, number] | null
  teeEvidence: 'assumed' | 'first-shot-observed'
  firstPhysicalShotKey?: string
  firstPhysicalShotObservedAt?: string
}>

export type LiveCaddieStartRoundDetail = {
  startedAt: string
  round: ActiveLiveCaddieRound
}

export type LiveCaddieShotStateChangedDetail = {
  key: string
  courseKey?: string | null
  roundId?: number | null
  holeNumber: number | null
  nextShotNumber: number | null
  surface?: string | null
  surfaceSource?: string | null
  distanceToPinYds?: number | null
  ballLocalYds?: readonly [number, number] | null
  latestShotKey?: string | null
  source: 'manual-start' | 'gspro'
}

const normalizeTeeSet = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()

const emitActiveRoundUpdated = (round: ActiveLiveCaddieRound | null) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(LIVE_CADDIE_ACTIVE_ROUND_UPDATED_EVENT, {
    detail: { round },
  }))
}

const writeActiveRound = (round: ActiveLiveCaddieRound | null) => {
  if (typeof window === 'undefined') return
  try {
    if (round) window.localStorage.setItem(ACTIVE_ROUND_STORAGE_KEY, JSON.stringify(round))
    else window.localStorage.removeItem(ACTIVE_ROUND_STORAGE_KEY)
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
  emitActiveRoundUpdated(round)
}

export const loadActiveLiveCaddieRound = (): ActiveLiveCaddieRound | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(ACTIVE_ROUND_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ActiveLiveCaddieRound>
    if (
      parsed.schemaVersion !== 'looper-live-caddie-round-v1'
      || typeof parsed.id !== 'string'
      || typeof parsed.courseId !== 'string'
      || typeof parsed.teeSet !== 'string'
      || typeof parsed.normalizedTeeSet !== 'string'
      || typeof parsed.startedAt !== 'string'
      || (parsed.phase !== 'armed' && parsed.phase !== 'live')
      || parsed.startHoleNumber !== 1
      || parsed.startShotNumber !== 1
      || (parsed.teeEvidence !== 'assumed' && parsed.teeEvidence !== 'first-shot-observed')
    ) return null
    const point = parsed.assumedTeeLocalYds
    const validPoint = point == null || (
      Array.isArray(point)
      && point.length === 2
      && Number.isFinite(point[0])
      && Number.isFinite(point[1])
    )
    if (!validPoint) return null
    return parsed as ActiveLiveCaddieRound
  } catch {
    return null
  }
}

export const clearActiveLiveCaddieRound = () => writeActiveRound(null)

const newRoundId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `round-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export const startLiveCaddieRound = (input?: {
  courseId?: CourseId
  teeSet?: string
  pinDay?: GsproPinDay | null
  assumedTeeLocalYds?: readonly [number, number] | null
}) => {
  if (typeof window === 'undefined') return null

  const existing = loadActiveLiveCaddieRound()
  let round: ActiveLiveCaddieRound | null = existing?.phase === 'armed' ? existing : null

  if (input?.courseId || input?.teeSet) {
    const courseId = input.courseId ?? loadLastSelectedCourseId()
    const storedSelection = loadRoundTeeSelection(courseId)
    const teeSet = input.teeSet?.trim() || storedSelection?.teeSet || ''
    if (!teeSet) return null
    const startedAt = new Date().toISOString()
    round = {
      schemaVersion: 'looper-live-caddie-round-v1',
      id: newRoundId(),
      courseId,
      teeSet,
      normalizedTeeSet: normalizeTeeSet(teeSet),
      pinDay: input.pinDay ?? null,
      startedAt,
      phase: 'armed',
      startHoleNumber: 1,
      startShotNumber: 1,
      assumedTeeLocalYds: input.assumedTeeLocalYds
        ? [input.assumedTeeLocalYds[0], input.assumedTeeLocalYds[1]]
        : null,
      teeEvidence: 'assumed',
    }
    writeActiveRound(round)
  }

  if (!round) {
    const courseId = loadLastSelectedCourseId()
    const selection = loadRoundTeeSelection(courseId)
    if (!selection) return null
    const startedAt = new Date().toISOString()
    round = {
      schemaVersion: 'looper-live-caddie-round-v1',
      id: newRoundId(),
      courseId,
      teeSet: selection.teeSet,
      normalizedTeeSet: selection.normalizedTeeSet,
      startedAt,
      phase: 'armed',
      startHoleNumber: 1,
      startShotNumber: 1,
      assumedTeeLocalYds: null,
      teeEvidence: 'assumed',
    }
    writeActiveRound(round)
  }

  window.dispatchEvent(new CustomEvent<LiveCaddieStartRoundDetail>(LIVE_CADDIE_START_ROUND_EVENT, {
    detail: { startedAt: round.startedAt, round },
  }))
  return round
}

const markFirstPhysicalShotObserved = (detail: LiveCaddieShotStateChangedDetail) => {
  if (detail.source !== 'gspro' || !detail.latestShotKey) return
  const round = loadActiveLiveCaddieRound()
  if (!round || round.phase !== 'armed') return
  writeActiveRound({
    ...round,
    phase: 'live',
    teeEvidence: 'first-shot-observed',
    firstPhysicalShotKey: detail.latestShotKey,
    firstPhysicalShotObservedAt: new Date().toISOString(),
  })
}

/**
 * GSPro moved past the first hole before any shot (a conceded hole, 11/4
 * Pebble 1): the round is under way, so a page reload must not pin it back
 * to hole 1's tee.
 */
export const markActiveRoundLiveFromHoleChange = () => {
  const round = loadActiveLiveCaddieRound()
  if (!round || round.phase !== 'armed') return
  writeActiveRound({ ...round, phase: 'live' })
}

export const dispatchLiveCaddieShotStateChanged = (
  detail: LiveCaddieShotStateChangedDetail,
) => {
  if (typeof window === 'undefined') return
  markFirstPhysicalShotObserved(detail)
  window.dispatchEvent(new CustomEvent<LiveCaddieShotStateChangedDetail>(
    LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT,
    { detail },
  ))
}
