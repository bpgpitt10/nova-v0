import type { AimCandidateEvaluation, ClubAimEvaluation } from './aimOptimization'
import { nextStateValueForAimCandidate } from './aimDecisionRanking'

/**
 * The safe play: a second option next to the lowest-expected-strokes pick,
 * for shots where the math pick carries real risk and a materially safer
 * club or line costs little. Display only; the headline recommendation is
 * unchanged. See claude/recommendation-model-review-2026-11-05.md §4.
 */
export type SafeAlternativePolicy = Readonly<{
  /** The math pick must carry at least this catastrophe share (0–1) … */
  mathCatastropheMin: number
  /** … or at least this serious-trouble share, for a safe play to be worth showing. */
  mathTroubleMin: number
  /** Safe candidates: catastrophe within this of the lowest catastrophe among all candidates. */
  catastropheWithinBest: number
  /** Safe candidates: serious trouble at most this fraction of the math pick's. */
  troubleFractionOfMath: number
  /** The safe play must cut catastrophe by this much … */
  catastropheCutMin: number
  /** … or serious trouble by this much. */
  troubleCutMin: number
  /** Most it may cost in expected strokes (beyond this distance to the target). */
  maxCostStrokes: number
  /** Inside this distance the cost cap tightens. */
  shortRangeYds: number
  maxCostStrokesShortRange: number
  /** Same club: the aim must move at least this far to be a different play. */
  minAimChangeYds: number
  /**
   * A safe play that only cuts sand/deep rough must still get there: its expected
   * total within this of the target. A lay-up is only a safe play when it keeps
   * the ball out of water or OB. (Tour continuation values make a 30-yd pitch
   * look nearly free, so without this an 8i showed as the safe play on a
   * 171-yd par 3.)
   */
  troubleCutMustReachWithinYds: number
}>

export const DEFAULT_SAFE_ALTERNATIVE_POLICY: SafeAlternativePolicy = {
  mathCatastropheMin: 0.04,
  mathTroubleMin: 0.15,
  catastropheWithinBest: 0.01,
  troubleFractionOfMath: 0.5,
  catastropheCutMin: 0.03,
  troubleCutMin: 0.10,
  maxCostStrokes: 0.25,
  shortRangeYds: 150,
  maxCostStrokesShortRange: 0.15,
  minAimChangeYds: 10,
  troubleCutMustReachWithinYds: 20,
}

export type SafeAlternative = Readonly<{
  club: string
  evaluation: ClubAimEvaluation
  candidate: AimCandidateEvaluation
  /** Expected future strokes of the safe play minus the math pick's (positive = costs). */
  costStrokes: number
  math: Readonly<{ club: string; candidate: AimCandidateEvaluation; catastrophe: number; seriousTrouble: number; expectedFutureStrokes: number }>
  catastrophe: number
  seriousTrouble: number
  expectedFutureStrokes: number
  /** Which risk the safe play mainly removes. */
  mainlyCuts: 'catastrophe' | 'trouble'
  /** 'club' when it's a different club, 'line' when the same club on a different line. */
  differsBy: 'club' | 'line'
}>

type Scored = {
  evaluation: ClubAimEvaluation
  candidate: AimCandidateEvaluation
  catastrophe: number
  seriousTrouble: number
  expectedFutureStrokes: number
}

const score = (evaluation: ClubAimEvaluation, candidate: AimCandidateEvaluation): Scored | null => {
  const risk = candidate.riskProfile
  if (!risk) return null
  const value = nextStateValueForAimCandidate(candidate)
  if (value?.expectedFutureStrokes == null || !Number.isFinite(value.expectedFutureStrokes)) return null
  return {
    evaluation, candidate,
    catastrophe: risk.catastrophe, seriousTrouble: risk.seriousTrouble,
    expectedFutureStrokes: value.expectedFutureStrokes,
  }
}

/**
 * Picks the safe play, or null when nothing earns the space: the math pick is
 * already safe, no candidate is materially safer, or the safer ones cost too
 * much. `evaluations` must be ranked (decisionRank 1 = the math pick).
 */
export const pickSafeAlternative = (
  evaluations: readonly ClubAimEvaluation[],
  policy: SafeAlternativePolicy = DEFAULT_SAFE_ALTERNATIVE_POLICY,
): SafeAlternative | null => {
  const mathEvaluation = evaluations.find((evaluation) => evaluation.decisionRank === 1) ?? evaluations[0]
  if (!mathEvaluation?.bestCandidate) return null
  const math = score(mathEvaluation, mathEvaluation.bestCandidate)
  if (!math) return null
  if (math.catastrophe < policy.mathCatastropheMin && math.seriousTrouble < policy.mathTroubleMin) return null

  const all: Scored[] = []
  for (const evaluation of evaluations) {
    // Cold-start clubs (too few shots to compare) can't be the safe play either.
    if (evaluation.decisionReason?.includes('not eligible') || evaluation.decisionReason?.includes('cold-start')) continue
    for (const candidate of evaluation.candidates) {
      const scored = score(evaluation, candidate)
      if (scored) all.push(scored)
    }
  }
  if (all.length === 0) return null
  const minCatastrophe = Math.min(...all.map((row) => row.catastrophe))
  const maxCost = mathEvaluation.targetDistanceYds <= policy.shortRangeYds
    ? policy.maxCostStrokesShortRange : policy.maxCostStrokes

  const differsEnough = (row: Scored) =>
    row.evaluation.club !== mathEvaluation.club
    || Math.abs(row.candidate.aimOffsetYds - math.candidate.aimOffsetYds) >= policy.minAimChangeYds
  const materiallySafer = (row: Scored) =>
    math.catastrophe - row.catastrophe >= policy.catastropheCutMin
    || math.seriousTrouble - row.seriousTrouble >= policy.troubleCutMin
  const affordable = (row: Scored) => row.expectedFutureStrokes - math.expectedFutureStrokes <= maxCost
  const strict = (row: Scored) =>
    row.catastrophe <= minCatastrophe + policy.catastropheWithinBest + 1e-9
    && row.seriousTrouble <= math.seriousTrouble * policy.troubleFractionOfMath + 1e-9
  const relaxed = (row: Scored) => row.catastrophe <= minCatastrophe + policy.catastropheWithinBest + 1e-9

  const reaches = (row: Scored) => {
    const cutsCatastrophe = math.catastrophe - row.catastrophe >= policy.catastropheCutMin
    if (cutsCatastrophe) return true
    const total = row.evaluation.expectedTotalYds ?? row.evaluation.modeledTotalYds
    return !Number.isFinite(total) || total >= mathEvaluation.targetDistanceYds - policy.troubleCutMustReachWithinYds
  }
  const eligible = all.filter((row) => row !== math && differsEnough(row) && materiallySafer(row) && affordable(row) && reaches(row))
  const pool = eligible.filter(strict).length > 0 ? eligible.filter(strict) : eligible.filter(relaxed)
  if (pool.length === 0) return null
  // Lowest expected strokes among the safe ones; ties to the smaller aim change.
  pool.sort((a, b) => a.expectedFutureStrokes - b.expectedFutureStrokes
    || Math.abs(a.candidate.aimOffsetYds) - Math.abs(b.candidate.aimOffsetYds))
  const safe = pool[0]
  const catastropheCut = math.catastrophe - safe.catastrophe
  const troubleCut = math.seriousTrouble - safe.seriousTrouble
  return {
    club: safe.evaluation.club,
    evaluation: safe.evaluation,
    candidate: safe.candidate,
    costStrokes: safe.expectedFutureStrokes - math.expectedFutureStrokes,
    math: {
      club: mathEvaluation.club, candidate: math.candidate, catastrophe: math.catastrophe,
      seriousTrouble: math.seriousTrouble, expectedFutureStrokes: math.expectedFutureStrokes,
    },
    catastrophe: safe.catastrophe,
    seriousTrouble: safe.seriousTrouble,
    expectedFutureStrokes: safe.expectedFutureStrokes,
    mainlyCuts: catastropheCut >= policy.catastropheCutMin ? 'catastrophe' : troubleCut > catastropheCut * 3 ? 'trouble' : 'catastrophe',
    differsBy: safe.evaluation.club !== mathEvaluation.club ? 'club' : 'line',
  }
}

/** "1 in 8" style frequency, the way the card talks about risk. */
export const oneIn = (share: number): string => {
  if (share <= 0) return 'none'
  const n = Math.round(1 / share)
  if (n <= 1) return 'most'
  return `1 in ${n}`
}

/** One line for the card, from the facts above. */
export const describeSafeAlternative = (safe: SafeAlternative): string => {
  const cost = safe.costStrokes
  const costText = cost < 0.05 ? 'costs almost nothing'
    : cost < 0.18 ? 'costs about a tenth of a stroke'
      : cost < 0.3 ? 'costs about a quarter stroke'
        : `costs about ${cost.toFixed(1)} strokes`
  const risk = safe.mainlyCuts === 'catastrophe'
    ? `water or penalty ${oneIn(safe.catastrophe)} instead of ${oneIn(safe.math.catastrophe)}`
    : `sand or deep rough ${oneIn(safe.seriousTrouble)} instead of ${oneIn(safe.math.seriousTrouble)}`
  return `${costText} · ${risk}`
}
