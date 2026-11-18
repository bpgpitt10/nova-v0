import { scoredShots, type RoundSummary, type WorldPoint } from './roundHistory'

/**
 * The putting profile: every real putt split into the skills behind it.
 *
 *   Read  where the aim was placed (needs the aim and roll path: captured from
 *         PR #179 on, so it fills in as new putts arrive)
 *   Line  did the ball start where it was aimed (launch monitor start direction)
 *   Pace  did it travel the right distance (where it stopped against the cup)
 *
 * No plain averages: opposite misses cancel. Each skill gets a size (typical
 * miss, ignoring direction) and a lean (which way, only when lopsided).
 * (Design: claude/putting-review-design.md.)
 */

/** Sim gimme circles are 5–6 ft, so nothing shorter is analysed. */
export const MIN_PUTT_FT = 5
/** Anything faster off the face is not a putt (full swings from the green show up at 60+ mph). */
export const MAX_PUTT_SPEED_MPH = 25
/** Good pace would finish about this far past the hole. */
export const IDEAL_PAST_FT = 1
/** A miss finishing further past than this was too firm. */
export const LONG_PAST_FT = 3
/** GSPro's cup point sits at the bottom of the hole, this far under the green (measured, Old Game round 268). */
const CUP_DEPTH_M = 0.165
/** Steeper than this (rise over length) counts as uphill or downhill. */
const SLOPE_GRADE = 0.01
/** A lean is called when at least this share goes one way. */
const LEAN_SHARE = 2 / 3
/** Putts before a skill gets a label. */
export const MIN_PUTTS_FOR_LABEL = 12
/** Putts with aim and roll path before Read is shown. */
export const READ_PUTTS_NEEDED = 60
const M_TO_FT = 3.280839895

export const PUTT_LENGTH_BUCKETS: ReadonlyArray<readonly [string, string, number, number | null]> = [
  ['5-10', '5–10 ft', 5, 10], ['10-15', '10–15 ft', 10, 15], ['15-25', '15–25 ft', 15, 25],
  ['25-35', '25–35 ft', 25, 35], ['35-50', '35–50 ft', 35, 50], ['50+', '50 ft +', 50, null],
]

export type PuttSlope = 'up' | 'flat' | 'down'
export type PaceResult = 'holed' | 'short' | 'good' | 'long'

export type ProfilePutt = Readonly<{
  roundId: number
  courseName: string
  playedAt: string | null
  holeNumber: number
  number: number
  lengthFt: number
  lengthBucket: string
  holed: boolean
  sg: number | null
  /** Feet left after the putt (0 when holed). */
  leaveFt: number
  /** Where it stopped against the cup, feet: past the hole is positive, right of the start line is positive. */
  alongFt: number | null
  lateralFt: number | null
  /** Inches the cup sits above (+) or below (−) the ball. */
  riseIn: number | null
  slope: PuttSlope | null
  pace: PaceResult | null
  /** Start direction against the aim, degrees; negative is left. */
  startDirectionDeg: number | null
  ballSpeedMph: number | null
  /** The aim was captured, so this putt can be graded for Read once that ships. */
  hasAim: boolean
  /** First putt on the hole. */
  first: boolean
  /** Putts taken on the hole, gimmes included. */
  holePutts: number
}>

export type SkillKind = 'collecting' | 'strength' | 'habit' | 'habit-scatter' | 'scattered'

export type SkillSummary = Readonly<{
  putts: number
  /** Typical miss, ignoring direction: pace as a share of the putt's length, line in degrees. */
  size: number | null
  /** Which way it leans, or null for no lean. */
  lean: Readonly<{ side: string; count: number; of: number }> | null
  /** How the two sides split, for "no lean" wording. */
  split: Readonly<{ a: string; aCount: number; b: string; bCount: number }> | null
  kind: SkillKind
}>

export type LengthRow = Readonly<{
  id: string
  label: string
  putts: number
  made: number
  sgPerPutt: number | null
  /** Mean feet left after a miss. */
  avgLeaveFt: number | null
  threePutts: number
}>

export type SlopeRow = Readonly<{
  slope: PuttSlope
  putts: number
  made: number
  pace: SkillSummary
  line: SkillSummary
  threePutts: number
}>

export type TrendPoint = Readonly<{ roundId: number; playedAt: string | null; courseName: string; sgPer18: number; rolling: number }>

export type PuttingProfile = Readonly<{
  rounds: number
  holes: number
  putts: readonly ProfilePutt[]
  /** Strokes gained putting per 18 holes against the tour benchmark (negative = lost). */
  sgPer18: number | null
  pace: SkillSummary
  line: SkillSummary
  /** Putts that carry an aim, toward READ_PUTTS_NEEDED. */
  readPutts: number
  lengths: readonly LengthRow[]
  slopes: readonly SlopeRow[]
  trend: readonly TrendPoint[]
  gimmes: number
  autoPuttRounds: number
}>

const mean = (values: readonly number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null)
const median = (values: readonly number[]) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const bucketFor = (lengthFt: number) =>
  PUTT_LENGTH_BUCKETS.find(([, , from, to]) => lengthFt >= from && (to == null || lengthFt < to))?.[0] ?? '5-10'

/** Where the ball stopped against the cup, along and across the start-to-cup line. */
const finishAgainstCup = (start: WorldPoint, end: WorldPoint, cup: WorldPoint) => {
  const dx = cup.x - start.x
  const dz = cup.z - start.z
  const length = Math.hypot(dx, dz)
  if (length < 0.05) return null
  const ux = dx / length
  const uz = dz / length
  const ex = end.x - cup.x
  const ez = end.z - cup.z
  return {
    lengthFt: length * M_TO_FT,
    alongFt: (ex * ux + ez * uz) * M_TO_FT,
    // GSPro's world is left-handed (x east, z north): right of the line is (uz, −ux).
    lateralFt: (ex * uz - ez * ux) * M_TO_FT,
  }
}

const paceOf = (holed: boolean, alongFt: number | null): PaceResult | null => {
  if (holed) return 'holed'
  if (alongFt == null) return null
  if (alongFt < 0) return 'short'
  return alongFt > LONG_PAST_FT ? 'long' : 'good'
}

const kindOf = (putts: number, size: number | null, lean: SkillSummary['lean'], smallBelow: number): SkillKind => {
  if (putts < MIN_PUTTS_FOR_LABEL || size == null) return 'collecting'
  const small = size < smallBelow
  if (small) return lean ? 'habit' : 'strength'
  return lean ? 'habit-scatter' : 'scattered'
}

const leanOf = (a: string, aCount: number, b: string, bCount: number) => {
  const of = aCount + bCount
  const split = { a, aCount, b, bCount }
  if (of < 4) return { lean: null, split }
  if (aCount / of >= LEAN_SHARE) return { lean: { side: a, count: aCount, of }, split }
  if (bCount / of >= LEAN_SHARE) return { lean: { side: b, count: bCount, of }, split }
  return { lean: null, split }
}

/** Pace: missed putts with a known finish. Size is the distance from the ideal finish as a share of the putt. */
export const summarizePace = (putts: readonly ProfilePutt[]): SkillSummary => {
  const misses = putts.filter((putt) => !putt.holed && putt.alongFt != null)
  const size = median(misses.map((putt) => Math.abs((putt.alongFt as number) - IDEAL_PAST_FT) / putt.lengthFt))
  const short = misses.filter((putt) => putt.pace === 'short').length
  const long = misses.filter((putt) => putt.pace === 'long').length
  const { lean, split } = leanOf('short', short, 'long', long)
  return { putts: misses.length, size, lean, split, kind: kindOf(misses.length, size, lean, 0.08) }
}

/** Line: every putt with a start direction, holed or not. */
export const summarizeLine = (putts: readonly ProfilePutt[]): SkillSummary => {
  const known = putts.filter((putt) => putt.startDirectionDeg != null)
  const size = median(known.map((putt) => Math.abs(putt.startDirectionDeg as number)))
  const left = known.filter((putt) => (putt.startDirectionDeg as number) < -0.25).length
  const right = known.filter((putt) => (putt.startDirectionDeg as number) > 0.25).length
  const { lean, split } = leanOf('left', left, 'right', right)
  return { putts: known.length, size, lean, split, kind: kindOf(known.length, size, lean, 1) }
}

const threePuttsIn = (putts: readonly ProfilePutt[]) => putts.filter((putt) => putt.first && putt.holePutts >= 3).length

/** Real putts from one round: 5 ft and out, no gimmes, believable speed. Auto-putt rounds give none. */
export const profilePutts = (round: RoundSummary): ProfilePutt[] => {
  if (round.autoPutt) return []
  return round.holes.filter((hole) => hole.complete).flatMap((hole) => {
    const holePutts = hole.shots.filter((shot) => shot.isPutt)
    const firstNumber = holePutts[0]?.number ?? null
    const holedEnd = hole.shots.find((shot) => shot.holed)?.end ?? null
    return holePutts.flatMap((shot): ProfilePutt[] => {
      if (shot.conceded || shot.startYds == null) return []
      if (shot.ballSpeedMph != null && shot.ballSpeedMph > MAX_PUTT_SPEED_MPH) return []
      // GSPro's own cup point when the shot carries one; otherwise where the holed putt came to rest.
      const cup = shot.cup ?? holedEnd
      const finish = shot.start && shot.end && cup ? finishAgainstCup(shot.start, shot.end, cup) : null
      const lengthFt = shot.startYds * 3
      if (lengthFt < MIN_PUTT_FT) return []
      // Positions that disagree with the recorded distance belong to another shot: keep the putt, drop the geometry.
      const trusted = finish != null && Math.abs(finish.lengthFt - lengthFt) <= Math.max(1.5, lengthFt * 0.15)
      const alongFt = shot.holed ? 0 : trusted && finish ? finish.alongFt : null
      const lateralFt = shot.holed ? 0 : trusted && finish ? finish.lateralFt : null
      const cupSurfaceY = shot.cup ? shot.cup.y + CUP_DEPTH_M : null
      const riseIn = cupSurfaceY != null && shot.start && trusted ? (cupSurfaceY - shot.start.y) * M_TO_FT * 12 : null
      const grade = riseIn != null ? riseIn / 12 / lengthFt : null
      return [{
        roundId: round.roundId,
        courseName: round.courseName,
        playedAt: round.playedAt,
        holeNumber: hole.holeNumber,
        number: shot.number,
        lengthFt,
        lengthBucket: bucketFor(lengthFt),
        holed: shot.holed,
        sg: shot.sg,
        leaveFt: shot.holed ? 0 : shot.endYds * 3,
        alongFt,
        lateralFt,
        riseIn,
        slope: grade == null ? null : grade > SLOPE_GRADE ? 'up' : grade < -SLOPE_GRADE ? 'down' : 'flat',
        pace: paceOf(shot.holed, alongFt),
        startDirectionDeg: shot.startDirectionDeg,
        ballSpeedMph: shot.ballSpeedMph,
        hasAim: shot.aimDirectionDeg != null,
        first: shot.number === firstNumber,
        holePutts: holePutts.length,
      }]
    })
  })
}

export const buildPuttingProfile = (allRounds: readonly RoundSummary[]): PuttingProfile => {
  const counted = allRounds.filter((round) => round.counts && round.completeHoles > 0)
  const rounds = counted.filter((round) => !round.autoPutt)
  const byRound = rounds.map((round) => ({ round, putts: profilePutts(round) })).filter((entry) => entry.putts.length > 0)
  const putts = byRound.flatMap((entry) => entry.putts)
  const holes = byRound.reduce((sum, entry) => sum + entry.round.completeHoles, 0)
  const sgTotal = putts.reduce((sum, putt) => sum + (putt.sg ?? 0), 0)

  const lengths: LengthRow[] = PUTT_LENGTH_BUCKETS.map(([id, label]) => {
    const inBucket = putts.filter((putt) => putt.lengthBucket === id)
    return {
      id, label,
      putts: inBucket.length,
      made: inBucket.filter((putt) => putt.holed).length,
      sgPerPutt: mean(inBucket.flatMap((putt) => (putt.sg != null ? [putt.sg] : []))),
      avgLeaveFt: mean(inBucket.filter((putt) => !putt.holed).map((putt) => putt.leaveFt)),
      threePutts: threePuttsIn(inBucket),
    }
  })

  const slopes: SlopeRow[] = (['up', 'flat', 'down'] as const).map((slope) => {
    const onSlope = putts.filter((putt) => putt.slope === slope)
    return {
      slope,
      putts: onSlope.length,
      made: onSlope.filter((putt) => putt.holed).length,
      pace: summarizePace(onSlope),
      line: summarizeLine(onSlope),
      threePutts: threePuttsIn(onSlope),
    }
  })

  const ordered = [...byRound].sort((a, b) => (a.round.playedAt ?? '').localeCompare(b.round.playedAt ?? ''))
  const perRound = ordered.map((entry) => ({
    roundId: entry.round.roundId,
    playedAt: entry.round.playedAt,
    courseName: entry.round.courseName,
    sgPer18: (entry.putts.reduce((sum, putt) => sum + (putt.sg ?? 0), 0) / entry.round.completeHoles) * 18,
  }))
  // Three rounds at a time: one round's putting swings too much to read on its own.
  const trend: TrendPoint[] = perRound.map((point, index) => {
    const window = perRound.slice(Math.max(0, index - 2), index + 1)
    return { ...point, rolling: window.reduce((sum, p) => sum + p.sgPer18, 0) / window.length }
  })

  const gimmes = rounds.flatMap(scoredShots).filter((shot) => shot.isPutt && shot.conceded).length

  return {
    rounds: byRound.length,
    holes,
    putts,
    sgPer18: holes > 0 && putts.length > 0 ? (sgTotal / holes) * 18 : null,
    pace: summarizePace(putts),
    line: summarizeLine(putts),
    readPutts: putts.filter((putt) => putt.hasAim).length,
    lengths,
    slopes,
    trend,
    gimmes,
    autoPuttRounds: counted.length - rounds.length,
  }
}
