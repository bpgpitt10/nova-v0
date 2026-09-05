import type { IntelligenceResult } from '../../contracts'
import type { PerformanceDriverInput } from '../../input'
import { weightedAverage, weightedMedian } from '../../math/weighted'
import {
  directionWindowLegacyV1Config,
  type DirectionWindowConfig,
} from './config'

const MODEL_ID = 'performance.direction_window'
const MODEL_VERSION = 'legacy-v1'

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value))

const oneDecimal = (value: number) => Number(value.toFixed(1))

export const calculateDirectionWindowLegacyV1 = (
  input: PerformanceDriverInput,
  config: DirectionWindowConfig = directionWindowLegacyV1Config,
): IntelligenceResult<number> => {
  const offlineShots = input.shots.filter(
    (shot): shot is typeof shot & { offlineYards: number } =>
      shot.included && shot.analysisWeight > 0 && typeof shot.offlineYards === 'number',
  )

  if (offlineShots.length === 0) {
    return {
      modelId: MODEL_ID,
      modelVersion: MODEL_VERSION,
      value: 0,
      explanation: 'No offline data',
      evidence: { shotCount: 0 },
      trace: [{ id: 'offline-evidence', label: 'Offline evidence', description: 'No included positively weighted offline observations were available.' }],
    }
  }

  const offlineValues = offlineShots.map((shot) => shot.offlineYards)
  const weights = offlineShots.map((shot) => shot.analysisWeight)
  const typicalCarry = weightedMedian(
    offlineShots.map((shot) => shot.carryYards),
    weights,
  )

  if (typeof typicalCarry !== 'number') {
    return {
      modelId: MODEL_ID,
      modelVersion: MODEL_VERSION,
      value: 0,
      explanation: 'No carry reference',
      evidence: { shotCount: offlineShots.length },
      trace: [{ id: 'carry-reference', label: 'Carry reference', description: 'Weighted median carry could not be calculated for shots with offline data.' }],
    }
  }

  const targetWidth = config.targetWidthPct * typicalCarry
  if (!(targetWidth > 0)) {
    return {
      modelId: MODEL_ID,
      modelVersion: MODEL_VERSION,
      value: 0,
      explanation: 'Invalid target width',
      evidence: { shotCount: offlineShots.length },
      trace: [{ id: 'target-width', label: 'Direction target width', description: 'Target width must be positive.', values: { targetWidth } }],
    }
  }

  const planningMissThreshold = config.planningMissThresholdPctOfTargetWidth * targetWidth
  const inWindowThreshold = config.inWindowThresholdPctOfTargetWidth * targetWidth
  const zeroScoreThreshold = config.zeroScoreThresholdPctOfTargetWidth * targetWidth

  const shotScores = offlineValues.map((offline) => {
    const magnitude = Math.abs(offline)
    if (magnitude <= inWindowThreshold) return 100
    if (magnitude >= zeroScoreThreshold) return 0
    return 100 * (1 - (magnitude - inWindowThreshold) / (zeroScoreThreshold - inWindowThreshold))
  })

  const baseScore = weightedAverage(shotScores, weights) ?? 0
  const averageAbsoluteOffline = weightedAverage(
    offlineValues.map((value) => Math.abs(value)),
    weights,
  ) ?? 0

  let meaningfulLeftWeight = 0
  let meaningfulRightWeight = 0
  offlineShots.forEach((shot) => {
    if (shot.offlineYards <= -planningMissThreshold) meaningfulLeftWeight += shot.analysisWeight
    if (shot.offlineYards >= planningMissThreshold) meaningfulRightWeight += shot.analysisWeight
  })
  const totalMeaningfulMissWeight = meaningfulLeftWeight + meaningfulRightWeight

  const twoWayPenalty = totalMeaningfulMissWeight > 0
    ? (() => {
        const leftShare = meaningfulLeftWeight / totalMeaningfulMissWeight
        const rightShare = meaningfulRightWeight / totalMeaningfulMissWeight
        return clamp(config.twoWayPenaltyMultiplier * Math.min(leftShare, rightShare), 0, config.twoWayPenaltyCap)
      })()
    : 0

  const score = clamp(baseScore - twoWayPenalty)
  const sessionCount = new Set(
    offlineShots.map((shot) => shot.sessionId).filter((id): id is string => typeof id === 'string'),
  ).size

  return {
    modelId: MODEL_ID,
    modelVersion: MODEL_VERSION,
    value: score,
    explanation: twoWayPenalty > 0
      ? `Avg abs offline ${oneDecimal(averageAbsoluteOffline)} yd, two-way balance penalty ${oneDecimal(twoWayPenalty)}`
      : `Avg abs offline ${oneDecimal(averageAbsoluteOffline)} yd`,
    evidence: { shotCount: offlineShots.length, sessionCount },
    trace: [
      {
        id: 'direction-scale',
        label: 'Direction scale',
        description: 'Typical carry sizes the target width and all downstream directional thresholds.',
        values: { typicalCarry: oneDecimal(typicalCarry), targetWidth: oneDecimal(targetWidth), inWindowThreshold: oneDecimal(inWindowThreshold), planningMissThreshold: oneDecimal(planningMissThreshold), zeroScoreThreshold: oneDecimal(zeroScoreThreshold) },
      },
      {
        id: 'base-direction-score',
        label: 'Base direction score',
        description: 'Each offline result is linearly scored from the full-score window to the zero-score threshold.',
        values: { baseScore: oneDecimal(baseScore), averageAbsoluteOffline: oneDecimal(averageAbsoluteOffline) },
      },
      {
        id: 'two-way-balance',
        label: 'Two-way miss balance',
        description: 'Meaningful misses on both sides create a penalty based on the minority side share.',
        values: { meaningfulLeftWeight: Number(meaningfulLeftWeight.toFixed(3)), meaningfulRightWeight: Number(meaningfulRightWeight.toFixed(3)), twoWayPenalty: oneDecimal(twoWayPenalty) },
      },
      {
        id: 'direction-result',
        label: 'Direction Window score',
        description: 'The two-way penalty is subtracted from the weighted base score.',
        values: { finalScore: oneDecimal(score) },
      },
    ],
  }
}
