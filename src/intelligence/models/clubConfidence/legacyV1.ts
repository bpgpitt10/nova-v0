import type { IntelligenceResult } from '../../contracts'
import {
  clubConfidenceLegacyV1Config,
  type ClubConfidenceCall,
  type ClubConfidenceConfig,
} from './config'

const MODEL_ID = 'decision.club_confidence'
const MODEL_VERSION = 'legacy-v1'

export type ClubConfidenceComponents = {
  distanceWindow: number
  directionWindow: number
  flightQuality: number | null
  patternStability: number | null
  dataConfidence: number
}

export type ClubConfidenceInput = {
  includedShotCount: number
  componentScores: ClubConfidenceComponents
}

export type ClubConfidenceValue = {
  score: number
  call: ClubConfidenceCall
  componentScores: ClubConfidenceComponents
}

const caddieCallForScore = (
  score: number,
  includedShotCount: number,
  config: ClubConfidenceConfig,
): ClubConfidenceCall => {
  if (includedShotCount < config.minimumIncludedShots) {
    return 'Insufficient Data'
  }
  return config.calls.find((call) => score >= call.minScore)?.label ?? 'Liability'
}

export const calculateClubConfidenceLegacyV1 = (
  input: ClubConfidenceInput,
  config: ClubConfidenceConfig = clubConfidenceLegacyV1Config,
): IntelligenceResult<ClubConfidenceValue> => {
  const weightedComponents = [
    { id: 'distanceWindow', score: input.componentScores.distanceWindow, weight: config.componentWeights.distanceWindow },
    { id: 'directionWindow', score: input.componentScores.directionWindow, weight: config.componentWeights.directionWindow },
    { id: 'flightQuality', score: input.componentScores.flightQuality, weight: config.componentWeights.flightQuality },
    { id: 'patternStability', score: input.componentScores.patternStability, weight: config.componentWeights.patternStability },
    { id: 'dataConfidence', score: input.componentScores.dataConfidence, weight: config.componentWeights.dataConfidence },
  ] as const

  const activeComponents = weightedComponents.filter(
    (component): component is typeof component & { score: number } =>
      typeof component.score === 'number',
  )
  const activeWeightTotal = activeComponents.reduce((sum, component) => sum + component.weight, 0)
  const weightedScoreTotal = activeComponents.reduce(
    (sum, component) => sum + component.score * component.weight,
    0,
  )
  const score = Math.round(activeWeightTotal > 0 ? weightedScoreTotal / activeWeightTotal : 0)
  const call = caddieCallForScore(score, input.includedShotCount, config)

  return {
    modelId: MODEL_ID,
    modelVersion: MODEL_VERSION,
    value: {
      score,
      call,
      componentScores: input.componentScores,
    },
    explanation: `${call} · aggregate score ${score}`,
    evidence: { shotCount: input.includedShotCount },
    trace: [
      {
        id: 'component-inputs',
        label: 'Performance driver inputs',
        description: 'Legacy Club Confidence consumes the five driver scores; unavailable nullable drivers are omitted.',
        values: {
          distanceWindow: input.componentScores.distanceWindow,
          directionWindow: input.componentScores.directionWindow,
          flightQuality: input.componentScores.flightQuality,
          patternStability: input.componentScores.patternStability,
          dataConfidence: input.componentScores.dataConfidence,
        },
      },
      {
        id: 'active-weights',
        label: 'Active component weights',
        description: 'Weights are renormalized across only the components that returned a numeric score.',
        values: {
          activeWeightTotal: Number(activeWeightTotal.toFixed(3)),
          weightedScoreTotal: Number(weightedScoreTotal.toFixed(3)),
          activeComponents: activeComponents.map((component) => component.id).join(', '),
        },
      },
      {
        id: 'aggregate-score',
        label: 'Aggregate club score',
        description: 'Weighted component total divided by active weight total, rounded to a whole-number score.',
        values: { score },
      },
      {
        id: 'caddie-call',
        label: 'Caddie call',
        description: 'The aggregate score maps to a legacy call unless included evidence is below the minimum-shot gate.',
        values: {
          includedShotCount: input.includedShotCount,
          minimumIncludedShots: config.minimumIncludedShots,
          call,
        },
      },
    ],
  }
}
