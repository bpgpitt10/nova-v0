import type { CourseSurfaceClassification } from '../courseGeometry/types'
import type { ModeledAimSample } from './aimOutcomeSampling'
import type { DecisionLandingState } from './decisionLandingState'
import type { DecisionRiskProfile } from './decisionRiskProfile'

export type NextStateValueCondition =
  | 'green'
  | 'fairway'
  | 'rough'
  | 'sand'
  | 'recovery'

export type NextStateValueAssumption =
  | 'none'
  | 'distance-clamped-low'
  | 'distance-clamped-high'
  | 'unknown-as-rough'
  | 'water-relief-at-landing-distance'
  | 'penalty-relief-at-landing-distance'

export type NextStateValueResult = {
  modelId: 'broadie-2012-next-state-v1'
  expectedStrokes: number | null
  baseExpectedStrokes: number | null
  penaltyStrokes: number
  condition: NextStateValueCondition | null
  source: 'broadie-2012-table-b1' | 'public-pga-tour-putting-baseline' | null
  distanceToPinYds: number | null
  lowerKnot: number | null
  upperKnot: number | null
  assumption: NextStateValueAssumption
  note: string | null
}

export type CandidateNextStateValue = {
  modelId: 'broadie-2012-next-state-v1'
  expectedFutureStrokes: number | null
  valuedProbability: number
  unresolvedProbability: number
  provisionalProbability: number
  meanDistanceToPinYds: number | null
  coreContribution: number
  tailContribution: number
  byCondition: Partial<
    Record<
      NextStateValueCondition,
      { probability: number; expectedStrokeContribution: number }
    >
  >
}

type OffGreenRow = {
  distanceYds: number
  fairway: number
  rough: number
  sand: number
  recovery: number
}

/**
 * Mark Broadie, "Assessing Golfer Performance on the PGA TOUR," Interfaces
 * 42(2), 2012, Appendix B, Table B.1. Values are average strokes to complete
 * the hole from PGA TOUR shots (2003-2010; >8 million shots).
 *
 * We intentionally retain the published knots and linearly interpolate between
 * them. The model is versioned so a later player-specific continuation model
 * can replace the benchmark without changing the decision-engine contract.
 */
export const BROADIE_2012_OFF_GREEN_TABLE: readonly OffGreenRow[] = [
  { distanceYds: 10, fairway: 2.18, rough: 2.34, sand: 2.43, recovery: 3.45 },
  { distanceYds: 20, fairway: 2.40, rough: 2.59, sand: 2.53, recovery: 3.51 },
  { distanceYds: 30, fairway: 2.52, rough: 2.70, sand: 2.66, recovery: 3.57 },
  { distanceYds: 40, fairway: 2.60, rough: 2.78, sand: 2.82, recovery: 3.71 },
  { distanceYds: 50, fairway: 2.66, rough: 2.87, sand: 2.92, recovery: 3.79 },
  { distanceYds: 60, fairway: 2.70, rough: 2.91, sand: 3.15, recovery: 3.83 },
  { distanceYds: 70, fairway: 2.72, rough: 2.93, sand: 3.21, recovery: 3.84 },
  { distanceYds: 80, fairway: 2.75, rough: 2.96, sand: 3.24, recovery: 3.84 },
  { distanceYds: 90, fairway: 2.77, rough: 2.99, sand: 3.24, recovery: 3.82 },
  { distanceYds: 100, fairway: 2.80, rough: 3.02, sand: 3.23, recovery: 3.80 },
  { distanceYds: 120, fairway: 2.85, rough: 3.08, sand: 3.21, recovery: 3.78 },
  { distanceYds: 140, fairway: 2.91, rough: 3.15, sand: 3.22, recovery: 3.80 },
  { distanceYds: 160, fairway: 2.98, rough: 3.23, sand: 3.28, recovery: 3.81 },
  { distanceYds: 180, fairway: 3.08, rough: 3.31, sand: 3.40, recovery: 3.82 },
  { distanceYds: 200, fairway: 3.19, rough: 3.42, sand: 3.55, recovery: 3.87 },
  { distanceYds: 220, fairway: 3.32, rough: 3.53, sand: 3.70, recovery: 3.92 },
  { distanceYds: 240, fairway: 3.45, rough: 3.64, sand: 3.84, recovery: 3.97 },
  { distanceYds: 260, fairway: 3.58, rough: 3.74, sand: 3.93, recovery: 4.03 },
  { distanceYds: 280, fairway: 3.69, rough: 3.83, sand: 4.00, recovery: 4.10 },
  { distanceYds: 300, fairway: 3.78, rough: 3.90, sand: 4.04, recovery: 4.20 },
  { distanceYds: 320, fairway: 3.84, rough: 3.95, sand: 4.12, recovery: 4.31 },
  { distanceYds: 340, fairway: 3.88, rough: 4.02, sand: 4.26, recovery: 4.44 },
  { distanceYds: 360, fairway: 3.95, rough: 4.11, sand: 4.41, recovery: 4.56 },
  { distanceYds: 380, fairway: 4.03, rough: 4.21, sand: 4.55, recovery: 4.66 },
  { distanceYds: 400, fairway: 4.11, rough: 4.30, sand: 4.69, recovery: 4.75 },
  { distanceYds: 420, fairway: 4.19, rough: 4.40, sand: 4.83, recovery: 4.84 },
  { distanceYds: 440, fairway: 4.27, rough: 4.49, sand: 4.97, recovery: 4.94 },
  { distanceYds: 460, fairway: 4.34, rough: 4.58, sand: 5.11, recovery: 5.03 },
  { distanceYds: 480, fairway: 4.42, rough: 4.68, sand: 5.25, recovery: 5.13 },
  { distanceYds: 500, fairway: 4.50, rough: 4.77, sand: 5.40, recovery: 5.22 },
  { distanceYds: 520, fairway: 4.58, rough: 4.87, sand: 5.54, recovery: 5.32 },
  { distanceYds: 540, fairway: 4.66, rough: 4.96, sand: 5.68, recovery: 5.41 },
  { distanceYds: 560, fairway: 4.74, rough: 5.06, sand: 5.82, recovery: 5.51 },
  { distanceYds: 580, fairway: 4.82, rough: 5.15, sand: 5.96, recovery: 5.60 },
  { distanceYds: 600, fairway: 4.89, rough: 5.25, sand: 6.10, recovery: 5.70 },
] as const

type PuttingRow = { distanceFeet: number; expectedPutts: number }

/**
 * Public PGA TOUR putting benchmark knots. Kept separate from Broadie Table B.1
 * because Appendix B does not publish green values. This is deliberately a
 * replaceable provider inside the same next-state-value contract.
 */
export const PGA_TOUR_PUTTING_TABLE: readonly PuttingRow[] = [
  { distanceFeet: 1, expectedPutts: 1.001 },
  { distanceFeet: 3, expectedPutts: 1.053 },
  { distanceFeet: 5, expectedPutts: 1.256 },
  { distanceFeet: 6, expectedPutts: 1.357 },
  { distanceFeet: 8, expectedPutts: 1.515 },
  { distanceFeet: 10, expectedPutts: 1.626 },
  { distanceFeet: 15, expectedPutts: 1.784 },
  { distanceFeet: 18, expectedPutts: 1.840 },
  { distanceFeet: 20, expectedPutts: 1.878 },
  { distanceFeet: 25, expectedPutts: 1.931 },
  { distanceFeet: 30, expectedPutts: 1.984 },
  { distanceFeet: 40, expectedPutts: 2.058 },
  { distanceFeet: 50, expectedPutts: 2.135 },
  { distanceFeet: 60, expectedPutts: 2.211 },
  { distanceFeet: 70, expectedPutts: 2.293 },
  { distanceFeet: 80, expectedPutts: 2.349 },
  { distanceFeet: 90, expectedPutts: 2.379 },
  { distanceFeet: 100, expectedPutts: 2.382 },
] as const

const interpolate = (
  x: number,
  rows: readonly { x: number; y: number }[],
): { value: number; lower: number; upper: number; clamped: 'low' | 'high' | null } => {
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (x <= first.x) return { value: first.y, lower: first.x, upper: first.x, clamped: 'low' }
  if (x >= last.x) return { value: last.y, lower: last.x, upper: last.x, clamped: 'high' }

  for (let index = 1; index < rows.length; index += 1) {
    const upper = rows[index]
    if (x > upper.x) continue
    const lower = rows[index - 1]
    const fraction = (x - lower.x) / (upper.x - lower.x)
    return {
      value: lower.y + (upper.y - lower.y) * fraction,
      lower: lower.x,
      upper: upper.x,
      clamped: null,
    }
  }

  return { value: last.y, lower: last.x, upper: last.x, clamped: 'high' }
}

const conditionForState = (
  state: DecisionLandingState,
): {
  condition: NextStateValueCondition
  assumption: NextStateValueAssumption
  note: string | null
} => {
  if (state.obstruction === 'woods-or-scrub') {
    return { condition: 'recovery', assumption: 'none', note: null }
  }

  const surface: CourseSurfaceClassification = state.surface
  if (surface === 'green') return { condition: 'green', assumption: 'none', note: null }
  if (surface === 'fairway' || surface === 'tee') {
    return { condition: 'fairway', assumption: 'none', note: null }
  }
  if (surface === 'rough') return { condition: 'rough', assumption: 'none', note: null }
  if (surface === 'bunker') return { condition: 'sand', assumption: 'none', note: null }
  if (surface === 'deep-rough') return { condition: 'recovery', assumption: 'none', note: null }
  if (surface === 'water') {
    return {
      condition: 'rough',
      assumption: 'water-relief-at-landing-distance',
      note: 'V1 relief approximation: one penalty stroke plus rough value at the raw landing/crossing distance.',
    }
  }
  if (surface === 'penalty') {
    return {
      condition: 'recovery',
      assumption: 'penalty-relief-at-landing-distance',
      note: 'V1 penalty approximation: one penalty stroke plus recovery value at the raw landing/crossing distance.',
    }
  }
  return {
    condition: 'rough',
    assumption: 'unknown-as-rough',
    note: 'Unmapped non-woods geometry is provisionally valued as rough; unknown probability remains visible separately.',
  }
}

export const evaluateDecisionLandingStateValue = (
  state: DecisionLandingState,
): NextStateValueResult => {
  const distanceToPinYds = state.distanceToPinYds
  if (typeof distanceToPinYds !== 'number' || !Number.isFinite(distanceToPinYds)) {
    return {
      modelId: 'broadie-2012-next-state-v1',
      expectedStrokes: null,
      baseExpectedStrokes: null,
      penaltyStrokes: state.penaltyStrokeCount,
      condition: null,
      source: null,
      distanceToPinYds: null,
      lowerKnot: null,
      upperKnot: null,
      assumption: 'none',
      note: 'Pin distance is unavailable; next-state value cannot be computed.',
    }
  }

  const mapping = conditionForState(state)
  const penaltyStrokes = state.penaltyStrokeCount

  if (mapping.condition === 'green') {
    const feet = Math.max(0, distanceToPinYds * 3)
    if (feet < 0.01) {
      return {
        modelId: 'broadie-2012-next-state-v1',
        expectedStrokes: 0,
        baseExpectedStrokes: 0,
        penaltyStrokes,
        condition: 'green',
        source: 'public-pga-tour-putting-baseline',
        distanceToPinYds,
        lowerKnot: 0,
        upperKnot: 0,
        assumption: 'none',
        note: null,
      }
    }
    const result = interpolate(
      feet,
      PGA_TOUR_PUTTING_TABLE.map((row) => ({ x: row.distanceFeet, y: row.expectedPutts })),
    )
    const clampAssumption: NextStateValueAssumption =
      result.clamped === 'low'
        ? 'distance-clamped-low'
        : result.clamped === 'high'
          ? 'distance-clamped-high'
          : mapping.assumption
    return {
      modelId: 'broadie-2012-next-state-v1',
      expectedStrokes: result.value + penaltyStrokes,
      baseExpectedStrokes: result.value,
      penaltyStrokes,
      condition: 'green',
      source: 'public-pga-tour-putting-baseline',
      distanceToPinYds,
      lowerKnot: result.lower,
      upperKnot: result.upper,
      assumption: clampAssumption,
      note: mapping.note,
    }
  }

  const offGreenCondition = mapping.condition as Exclude<NextStateValueCondition, 'green'>
  const rows = BROADIE_2012_OFF_GREEN_TABLE.map((row) => ({
    x: row.distanceYds,
    y: row[offGreenCondition],
  }))
  const result = interpolate(distanceToPinYds, rows)
  const clampAssumption: NextStateValueAssumption =
    mapping.assumption !== 'none'
      ? mapping.assumption
      : result.clamped === 'low'
        ? 'distance-clamped-low'
        : result.clamped === 'high'
          ? 'distance-clamped-high'
          : 'none'

  return {
    modelId: 'broadie-2012-next-state-v1',
    expectedStrokes: result.value + penaltyStrokes,
    baseExpectedStrokes: result.value,
    penaltyStrokes,
    condition: mapping.condition,
    source: 'broadie-2012-table-b1',
    distanceToPinYds,
    lowerKnot: result.lower,
    upperKnot: result.upper,
    assumption: clampAssumption,
    note: mapping.note,
  }
}

type WeightedState = {
  state: DecisionLandingState
  weight: number
  source: 'core' | 'tail'
}

export const evaluateCandidateNextStateValue = (
  coreSamples: readonly ModeledAimSample[],
  riskProfile: DecisionRiskProfile,
): CandidateNextStateValue => {
  const weightedStates: WeightedState[] = []
  if (coreSamples.length > 0 && riskProfile.coreProbability > 0) {
    const weight = riskProfile.coreProbability / coreSamples.length
    coreSamples.forEach((sample) => weightedStates.push({ state: sample.state, weight, source: 'core' }))
  }
  riskProfile.tailLandings.forEach((landing) => {
    weightedStates.push({ state: landing.state, weight: landing.weight, source: 'tail' })
  })

  let valuedProbability = 0
  let unresolvedProbability = 0
  let provisionalProbability = 0
  let expectedContribution = 0
  let coreContribution = 0
  let tailContribution = 0
  let weightedDistance = 0
  let distanceProbability = 0
  const byCondition: CandidateNextStateValue['byCondition'] = {}

  weightedStates.forEach((item) => {
    const value = evaluateDecisionLandingStateValue(item.state)
    if (value.expectedStrokes == null || value.condition == null) {
      unresolvedProbability += item.weight
      return
    }

    valuedProbability += item.weight
    if (value.assumption !== 'none') provisionalProbability += item.weight
    const contribution = value.expectedStrokes * item.weight
    expectedContribution += contribution
    if (item.source === 'core') coreContribution += contribution
    else tailContribution += contribution

    if (typeof value.distanceToPinYds === 'number') {
      weightedDistance += value.distanceToPinYds * item.weight
      distanceProbability += item.weight
    }

    const existing = byCondition[value.condition] ?? {
      probability: 0,
      expectedStrokeContribution: 0,
    }
    existing.probability += item.weight
    existing.expectedStrokeContribution += contribution
    byCondition[value.condition] = existing
  })

  const complete = unresolvedProbability <= 1e-6 && valuedProbability >= 1 - 1e-6
  return {
    modelId: 'broadie-2012-next-state-v1',
    expectedFutureStrokes: complete ? expectedContribution : null,
    valuedProbability,
    unresolvedProbability,
    provisionalProbability,
    meanDistanceToPinYds: distanceProbability > 0 ? weightedDistance / distanceProbability : null,
    coreContribution,
    tailContribution,
    byCondition,
  }
}
