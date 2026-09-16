import type { CourseSurfaceClassification } from '../courseGeometry/types'
import type { DecisionLandingState } from './decisionLandingState'
import {
  evaluateCandidateNextStateValue,
  evaluateDecisionLandingStateValue,
  type NextStateValueAssumption,
} from './nextStateValue'
import type { DecisionRiskProfile } from './decisionRiskProfile'
import type { ModeledAimSample } from './aimOutcomeSampling'

const state = (
  surface: CourseSurfaceClassification,
  distanceToPinYds: number,
  options: Partial<DecisionLandingState> = {},
): DecisionLandingState => ({
  landing: [0, 0],
  surface,
  surfaceId: null,
  surfaceConfidence: 'high',
  distanceToPinYds,
  penaltyStrokeCount: surface === 'water' || surface === 'penalty' ? 1 : 0,
  requiresRelief: surface === 'water' || surface === 'penalty',
  obstruction: surface === 'deep-rough' ? 'woods-or-scrub' : 'none',
  tacticalSeverity: 0,
  ...options,
})

const close = (actual: number | null, expected: number, tolerance = 1e-6) =>
  actual != null && Math.abs(actual - expected) <= tolerance

export type NextStateValueProofResult = {
  id: string
  description: string
  expected: string
  actual: string
  passed: boolean
}

const result = (
  id: string,
  description: string,
  actual: number | null,
  expected: number,
): NextStateValueProofResult => ({
  id,
  description,
  expected: expected.toFixed(3),
  actual: actual == null ? 'null' : actual.toFixed(3),
  passed: close(actual, expected),
})

export const runNextStateValueProofs = (): NextStateValueProofResult[] => {
  const fairway200 = evaluateDecisionLandingStateValue(state('fairway', 200))
  const fairway170 = evaluateDecisionLandingStateValue(state('fairway', 170))
  const rough200 = evaluateDecisionLandingStateValue(state('rough', 200))
  const recovery180 = evaluateDecisionLandingStateValue(state('deep-rough', 180))
  const green8Feet = evaluateDecisionLandingStateValue(state('green', 8 / 3))
  const water180 = evaluateDecisionLandingStateValue(state('water', 180))
  const unknown200 = evaluateDecisionLandingStateValue(state('unknown', 200))

  const aggregateCoreState = state('fairway', 180)
  const aggregateTailState = state('deep-rough', 200)
  const aggregateRisk: DecisionRiskProfile = {
    bySurface: { fairway: 0.8, 'deep-rough': 0.2 },
    success: 0.8,
    manageable: 0,
    seriousTrouble: 0.2,
    catastrophe: 0,
    unknown: 0,
    expectedSeverity: 0.6,
    coreProbability: 0.8,
    tailProbability: 0.2,
    mishitProbability: 0.2,
    severeMishitProbability: 0,
    coreSampleCount: 1,
    tailSampleCount: 1,
    tailLandings: [{
      landing: aggregateTailState.landing,
      kind: 'deep-rough',
      tier: 'serious_trouble',
      quality: 'mishit',
      weight: 0.2,
      state: aggregateTailState,
    }],
  }
  const aggregateSamples: ModeledAimSample[] = [{
    carryLanding: aggregateCoreState.landing,
    landing: aggregateCoreState.landing,
    kind: 'fairway',
    state: aggregateCoreState,
  }]
  const aggregate = evaluateCandidateNextStateValue(aggregateSamples, aggregateRisk)

  const unknownAssumption: NextStateValueAssumption = unknown200.assumption
  return [
    result(
      'broadie-knot-200-fairway',
      'Exact published Table B.1 fairway knot is preserved.',
      fairway200.expectedStrokes,
      3.19,
    ),
    result(
      'broadie-interpolate-170-fairway',
      'Between published knots, value is deterministic linear interpolation.',
      fairway170.expectedStrokes,
      3.03,
    ),
    result(
      'rough-costs-more-than-fairway',
      'Published rough value at 200 yards is used directly.',
      rough200.expectedStrokes,
      3.42,
    ),
    result(
      'woods-map-to-recovery',
      'Deep rough / woods obstruction maps to Broadie recovery.',
      recovery180.expectedStrokes,
      3.82,
    ),
    result(
      'green-8-feet',
      'Green distance uses the separate PGA TOUR putting benchmark.',
      green8Feet.expectedStrokes,
      1.515,
    ),
    result(
      'penalty-counted-once',
      'V1 water relief adds exactly one penalty stroke to the continuation value.',
      water180.expectedStrokes,
      4.31,
    ),
    result(
      'candidate-ev-combines-core-and-tail',
      'Candidate EV combines modeled core mass and empirical mishit tail exactly once.',
      aggregate.expectedFutureStrokes,
      0.8 * 3.08 + 0.2 * 3.87,
    ),
    {
      id: 'candidate-probability-accounting',
      description: 'Core + tail probability mass must close to one before a recommendation is authoritative.',
      expected: 'valued=1.000 / unresolved=0.000',
      actual: `valued=${aggregate.valuedProbability.toFixed(3)} / unresolved=${aggregate.unresolvedProbability.toFixed(3)}`,
      passed: close(aggregate.valuedProbability, 1) && close(aggregate.unresolvedProbability, 0),
    },
    {
      id: 'unknown-is-explicitly-provisional',
      description: 'Unmapped geometry is valued conservatively without hiding the assumption.',
      expected: 'unknown-as-rough / 3.420',
      actual: `${unknownAssumption} / ${unknown200.expectedStrokes?.toFixed(3) ?? 'null'}`,
      passed: unknownAssumption === 'unknown-as-rough' && close(unknown200.expectedStrokes, 3.42),
    },
  ]
}

export const NEXT_STATE_VALUE_PROOFS = runNextStateValueProofs()
export const NEXT_STATE_VALUE_PROOFS_PASS = NEXT_STATE_VALUE_PROOFS.every((proof) => proof.passed)
