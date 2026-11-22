import type { Club } from './bagConfig'
import type { SavedSession, Shot } from '../types'

/**
 * Range swings Looper saw in GSPro with no club tagged (they sit in
 * live_course_shots under the range's round id and never reach the bag).
 * This sorts one range visit into runs of like swings so the player can name
 * the club once per run instead of once per ball (Brian, 22 Nov).
 *
 * The guess per swing comes from the player's existing carries, so it is only a
 * starting label: nothing reaches the bag until the player confirms the run.
 */

export type RangeSwing = Readonly<{
  /** GSPro's shot id. */
  id: string
  /** Epoch ms. */
  at: number
  /** GSPro's count of balls hit on the range: the order when several swings share a time (a backlog saved at once). */
  seq: number
  ballSpeedMph: number
  launchDeg: number | null
  startDirectionDeg: number | null
  spinRpm: number | null
  spinAxisDeg: number | null
  backSpinRpm: number | null
  sideSpinRpm: number | null
  carryYds: number
  totalYds: number | null
  /** Right of the range's centre line is positive; null when the range's direction isn't known. */
  offlineYds: number | null
  guess: Club | null
  guessConfidence: number | null
}>

export type RangeRun = Readonly<{
  key: string
  swings: readonly RangeSwing[]
  /** Swings well off the run's pattern (thin, fat, half swings): left out unless ticked. */
  outlierIds: ReadonlySet<string>
  guess: Club | null
  carryYds: number
  carryLowYds: number
  carryHighYds: number
  ballSpeedMph: number
  launchDeg: number | null
}>

export type RangeVisit = Readonly<{
  key: string
  startedAt: number
  endedAt: number
  swings: readonly RangeSwing[]
  runs: readonly RangeRun[]
}>

export const VISIT_GAP_MS = 45 * 60_000
const SPEED_TOLERANCE_SHARE = 0.07
const SPEED_TOLERANCE_MIN_MPH = 5
const LAUNCH_TOLERANCE_DEG = 5
const OUTLIER_CARRY_SHARE = 0.15
const BRIDGE_MAX_SWINGS = 2
/** A pause this long between balls usually means a club change (about 30 s is normal between balls). */
const CLUB_CHANGE_PAUSE_MS = 70_000
/** Runs this short are left out unless the player ticks them: too few swings to tell a club. */
export const SHORT_RUN_SWINGS = 2

export const RANGE_SORT_SHOT_PREFIX = 'range-'
export const RANGE_SORT_SESSION_PREFIX = 'range-sort-'

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const medianOrNull = (values: readonly (number | null)[]) => {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v))
  return present.length ? median(present) : null
}

const alike = (
  speed: number, launch: number | null, other: Readonly<{ speed: number; launch: number | null }>,
) => {
  const tolerance = Math.max(SPEED_TOLERANCE_MIN_MPH, other.speed * SPEED_TOLERANCE_SHARE)
  if (Math.abs(speed - other.speed) > tolerance) return false
  return launch == null || other.launch == null || Math.abs(launch - other.launch) <= LAUNCH_TOLERANCE_DEG
}

const centre = (swings: readonly RangeSwing[]) => ({
  speed: median(swings.map((s) => s.ballSpeedMph)),
  launch: medianOrNull(swings.map((s) => s.launchDeg)),
})

const voteGuess = (swings: readonly RangeSwing[]): Club | null => {
  const votes = new Map<Club, number>()
  swings.forEach((s) => {
    if (s.guess) votes.set(s.guess, (votes.get(s.guess) ?? 0) + (s.guessConfidence ?? 0.3))
  })
  let best: Club | null = null
  let bestVotes = 0
  votes.forEach((count, club) => {
    if (count > bestVotes) { best = club; bestVotes = count }
  })
  return best
}

const buildRun = (swings: readonly RangeSwing[], forcedOutliers: ReadonlySet<string>): RangeRun => {
  const solid = swings.filter((s) => !forcedOutliers.has(s.id))
  const carry = median(solid.map((s) => s.carryYds))
  const outlierIds = new Set(forcedOutliers)
  if (solid.length >= 3) {
    solid.forEach((s) => {
      if (Math.abs(s.carryYds - carry) > carry * OUTLIER_CARRY_SHARE) outlierIds.add(s.id)
    })
  }
  const kept = swings.filter((s) => !outlierIds.has(s.id))
  const carries = kept.map((s) => s.carryYds)
  return {
    key: swings[0].id,
    swings,
    outlierIds,
    guess: voteGuess(kept),
    carryYds: median(carries),
    carryLowYds: Math.min(...carries),
    carryHighYds: Math.max(...carries),
    ballSpeedMph: median(kept.map((s) => s.ballSpeedMph)),
    launchDeg: medianOrNull(kept.map((s) => s.launchDeg)),
  }
}

/** Splits a visit, in the order hit, into runs of like swings. */
export const splitRuns = (ordered: readonly RangeSwing[]): RangeRun[] => {
  const groups: RangeSwing[][] = []
  ordered.forEach((swing) => {
    const current = groups[groups.length - 1]
    const paused = current != null && swing.at - current[current.length - 1].at >= CLUB_CHANGE_PAUSE_MS
    if (current && !paused && alike(swing.ballSpeedMph, swing.launchDeg, centre(current))) current.push(swing)
    else groups.push([swing])
  })
  // A thin or fat one in the middle of a run splits it in three: put it back as an outlier.
  const merged: { swings: RangeSwing[]; outliers: Set<string> }[] = []
  for (let i = 0; i < groups.length; i += 1) {
    const previous = merged[merged.length - 1]
    const next = groups[i + 1]
    const bridge = groups[i]
    const noPause = previous && next
      && bridge[0].at - previous.swings[previous.swings.length - 1].at < CLUB_CHANGE_PAUSE_MS
      && next[0].at - bridge[bridge.length - 1].at < CLUB_CHANGE_PAUSE_MS
    if (previous && next && noPause && bridge.length <= BRIDGE_MAX_SWINGS) {
      const nextCentre = centre(next)
      if (alike(nextCentre.speed, nextCentre.launch, centre(previous.swings.filter((s) => !previous.outliers.has(s.id))))) {
        bridge.forEach((s) => previous.outliers.add(s.id))
        previous.swings.push(...bridge, ...next)
        i += 1
        continue
      }
    }
    merged.push({ swings: [...bridge], outliers: new Set() })
  }
  return merged.map((group) => buildRun(group.swings, group.outliers))
}

/** Groups swings into range visits (a gap of 45 minutes starts a new one), newest visit first. */
export const groupVisits = (swings: readonly RangeSwing[]): RangeVisit[] => {
  const ordered = [...swings].sort((a, b) => a.at - b.at || a.seq - b.seq)
  const visits: RangeSwing[][] = []
  ordered.forEach((swing) => {
    const current = visits[visits.length - 1]
    if (current && swing.at - current[current.length - 1].at <= VISIT_GAP_MS) current.push(swing)
    else visits.push([swing])
  })
  return visits.map((visit) => ({
    key: new Date(visit[0].at).toISOString(),
    startedAt: visit[0].at,
    endedAt: visit[visit.length - 1].at,
    swings: visit,
    runs: splitRuns(visit),
  })).reverse()
}

/** A capture-tool shot of the same swing: same moment, same ball speed. */
const SAME_SWING_MS = 30_000
const SAME_SWING_MPH = 1.5

/** Leaves out swings already in the bag: sorted before, or captured by a range session at the time. */
export const unsortedSwings = (
  swings: readonly RangeSwing[],
  sessions: readonly SavedSession[],
  dismissedIds: ReadonlySet<string>,
): RangeSwing[] => {
  const sortedIds = new Set<string>()
  const captured: { at: number; mph: number }[] = []
  sessions.forEach((session) => session.shots.forEach((shot) => {
    if (shot.id.startsWith(RANGE_SORT_SHOT_PREFIX)) {
      sortedIds.add(shot.id.slice(RANGE_SORT_SHOT_PREFIX.length))
      return
    }
    const at = Date.parse(shot.capturedAt)
    if (Number.isFinite(at) && typeof shot.ballSpeedMph === 'number') captured.push({ at, mph: shot.ballSpeedMph })
  }))
  return swings.filter((swing) =>
    !sortedIds.has(swing.id)
    && !dismissedIds.has(swing.id)
    && !captured.some((c) => Math.abs(c.at - swing.at) <= SAME_SWING_MS && Math.abs(c.mph - swing.ballSpeedMph) <= SAME_SWING_MPH))
}

export type RunChoice = Readonly<{
  /** null: this run is left out. */
  club: Club | null
  /** The swings of the run that go in the bag. */
  keepIds: ReadonlySet<string>
}>

const MPH_TO_MPS = 0.44704

const toShot = (swing: RangeSwing, club: Club): Shot => ({
  id: `${RANGE_SORT_SHOT_PREFIX}${swing.id}`,
  club,
  included: true,
  capturedAt: new Date(swing.at).toISOString(),
  enrichmentStatus: 'raw_only',
  ballSpeedMph: swing.ballSpeedMph,
  ballSpeedMetersPerSecond: swing.ballSpeedMph * MPH_TO_MPS,
  verticalLaunchAngleDegrees: swing.launchDeg ?? undefined,
  launchAngleDeg: swing.launchDeg ?? undefined,
  horizontalLaunchAngleDegrees: swing.startDirectionDeg ?? undefined,
  totalSpinRpm: swing.spinRpm ?? undefined,
  spinRpm: swing.spinRpm ?? undefined,
  spinAxisDegrees: swing.spinAxisDeg ?? undefined,
  backSpin: swing.backSpinRpm ?? undefined,
  sideSpin: swing.sideSpinRpm ?? undefined,
  carryYards: swing.carryYds,
  totalYards: swing.totalYds ?? undefined,
  offlineYards: swing.offlineYds ?? undefined,
  source: 'simread',
})

/** The range session a sorted visit saves: only the swings the player kept, under the clubs they named. */
export const sessionFromVisit = (
  visit: RangeVisit,
  choices: ReadonlyMap<string, RunChoice>,
): SavedSession | null => {
  const shots: Shot[] = []
  visit.runs.forEach((run) => {
    const choice = choices.get(run.key)
    if (!choice?.club) return
    run.swings.forEach((swing) => {
      if (choice.keepIds.has(swing.id)) shots.push(toShot(swing, choice.club!))
    })
  })
  if (shots.length === 0) return null
  shots.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  return {
    id: `${RANGE_SORT_SESSION_PREFIX}${visit.key}`,
    startedAt: new Date(visit.startedAt).toISOString(),
    endedAt: new Date(visit.endedAt).toISOString(),
    shots,
    metadata: { app: 'nova-validation', schemaVersion: 3, source: 'gspro', feedMode: 'real', includeInAnalysis: true },
  }
}
