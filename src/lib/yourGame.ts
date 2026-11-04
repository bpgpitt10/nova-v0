import { scoredShots, type RoundShot, type RoundSummary } from './roundHistory'

/**
 * "Your game": where you lose strokes, across every scored round.
 *
 * Every non-tee, non-putt shot is compared with your typical shot (your own
 * average strokes gained per shot against the tour), then weighted by how
 * often that shot comes up in 18 holes: strokes per round. A small leak you
 * face five times a round outranks a big one you face once a month.
 * (Design: claude/analysis-roadmap.md, "Where you lose strokes"; mockup
 * "Looper Rounds mockup", Leaks artboard, 2 Nov.)
 */

/** Shots for a firm call in one segment; less is an early read. */
export const FIRM_SHOTS = 30
/** Each confidence dot is this many shots (five dots = firm). */
export const SHOTS_PER_DOT = 6
/** A segment needs this many shots before it can be called a leak or a strength. */
const MIN_SEGMENT_SHOTS = 3
/** Strokes per round before a segment counts as a leak (or as holding up). */
const LEAK_THRESHOLD = 0.1

export type Segment = Readonly<{
  id: string
  label: string
  shots: number
  /** Strokes gained per shot vs the tour. */
  sgPerShot: number
  /** Strokes per round vs your typical shot (negative = a leak). */
  perRound: number
  /** One line in plain words. */
  detail: string
  early: boolean
}>

export type LadderRung = Readonly<{
  label: string
  from: number
  to: number | null
  shots: number
  onGreen: number
  /** Mean distance left after the shot, feet (holed = 0). */
  avgLeaveFt: number | null
  sgPerShot: number | null
  dots: number
}>

/** Sim golf's gimme circle: putts inside it are conceded, so there's nothing to read. */
export const GIMME_CIRCLE_FT = 5

export type PuttBucket = Readonly<{
  label: string
  /** Real putts: gimmes and rounds with GSPro's auto putt left out. */
  putts: number
  made: number
  sgPerPutt: number | null
  note: string
}>

export type VsNormalRow = Readonly<{
  label: string
  shots: number
  /** Per shot, last round minus your earlier rounds (positive = better). */
  perShot: number | null
  /** perShot × shots in the last round. */
  roundTotal: number | null
}>

export type YourGame = Readonly<{
  rounds: number
  holes: number
  courses: string[]
  /** Your average non-tee, non-putt shot vs the tour. */
  typical: number | null
  leaks: Segment[]
  strengths: Segment[]
  ladder: LadderRung[]
  putting: PuttBucket[]
  /** Gimmes (conceded putts) across the rounds: counted in the score, not in putting. */
  gimmes: number
  /** The latest round against every round before it, or null with nothing to compare. */
  vsNormal: Readonly<{ courseName: string; playedAt: string | null; normalHoles: number; rows: VsNormalRow[] }> | null
}>

const mean = (values: readonly number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null)

const RUNGS: ReadonlyArray<readonly [number, number | null]> = [
  [0, 20], [20, 40], [40, 60], [60, 80], [80, 100], [100, 120], [120, 160], [160, 200], [200, null],
]

const rungLabel = (from: number, to: number | null) => (to == null ? `${from}+ yd` : `${from}–${to} yd`)

const isGreenFinish = (shot: RoundShot) => shot.holed || shot.endLie === 'green' || shot.endLie === 'holed'

const fromRough = (shot: RoundShot) => shot.startLie === 'rough' || shot.startLie === 'deep-rough'


/** Rounds whose shots can be trusted: full and partial, on complete holes. */
const scored = (rounds: readonly RoundSummary[]) =>
  rounds.filter((round) => (round.status === 'full' || round.status === 'partial') && round.completeHoles > 0)

const shotsOf = (round: RoundSummary) => scoredShots(round).filter((shot) => shot.sg != null && shot.category != null)

/** Shots that aren't tee shots or putts: the ones compared with your typical shot. */
const isFieldShot = (shot: RoundShot) => shot.category === 'approach' || shot.category === 'around-green'

/** Real putts: no gimmes, and no rounds where GSPro putted for you. */
const realPutts = (round: RoundSummary) =>
  round.autoPutt ? [] : shotsOf(round).filter((shot) => shot.isPutt && !shot.conceded)

export const buildYourGame = (allRounds: readonly RoundSummary[]): YourGame => {
  const rounds = scored(allRounds)
  const holes = rounds.reduce((sum, round) => sum + round.completeHoles, 0)
  const perRoundFactor = holes > 0 ? 18 / holes : 0
  const field = rounds.flatMap(shotsOf).filter(isFieldShot)
  const typical = mean(field.map((shot) => shot.sg as number))

  const segment = (id: string, label: string, shots: readonly RoundShot[], detail: (s: readonly RoundShot[]) => string): Segment | null => {
    if (typical == null || shots.length < MIN_SEGMENT_SHOTS) return null
    const sgPerShot = mean(shots.map((shot) => shot.sg as number)) as number
    return {
      id, label, shots: shots.length, sgPerShot,
      perRound: (sgPerShot - typical) * shots.length * perRoundFactor,
      detail: detail(shots),
      early: shots.length < FIRM_SHOTS,
    }
  }

  // Distance rungs for field shots, then lie segments.
  const ladder: LadderRung[] = RUNGS.map(([from, to]) => {
    const inRung = field.filter((shot) => (shot.startYds ?? -1) >= from && (to == null || (shot.startYds ?? Infinity) < to))
    const leaves = inRung.map((shot) => (shot.holed ? 0 : shot.endYds * 3))
    return {
      label: rungLabel(from, to), from, to,
      shots: inRung.length,
      onGreen: inRung.filter(isGreenFinish).length,
      avgLeaveFt: mean(leaves),
      sgPerShot: mean(inRung.map((shot) => shot.sg as number)),
      dots: Math.min(5, Math.floor(inRung.length / SHOTS_PER_DOT)),
    }
  })
  const rungSegments = RUNGS.map(([from, to]) => {
    const inRung = field.filter((shot) => (shot.startYds ?? -1) >= from && (to == null || (shot.startYds ?? Infinity) < to))
    return segment(`rung-${from}`, rungLabel(from, to).replace(' yd', ' yards'), inRung, (s) => {
      const greens = s.filter(isGreenFinish).length
      const leave = mean(s.map((shot) => (shot.holed ? 0 : shot.endYds * 3)))
      return `${greens} of ${s.length} on the green`
        + (leave != null ? `; ${Math.round(leave)} ft left on average` : '') + '.'
    })
  })
  const approachRange = (shot: RoundShot) => (shot.startYds ?? 0) >= 40 && (shot.startYds ?? 0) < 200
  const roughApproaches = field.filter((shot) => fromRough(shot) && approachRange(shot))
  const fairwayApproaches = field.filter((shot) => (shot.startLie === 'fairway' || shot.startLie === 'fringe') && approachRange(shot))
  const fairwayPerShot = mean(fairwayApproaches.map((shot) => shot.sg as number))
  const roughSegment = segment('rough-approach', 'Approaches from the rough, 40–200 yd', roughApproaches, (s) => {
    const perShot = mean(s.map((shot) => shot.sg as number)) as number
    const often = s.length * perRoundFactor
    return (fairwayPerShot != null
      ? `${Math.abs(perShot - fairwayPerShot).toFixed(2)} ${perShot < fairwayPerShot ? 'worse' : 'better'} per shot than from the fairway`
      : 'No fairway approaches to compare yet')
      + `; it comes up about ${often.toFixed(1)} times a round.`
  })
  const sandSegment = segment('sand', 'From the sand', field.filter((shot) => shot.startLie === 'sand'), (s) => {
    const greens = s.filter(isGreenFinish).length
    return `${greens} of ${s.length} reached the green.`
  })

  const segments = [...rungSegments, roughSegment, sandSegment].filter((s): s is Segment => s != null)
  const leaks = segments.filter((s) => s.perRound <= -LEAK_THRESHOLD).sort((a, b) => a.perRound - b.perRound).slice(0, 3)
  const strengths = segments.filter((s) => s.perRound >= LEAK_THRESHOLD).sort((a, b) => b.perRound - a.perRound).slice(0, 3)

  // Putting by length.
  const putts = rounds.flatMap(realPutts)
  // Sim golf plays a 5–6 ft gimme circle, so nothing inside 5 ft is read;
  // long putts split finely (35 ft and 60 ft are different putts).
  const PUTT_BUCKETS: ReadonlyArray<readonly [string, number, number | null]> = [
    ['5–10 ft', 5, 10], ['10–15 ft', 10, 15], ['15–25 ft', 15, 25],
    ['25–35 ft', 25, 35], ['35–50 ft', 35, 50], ['50 ft +', 50, null],
  ]
  const gimmes = rounds.filter((round) => !round.autoPutt).flatMap(shotsOf).filter((shot) => shot.isPutt && shot.conceded).length
  const putting: PuttBucket[] = PUTT_BUCKETS.map(([label, from, to]) => {
    const inBucket = putts.filter((shot) => {
      const ft = (shot.startYds ?? 0) * 3
      return ft >= from && (to == null || ft < to)
    })
    const made = inBucket.filter((shot) => shot.holed).length
    const longest = inBucket.filter((shot) => shot.holed).reduce((max, shot) => Math.max(max, (shot.startYds ?? 0) * 3), 0)
    const twoPutts = inBucket.filter((shot) => !shot.holed && shot.endYds * 3 <= 6).length
    const note = inBucket.length === 0
      ? 'None yet'
      : made > 0 && to == null ? `Longest made: ${Math.round(longest)} ft`
        : from >= 25
          ? `${twoPutts} of ${inBucket.length - made} misses left in gimme range`
          : made === 0 ? 'None holed yet' : `${Math.round((made / inBucket.length) * 100)}% holed`
    return {
      label, putts: inBucket.length, made,
      sgPerPutt: mean(inBucket.map((shot) => shot.sg as number)),
      note,
    }
  })

  // The latest round against every scored round before it.
  const byDate = [...rounds].sort((a, b) => (a.playedAt ?? '').localeCompare(b.playedAt ?? ''))
  const last = byDate[byDate.length - 1]
  const earlier = byDate.slice(0, -1)
  let vsNormal: YourGame['vsNormal'] = null
  if (last && earlier.length) {
    const kinds: ReadonlyArray<readonly [string, (shot: RoundShot) => boolean]> = [
      ['Tee shots', (shot) => shot.category === 'off-the-tee'],
      ['Approach 120+ yd', (shot) => isFieldShot(shot) && (shot.startYds ?? 0) >= 120],
      ['40–120 yd', (shot) => isFieldShot(shot) && (shot.startYds ?? 0) >= 40 && (shot.startYds ?? 0) < 120],
      ['Inside 40 yd', (shot) => isFieldShot(shot) && (shot.startYds ?? 0) < 40],
      ['Putting', (shot) => shot.isPutt && !shot.conceded],
    ]
    const shotsFor = (list: readonly RoundSummary[], kind: (shot: RoundShot) => boolean, putting: boolean) =>
      list.flatMap((round) => (putting ? realPutts(round) : shotsOf(round))).filter(kind)
    vsNormal = {
      courseName: last.courseName,
      playedAt: last.playedAt,
      normalHoles: earlier.reduce((sum, round) => sum + round.completeHoles, 0),
      rows: kinds.map(([label, kind]) => {
        const putting = label === 'Putting'
        const now = shotsFor([last], kind, putting)
        const before = shotsFor(earlier, kind, putting)
        const nowMean = mean(now.map((shot) => shot.sg as number))
        const beforeMean = before.length >= MIN_SEGMENT_SHOTS ? mean(before.map((shot) => shot.sg as number)) : null
        const perShot = nowMean != null && beforeMean != null ? nowMean - beforeMean : null
        return { label, shots: now.length, perShot, roundTotal: perShot != null ? perShot * now.length : null }
      }),
    }
  }

  return {
    rounds: rounds.length,
    holes,
    courses: [...new Set(rounds.map((round) => round.courseName))],
    typical,
    leaks,
    strengths,
    ladder,
    putting,
    gimmes,
    vsNormal,
  }
}
