import { scoredShots, tourExpectedStrokes, type RoundSummary, type WorldPoint } from './roundHistory'

/**
 * The putting profile: every real putt split into the skills behind it.
 *
 *   Read  where the aim was placed. Estimated for now as the sideways miss left
 *         once the start-line error is taken out; exact once putts carry the
 *         aim and roll path (captured from PR #179 on)
 *   Line  did the ball start where it was aimed (launch monitor start direction)
 *   Pace  did it travel the right distance (where it stopped against the cup)
 *
 * Strokes by skill: each miss is replayed with one, two or all three errors
 * removed, and each skill is credited with what its fix saves (shared effects
 * split evenly). A first-order estimate: a putt hit at a different pace would
 * also have broken differently, which this ignores.
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
/** Half the hole: a putt this close to the centre line, with the pace to get there, goes in. */
const CUP_RADIUS_FT = 2.125 / 12
/** Arriving with more than this much roll left, the ball does not drop. */
const MAX_HOLING_PAST_FT = 4

export type PuttSkill = 'read' | 'pace' | 'line'
/** In the order a putt happens: read it, start it on line, find out if the pace was right. */
export const PUTT_SKILLS: readonly PuttSkill[] = ['read', 'line', 'pace']
export type SkillCosts = Readonly<Record<PuttSkill, number>>

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
  /** Sideways miss at the hole that came from the aim (not the start line), feet; right is positive. */
  readLateralFt: number | null
  /** Strokes each skill cost on this putt (null when it can't be split: holed, or no start direction). */
  costs: SkillCosts | null
  /** The skill that cost the most on this putt. */
  cause: PuttSkill | null
  /** A miss that left a gimme: the next putt on the hole was conceded. */
  leftGimme: boolean
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
  /** The same typical miss as a distance at the hole, feet (pace: from the ideal finish; line: start error carried to the hole). */
  sizeFt: number | null
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
  read: SkillSummary
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
  read: SkillSummary
  pace: SkillSummary
  line: SkillSummary
  /** How the cost of the misses splits between the skills (sums to 1); null with nothing to split. */
  skillShare: SkillCosts | null
  /** sgPer18 split between the skills; the three always add up to it. */
  skillStrokes: SkillCosts | null
  /** Misses the split is built on. */
  attributedPutts: number
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
  const sizeFt = median(misses.map((putt) => Math.abs((putt.alongFt as number) - IDEAL_PAST_FT)))
  return { putts: misses.length, size, sizeFt, lean, split, kind: kindOf(misses.length, size, lean, 0.08) }
}

/** Line: every putt with a start direction, holed or not. */
export const summarizeLine = (putts: readonly ProfilePutt[]): SkillSummary => {
  const known = putts.filter((putt) => putt.startDirectionDeg != null)
  const size = median(known.map((putt) => Math.abs(putt.startDirectionDeg as number)))
  const left = known.filter((putt) => (putt.startDirectionDeg as number) < -0.25).length
  const right = known.filter((putt) => (putt.startDirectionDeg as number) > 0.25).length
  const { lean, split } = leanOf('left', left, 'right', right)
  const sizeFt = median(known.map((putt) => Math.abs(Math.tan(((putt.startDirectionDeg as number) * Math.PI) / 180)) * putt.lengthFt))
  return { putts: known.length, size, sizeFt, lean, split, kind: kindOf(known.length, size, lean, 1) }
}

/** Read: misses with a start direction. Size is how far the aim alone sent the ball from the hole, feet. */
export const summarizeRead = (putts: readonly ProfilePutt[]): SkillSummary => {
  const known = putts.filter((putt) => !putt.holed && putt.readLateralFt != null)
  const size = median(known.map((putt) => Math.abs(putt.readLateralFt as number)))
  const left = known.filter((putt) => (putt.readLateralFt as number) < -CUP_RADIUS_FT).length
  const right = known.filter((putt) => (putt.readLateralFt as number) > CUP_RADIUS_FT).length
  const { lean, split } = leanOf('left', left, 'right', right)
  return { putts: known.length, size, sizeFt: size, lean, split, kind: kindOf(known.length, size, lean, 0.5) }
}

/** Strokes still to play from a finish against the cup: 0 when it drops. */
const strokesFrom = (lateralFt: number, alongFt: number) =>
  Math.abs(lateralFt) <= CUP_RADIUS_FT && alongFt >= 0 && alongFt <= MAX_HOLING_PAST_FT
    ? 0
    : tourExpectedStrokes('green', Math.hypot(lateralFt, alongFt) / 3)

/**
 * What each skill cost on one missed putt. The sideways miss is the start-line
 * error carried to the hole plus whatever the aim was off by; the pace error is
 * the distance from an ideal finish. Each skill gets its average saving over
 * every order of fixing the three.
 */
export const attributeMiss = (lengthFt: number, lateralFt: number, alongFt: number, startDirectionDeg: number) => {
  const lineLateral = lengthFt * Math.tan((startDirectionDeg * Math.PI) / 180)
  const readLateral = lateralFt - lineLateral
  const cost = (fix: Readonly<Record<PuttSkill, boolean>>) =>
    strokesFrom(lateralFt - (fix.line ? lineLateral : 0) - (fix.read ? readLateral : 0), fix.pace ? IDEAL_PAST_FT : alongFt)
  const fixing = (...skills: PuttSkill[]): Record<PuttSkill, boolean> =>
    ({ read: skills.includes('read'), pace: skills.includes('pace'), line: skills.includes('line') })
  const costs: Record<PuttSkill, number> = { read: 0, pace: 0, line: 0 }
  for (const skill of PUTT_SKILLS) {
    const others = PUTT_SKILLS.filter((other) => other !== skill)
    const a = others[0]
    const b = others[1]
    // Saving from fixing `skill` when 0, 1 or 2 of the others are already fixed (weights 1/3, 1/6, 1/6, 1/3).
    const saving = (...already: PuttSkill[]) => cost(fixing(...already)) - cost(fixing(...already, skill))
    costs[skill] = saving() / 3 + saving(a) / 6 + saving(b) / 6 + saving(a, b) / 3
  }
  return { costs, readLateralFt: readLateral }
}

const causeOf = (costs: SkillCosts | null): PuttSkill | null =>
  costs ? [...PUTT_SKILLS].sort((x, y) => costs[y] - costs[x])[0] : null

/** First putts left inside tap-in range (3 ft: good anywhere) and inside the sim's gimme circle (5 ft). */
export const leaveSummary = (putts: readonly ProfilePutt[]) => {
  const firsts = putts.filter((putt) => putt.first)
  return {
    firsts: firsts.length,
    inside3: firsts.filter((putt) => putt.leaveFt <= 3).length,
    inside5: firsts.filter((putt) => putt.leaveFt <= 5).length,
  }
}

const threePuttsIn = (putts: readonly ProfilePutt[]) => putts.filter((putt) => putt.first && putt.holePutts >= 3).length

/** Real putts from one round: 5 ft and out, no gimmes, believable speed. Auto-putt rounds give none. */
export const profilePutts = (round: RoundSummary): ProfilePutt[] => {
  if (round.autoPutt) return []
  return round.holes.filter((hole) => hole.complete).flatMap((hole) => {
    const holePutts = hole.shots.filter((shot) => shot.isPutt)
    const firstNumber = holePutts[0]?.number ?? null
    const holedEnd = hole.shots.find((shot) => shot.holed)?.end ?? null
    return holePutts.flatMap((shot, puttIndex): ProfilePutt[] => {
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
      const split = !shot.holed && alongFt != null && lateralFt != null && shot.startDirectionDeg != null
        ? attributeMiss(lengthFt, lateralFt, alongFt, shot.startDirectionDeg)
        : null
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
        readLateralFt: split?.readLateralFt ?? null,
        costs: split?.costs ?? null,
        cause: causeOf(split?.costs ?? null),
        leftGimme: !shot.holed && holePutts[puttIndex + 1]?.conceded === true,
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
      read: summarizeRead(onSlope),
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

  // How the cost of the misses splits. A skill whose fixes would not have helped overall counts as zero.
  const attributed = putts.filter((putt) => putt.costs != null)
  const totalFor = (skill: PuttSkill) => Math.max(0, attributed.reduce((sum, putt) => sum + (putt.costs as SkillCosts)[skill], 0))
  const totals = { read: totalFor('read'), pace: totalFor('pace'), line: totalFor('line') }
  const totalCost = totals.read + totals.pace + totals.line
  const sgPer18 = holes > 0 && putts.length > 0 ? (sgTotal / holes) * 18 : null
  const skillShare: SkillCosts | null = totalCost > 0
    ? { read: totals.read / totalCost, pace: totals.pace / totalCost, line: totals.line / totalCost }
    : null
  // The three always add up to sgPer18. Losing strokes: each skill takes its share of the cost.
  // Gaining strokes: the gain goes the other way round, most to the skill that cost least.
  const weight = (share: number) => (sgPer18 != null && sgPer18 < 0 ? share : (1 - share) / 2)
  const skillStrokes: SkillCosts | null = skillShare && sgPer18 != null
    ? { read: sgPer18 * weight(skillShare.read), pace: sgPer18 * weight(skillShare.pace), line: sgPer18 * weight(skillShare.line) }
    : null

  const gimmes = rounds.flatMap(scoredShots).filter((shot) => shot.isPutt && shot.conceded).length

  return {
    rounds: byRound.length,
    holes,
    putts,
    sgPer18,
    read: summarizeRead(putts),
    pace: summarizePace(putts),
    line: summarizeLine(putts),
    skillShare,
    skillStrokes,
    attributedPutts: attributed.length,
    readPutts: putts.filter((putt) => putt.hasAim).length,
    lengths,
    slopes,
    trend,
    gimmes,
    autoPuttRounds: counted.length - rounds.length,
  }
}
