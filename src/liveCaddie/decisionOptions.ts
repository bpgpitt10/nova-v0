import type { ClubAimEvaluation } from './aimOptimization'
import { modelBasisFromCarryWeight, type ModelBasis } from '../lib/quickBag'

/**
 * Caddie vs you: the engine's numbers at the moment a club is armed.
 *
 * The lineage store already records which club Looper recommended and which
 * club was armed. Without the engine's value for each, Rounds can only say
 * "Looper said 7i, you hit 6i"; with it, the change is priced in strokes.
 * Kept small (the top four plus whatever the player is looking at) because it
 * rides along in the decision and shot_spec payloads of every armed shot.
 */

export type DecisionOption = Readonly<{
  club: string
  rank: number | null
  /** Expected strokes to hole out from the best aim's outcome distribution. */
  expectedStrokes: number | null
  /** The same with the model-confidence penalty the ranking compared. */
  adjustedStrokes: number | null
  /** Probability of a catastrophe (penalty, OB, lost) at the best aim. */
  catastrophe: number | null
  /** 0–1 model confidence from support shots and sessions. */
  confidence: number | null
  strength: string | null
  aimOffsetYds: number | null
  carryYds: number | null
  /** What this club's numbers rested on: the Quick Bag prior, a blend, or range data. */
  basis: ModelBasis
}>

export const DECISION_OPTIONS_MAX = 4

const round = (value: number | null | undefined, digits: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null

export const decisionOptionFromEvaluation = (evaluation: ClubAimEvaluation): DecisionOption => ({
  club: evaluation.club,
  rank: evaluation.decisionRank ?? null,
  expectedStrokes: round(evaluation.decisionValue?.expectedFutureStrokes, 3),
  adjustedStrokes: round(evaluation.decisionValue?.confidenceAdjustedStrokes, 3),
  catastrophe: round(evaluation.decisionValue?.catastropheProbability, 4),
  confidence: round(evaluation.decisionValue?.modelConfidence, 2),
  strength: evaluation.decisionValue?.decisionStrength ?? null,
  aimOffsetYds: round(evaluation.bestCandidate?.aimOffsetYds, 1),
  carryYds: round(evaluation.modeledCarryYds, 1),
  basis: modelBasisFromCarryWeight(evaluation.startingBag?.carryWeight),
})

/** The ranked top few plus the club the player is looking at, in rank order. */
export const decisionOptions = (
  evaluations: readonly ClubAimEvaluation[],
  viewedClub: string | null,
): DecisionOption[] => {
  const ranked = [...evaluations].sort((a, b) =>
    (a.decisionRank ?? Number.POSITIVE_INFINITY) - (b.decisionRank ?? Number.POSITIVE_INFINITY))
  const chosen = ranked.slice(0, DECISION_OPTIONS_MAX)
  if (viewedClub && !chosen.some((e) => e.club === viewedClub)) {
    const viewed = ranked.find((e) => e.club === viewedClub)
    if (viewed) chosen.push(viewed)
  }
  return chosen.map(decisionOptionFromEvaluation)
}

export const serializeDecisionOptions = (
  evaluations: readonly ClubAimEvaluation[],
  viewedClub: string | null,
): string | null => {
  const options = decisionOptions(evaluations, viewedClub)
  return options.length ? JSON.stringify(options) : null
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Parse what the Arm bridge read back off the page. Tolerant: bad entries are dropped. */
export const parseDecisionOptions = (raw: unknown): DecisionOption[] | null => {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!Array.isArray(value)) return null
  const options = value.flatMap((item): DecisionOption[] => {
    if (!item || typeof item !== 'object' || typeof (item as { club?: unknown }).club !== 'string') return []
    const o = item as Record<string, unknown>
    return [{
      club: o.club as string,
      rank: finiteOrNull(o.rank),
      expectedStrokes: finiteOrNull(o.expectedStrokes),
      adjustedStrokes: finiteOrNull(o.adjustedStrokes),
      catastrophe: finiteOrNull(o.catastrophe),
      confidence: finiteOrNull(o.confidence),
      strength: typeof o.strength === 'string' ? o.strength : null,
      aimOffsetYds: finiteOrNull(o.aimOffsetYds),
      carryYds: finiteOrNull(o.carryYds),
      basis: o.basis === 'starting-bag' || o.basis === 'learning' ? o.basis : 'measured',
    }]
  })
  return options.length ? options : null
}

/**
 * Strokes the armed club costs on paper against the recommendation: positive
 * means the engine expected the recommended club to do better. Null when either
 * club's value isn't in the options.
 */
export const paperCostStrokes = (
  options: readonly DecisionOption[] | null | undefined,
  armedClub: string | null,
  recommendedClub: string | null,
): number | null => {
  if (!options || !armedClub || !recommendedClub) return null
  const armed = options.find((o) => o.club === armedClub)?.expectedStrokes
  const recommended = options.find((o) => o.club === recommendedClub)?.expectedStrokes
  if (armed == null || recommended == null) return null
  return Number((armed - recommended).toFixed(3))
}

/**
 * The basis of a decision as a whole: the weakest footing among the clubs it
 * compared (a pick made against a starting-bag alternative is a starting-bag
 * decision). Null without options.
 */
export const decisionBasis = (options: readonly DecisionOption[] | null | undefined): ModelBasis | null => {
  if (!options || options.length === 0) return null
  if (options.some((o) => o.basis === 'starting-bag')) return 'starting-bag'
  if (options.some((o) => o.basis === 'learning')) return 'learning'
  return 'measured'
}
