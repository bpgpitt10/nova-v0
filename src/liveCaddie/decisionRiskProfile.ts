import { classifyTacticalLandingPoint } from '../courseGeometry/tacticalClassification'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import type {
  DecisionPlayerClubModel,
  DecisionShotGoal,
  DecisionShotQuality,
} from './decisionEngine'
import type { ModeledAimSample } from './aimOutcomeSampling'

export type DecisionRiskTier =
  | 'success'
  | 'manageable'
  | 'serious_trouble'
  | 'catastrophe'
  | 'unknown'

export type DecisionRiskTailLanding = {
  landing: CoursePointYds
  kind: CourseSurfaceClassification
  tier: DecisionRiskTier
  quality: DecisionShotQuality
  /** Overall probability mass contributed by this observed tail shot. */
  weight: number
}

export type DecisionRiskProfile = {
  bySurface: Partial<Record<CourseSurfaceClassification, number>>
  success: number
  manageable: number
  seriousTrouble: number
  catastrophe: number
  unknown: number
  expectedSeverity: number
  /** Modeled normal/core probability mass. */
  coreProbability: number
  /** Empirically learned planning-excluded tail probability mass. */
  tailProbability: number
  /** Weighted frequency of classified mishit + severe_mishit shots. */
  mishitProbability: number
  /** Weighted frequency of severe_mishit shots alone. */
  severeMishitProbability: number
  coreSampleCount: number
  tailSampleCount: number
  tailLandings: DecisionRiskTailLanding[]
}

const vector = (from: CoursePointYds, to: CoursePointYds): CoursePointYds => [
  to[0] - from[0],
  to[1] - from[1],
]

const unit = (value: CoursePointYds): CoursePointYds => {
  const length = Math.hypot(value[0], value[1])
  return length > 1e-9 ? [value[0] / length, value[1] / length] : [0, 1]
}

const rightOf = (forward: CoursePointYds): CoursePointYds => [forward[1], -forward[0]]

const addScaled = (
  origin: CoursePointYds,
  forward: CoursePointYds,
  forwardYds: number,
  right: CoursePointYds,
  rightYds: number,
): CoursePointYds => [
  origin[0] + forward[0] * forwardYds + right[0] * rightYds,
  origin[1] + forward[1] * forwardYds + right[1] * rightYds,
]

/**
 * Outcome severity is intentionally separate from shot-quality labels.
 * A mishit that finishes in ordinary rough can still be manageable; a normal
 * strike that reaches water is still a catastrophe.
 */
export const decisionRiskTierForSurface = (
  kind: CourseSurfaceClassification,
  goal: DecisionShotGoal,
): DecisionRiskTier => {
  if (kind === 'unknown') return 'unknown'
  if (kind === 'water' || kind === 'penalty') return 'catastrophe'
  if (kind === 'bunker' || kind === 'deep-rough') return 'serious_trouble'

  if (goal === 'green') {
    if (kind === 'green') return 'success'
    return 'manageable'
  }

  if (kind === 'fairway' || kind === 'green') return 'success'
  return 'manageable'
}

const severityForTier = (tier: DecisionRiskTier) => {
  if (tier === 'success') return 0
  if (tier === 'manageable') return 1
  if (tier === 'serious_trouble') return 3
  if (tier === 'catastrophe') return 5
  return 2
}

type WeightedOutcome = {
  kind: CourseSurfaceClassification
  tier: DecisionRiskTier
  weight: number
}

const summarizeOutcomes = (
  outcomes: readonly WeightedOutcome[],
  metadata: Omit<
    DecisionRiskProfile,
    | 'bySurface'
    | 'success'
    | 'manageable'
    | 'seriousTrouble'
    | 'catastrophe'
    | 'unknown'
    | 'expectedSeverity'
  >,
): DecisionRiskProfile => {
  const bySurface: Partial<Record<CourseSurfaceClassification, number>> = {}
  let success = 0
  let manageable = 0
  let seriousTrouble = 0
  let catastrophe = 0
  let unknown = 0
  let expectedSeverity = 0

  outcomes.forEach((outcome) => {
    bySurface[outcome.kind] = (bySurface[outcome.kind] ?? 0) + outcome.weight
    expectedSeverity += severityForTier(outcome.tier) * outcome.weight
    if (outcome.tier === 'success') success += outcome.weight
    else if (outcome.tier === 'manageable') manageable += outcome.weight
    else if (outcome.tier === 'serious_trouble') seriousTrouble += outcome.weight
    else if (outcome.tier === 'catastrophe') catastrophe += outcome.weight
    else unknown += outcome.weight
  })

  return {
    bySurface,
    success,
    manageable,
    seriousTrouble,
    catastrophe,
    unknown,
    expectedSeverity,
    ...metadata,
  }
}

export const buildDecisionRiskProfile = ({
  hole,
  ball,
  aimPoint,
  goal,
  coreSamples,
  player,
  carryAdjustmentYds = 0,
  lateralAdjustmentYds = 0,
}: {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  aimPoint: CoursePointYds
  goal: DecisionShotGoal
  /** Same canonical core samples used by the map contours and core percentages. */
  coreSamples: readonly ModeledAimSample[]
  /** Weighted historical population used only to learn and replay the tail. */
  player: DecisionPlayerClubModel | null | undefined
  /** Current-condition translation relative to the Stock baseline. */
  carryAdjustmentYds?: number
  /** Current-condition translation relative to the Stock lateral baseline. */
  lateralAdjustmentYds?: number
}): DecisionRiskProfile => {
  const historicalSamples = player?.samples ?? []
  const totalHistoricalWeight = historicalSamples.reduce(
    (sum, sample) => sum + Math.max(0, sample.weight),
    0,
  )
  const tailSamples = historicalSamples.filter((sample) => !sample.planningEligible)
  const tailWeight = tailSamples.reduce((sum, sample) => sum + Math.max(0, sample.weight), 0)
  const tailProbability = totalHistoricalWeight > 0
    ? Math.max(0, Math.min(1, tailWeight / totalHistoricalWeight))
    : 0
  const coreProbability = 1 - tailProbability

  const mishitWeight = historicalSamples.reduce(
    (sum, sample) =>
      sample.quality === 'mishit' || sample.quality === 'severe_mishit'
        ? sum + Math.max(0, sample.weight)
        : sum,
    0,
  )
  const severeMishitWeight = historicalSamples.reduce(
    (sum, sample) =>
      sample.quality === 'severe_mishit' ? sum + Math.max(0, sample.weight) : sum,
    0,
  )
  const mishitProbability = totalHistoricalWeight > 0 ? mishitWeight / totalHistoricalWeight : 0
  const severeMishitProbability = totalHistoricalWeight > 0
    ? severeMishitWeight / totalHistoricalWeight
    : 0

  const outcomes: WeightedOutcome[] = []
  if (coreSamples.length > 0 && coreProbability > 0) {
    const coreSampleWeight = coreProbability / coreSamples.length
    coreSamples.forEach((sample) => {
      outcomes.push({
        kind: sample.kind,
        tier: decisionRiskTierForSurface(sample.kind, goal),
        weight: coreSampleWeight,
      })
    })
  }

  const tailLandings: DecisionRiskTailLanding[] = []
  if (tailWeight > 0 && tailProbability > 0) {
    const forward = unit(vector(ball, aimPoint))
    const right = rightOf(forward)

    tailSamples.forEach((sample) => {
      const carry = Math.max(0, sample.carryYds + carryAdjustmentYds)
      const offline = sample.offlineYds + lateralAdjustmentYds
      const landing = addScaled(ball, forward, carry, right, offline)
      const kind = classifyTacticalLandingPoint(hole, landing).kind
      const tier = decisionRiskTierForSurface(kind, goal)
      // Normalize inside the empirical tail, then allocate only the learned tail mass.
      const weight = (Math.max(0, sample.weight) / tailWeight) * tailProbability
      const tailLanding: DecisionRiskTailLanding = {
        landing,
        kind,
        tier,
        quality: sample.quality,
        weight,
      }
      tailLandings.push(tailLanding)
      outcomes.push({ kind, tier, weight })
    })
  }

  // If no core sample was available, preserve probability accounting rather than
  // pretending the empirical tail alone represents the whole player distribution.
  if (outcomes.length === 0) {
    return summarizeOutcomes([], {
      coreProbability,
      tailProbability,
      mishitProbability,
      severeMishitProbability,
      coreSampleCount: coreSamples.length,
      tailSampleCount: tailSamples.length,
      tailLandings,
    })
  }

  return summarizeOutcomes(outcomes, {
    coreProbability,
    tailProbability,
    mishitProbability,
    severeMishitProbability,
    coreSampleCount: coreSamples.length,
    tailSampleCount: tailSamples.length,
    tailLandings,
  })
}
