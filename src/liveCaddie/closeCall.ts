import type { AimCandidateEvaluation, ClubAimEvaluation } from './aimOptimization'
import { nextStateValueForAimCandidate } from './aimDecisionRanking'
import { oneIn, type SafeAlternative } from './safeAlternative'

/**
 * The close call: when the next club is as good as the pick within a few
 * hundredths of a stroke, say so and show it, instead of a confident headline
 * that a 2-yd change in the inputs would flip (Tobacco Road 14, 24 Nov: 7i over
 * 8i by 0.01 strokes, shown as plain "7i"). It shares the slot under the arm
 * button with the safe play; when the runner-up is also the safe play, the
 * safe play says it. Display only: the ranking is unchanged.
 */
export const CLOSE_CALL_MAX_GAP_STROKES = 0.05
/**
 * ... and the two must really trade something: trouble odds this far apart. Without it, 57% of the
 * last two weeks' decisions were "close" (Driver vs 3W off a wide tee, both fine); with it, only the
 * ones like Tobacco Road 14, where the choice is short-with-the-bunker or long-and-safe.
 */
export const CLOSE_CALL_MIN_RISK_GAP = 0.05
/** A difference in trouble this small isn't worth naming. */
const RISK_NAME_MIN = 0.02

export type CloseCallSide = Readonly<{
  club: string
  candidate: AimCandidateEvaluation
  expectedFutureStrokes: number
  catastrophe: number
  seriousTrouble: number
  /** Modeled carry minus the distance to the target: negative lands short, positive past. */
  landsVsTargetYds: number | null
}>

export type CloseCall = Readonly<{
  club: string
  evaluation: ClubAimEvaluation
  candidate: AimCandidateEvaluation
  /** The runner-up's expected strokes minus the pick's (≥ 0). */
  gapStrokes: number
  pick: CloseCallSide
  other: CloseCallSide
}>

const side = (evaluation: ClubAimEvaluation): CloseCallSide | null => {
  const candidate = evaluation.bestCandidate
  const risk = candidate?.riskProfile
  const strokes = candidate ? nextStateValueForAimCandidate(candidate)?.expectedFutureStrokes : null
  if (!candidate || !risk || strokes == null || !Number.isFinite(strokes)) return null
  const lands = Number.isFinite(evaluation.modeledCarryYds) && Number.isFinite(evaluation.targetDistanceYds)
    ? evaluation.modeledCarryYds - evaluation.targetDistanceYds : null
  return {
    club: evaluation.club, candidate, expectedFutureStrokes: strokes,
    catastrophe: risk.catastrophe, seriousTrouble: risk.seriousTrouble, landsVsTargetYds: lands,
  }
}

/**
 * The close call, or null: the pick is clear, the runner-up is the same club,
 * the two don't really trade anything, or the safe play already offers that club. `evaluations` must be ranked
 * (decisionRank 1 = the pick).
 */
export const pickCloseCall = (
  evaluations: readonly ClubAimEvaluation[],
  safe: SafeAlternative | null = null,
  maxGapStrokes = CLOSE_CALL_MAX_GAP_STROKES,
): CloseCall | null => {
  const pickEvaluation = evaluations.find((evaluation) => evaluation.decisionRank === 1)
  const otherEvaluation = evaluations.find((evaluation) => evaluation.decisionRank === 2)
  if (!pickEvaluation || !otherEvaluation || otherEvaluation.club === pickEvaluation.club) return null
  if (otherEvaluation.recommendable === false) return null
  if (otherEvaluation.decisionReason?.includes('not eligible') || otherEvaluation.decisionReason?.includes('cold-start')) return null
  if (safe && safe.club === otherEvaluation.club) return null
  const pick = side(pickEvaluation)
  const other = side(otherEvaluation)
  if (!pick || !other) return null
  const gap = other.expectedFutureStrokes - pick.expectedFutureStrokes
  if (!(gap >= -1e-9 && gap <= maxGapStrokes)) return null
  const riskGap = Math.max(Math.abs(other.catastrophe - pick.catastrophe), Math.abs(other.seriousTrouble - pick.seriousTrouble))
  if (riskGap < CLOSE_CALL_MIN_RISK_GAP) return null
  return { club: other.club, evaluation: otherEvaluation, candidate: other.candidate, gapStrokes: Math.max(0, gap), pick, other }
}

const landsText = (yds: number | null): string | null => {
  if (yds == null) return null
  const rounded = Math.round(Math.abs(yds))
  if (rounded <= 1) return 'lands at the pin'
  return `lands ${rounded} ${yds < 0 ? 'short' : 'past'}`
}

/** Which trouble differs most between the two, in the card's words, from `from`'s side. */
const riskText = (from: CloseCallSide, against: CloseCallSide): string | null => {
  const catastropheGap = from.catastrophe - against.catastrophe
  const troubleGap = from.seriousTrouble - against.seriousTrouble
  const [gap, name, mine, theirs] = Math.abs(catastropheGap) >= Math.abs(troubleGap)
    ? [catastropheGap, 'water or penalty', from.catastrophe, against.catastrophe]
    : [troubleGap, 'sand or deep rough', from.seriousTrouble, against.seriousTrouble]
  if (Math.abs(gap) < RISK_NAME_MIN) return null
  return `${gap > 0 ? 'more' : 'less'} ${name} (${oneIn(mine)} vs ${oneIn(theirs)})`
}

/** "8i is just as good · lands 2 short · more water or penalty (1 in 5 vs 1 in 16)". */
export const describeCloseCall = (close: CloseCall): string =>
  [
    close.gapStrokes < 0.005 ? 'just as good' : `just as good (${close.gapStrokes.toFixed(2)} strokes behind)`,
    landsText(close.other.landsVsTargetYds),
    riskText(close.other, close.pick),
  ].filter(Boolean).join(' · ')

/** Once the close call is on the card: what going back to the pick means. */
export const describeCloseCallPick = (close: CloseCall): string =>
  [landsText(close.pick.landsVsTargetYds), riskText(close.pick, close.other)].filter(Boolean).join(' · ')
