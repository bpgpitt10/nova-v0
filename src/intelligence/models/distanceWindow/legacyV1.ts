import type { IntelligenceResult } from '../../contracts'
import type { PerformanceDriverInput } from '../../input'
import { weightedAverage, weightedMedian, weightedPercentile } from '../../math/weighted'
import {
  distanceWindowLegacyV1Config,
  type DistanceWindowConfig,
} from './config'

const MODEL_ID = 'performance.distance_window'
const MODEL_VERSION = 'legacy-v1'

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value))

const oneDecimal = (value: number) => Number(value.toFixed(1))

const normalizeShotRank = (value: number | string | null) => {
  if (value === null) return undefined
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.trunc(value)) : undefined
  }
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '')
  return normalized || undefined
}

const rankWeight = (value: number | string | null, config: DistanceWindowConfig) => {
  const normalized = normalizeShotRank(value)
  return normalized ? config.rankWeights[normalized] ?? 1 : 1
}

export const calculateDistanceWindowLegacyV1 = (
  input: PerformanceDriverInput,
  config: DistanceWindowConfig = distanceWindowLegacyV1Config,
): IntelligenceResult<number> => {
  const includedShots = input.shots.filter(
    (shot) => shot.included && shot.analysisWeight > 0,
  )
  const carryShots = includedShots.filter(
    (shot): shot is typeof shot & { carryYards: number } =>
      typeof shot.carryYards === 'number',
  )

  if (carryShots.length === 0) {
    return {
      modelId: MODEL_ID,
      modelVersion: MODEL_VERSION,
      value: 0,
      explanation: 'No carry data',
      evidence: { shotCount: 0 },
      trace: [{ id: 'carry-evidence', label: 'Carry evidence', description: 'No included positively weighted carry observations were available.' }],
    }
  }

  const carryValues = carryShots.map((shot) => shot.carryYards)
  const carryWeights = carryShots.map(
    (shot) => shot.analysisWeight * rankWeight(shot.shotRank, config),
  )
  const typicalCarry = weightedMedian(carryValues, carryWeights)

  if (typeof typicalCarry !== 'number') {
    return {
      modelId: MODEL_ID,
      modelVersion: MODEL_VERSION,
      value: 0,
      explanation: 'No carry anchor',
      evidence: { shotCount: carryShots.length },
      trace: [{ id: 'carry-anchor', label: 'Carry anchor', description: 'Rank-adjusted weighted median carry could not be calculated.' }],
    }
  }

  const inWindowThreshold = Math.max(
    config.inWindowThresholdFloorYards,
    config.inWindowThresholdPct * typicalCarry,
  )
  const zeroScoreThreshold = Math.max(
    config.zeroScoreThresholdFloorYards,
    config.zeroScoreThresholdPct * typicalCarry,
  )

  const shotDistanceScores = carryValues.map((carry) => {
    const carryGap = Math.abs(carry - typicalCarry)
    if (carryGap <= inWindowThreshold) return 100
    if (carryGap >= zeroScoreThreshold) return 0
    return 100 * (1 - (carryGap - inWindowThreshold) / (zeroScoreThreshold - inWindowThreshold))
  })
  const windowScore = weightedAverage(shotDistanceScores, carryWeights) ?? 0
  const lowerCarry = weightedPercentile(carryValues, carryWeights, config.spreadLowerPercentile)
  const upperCarry = weightedPercentile(carryValues, carryWeights, config.spreadUpperPercentile)

  if (typeof lowerCarry !== 'number' || typeof upperCarry !== 'number') {
    return {
      modelId: MODEL_ID,
      modelVersion: MODEL_VERSION,
      value: 0,
      explanation: 'No carry spread',
      evidence: { shotCount: carryShots.length },
      trace: [{ id: 'carry-spread', label: 'Carry spread', description: 'Weighted carry percentiles could not be calculated.' }],
    }
  }

  const carrySpread = Math.max(0, upperCarry - lowerCarry)
  const eliteSpread = Math.max(config.spreadEliteFloorYards, config.spreadElitePct * typicalCarry)
  const goodSpread = Math.max(config.spreadGoodFloorYards, config.spreadGoodPct * typicalCarry)
  const zeroSpread = Math.max(config.spreadZeroFloorYards, config.spreadZeroPct * typicalCarry)
  const spreadScore = (() => {
    if (carrySpread <= eliteSpread) return 100
    if (carrySpread <= goodSpread) {
      return 100 - (20 * (carrySpread - eliteSpread)) / (goodSpread - eliteSpread)
    }
    if (carrySpread >= zeroSpread) return 0
    return 80 * (1 - (carrySpread - goodSpread) / (zeroSpread - goodSpread))
  })()

  const score = clamp(
    Math.round(windowScore * config.windowScoreWeight + spreadScore * config.spreadScoreWeight),
  )

  return {
    modelId: MODEL_ID,
    modelVersion: MODEL_VERSION,
    value: score,
    explanation: `Anchor ${oneDecimal(typicalCarry)} yd, carry band P${config.spreadUpperPercentile}-P${config.spreadLowerPercentile} ${oneDecimal(carrySpread)} yd`,
    evidence: {
      shotCount: carryShots.length,
      sessionCount: new Set(carryShots.map((shot) => shot.sessionId).filter((id): id is string => typeof id === 'string')).size,
    },
    trace: [
      {
        id: 'carry-anchor',
        label: 'Carry anchor',
        description: 'Shot-rank-adjusted weighted median carry is the center of the distance window.',
        values: { typicalCarry: oneDecimal(typicalCarry), carryShots: carryShots.length },
      },
      {
        id: 'window-thresholds',
        label: 'Per-shot thresholds',
        description: 'Carry gaps inside the first threshold score 100; gaps at or beyond the second score zero.',
        values: { inWindowThreshold: oneDecimal(inWindowThreshold), zeroScoreThreshold: oneDecimal(zeroScoreThreshold), windowScore: oneDecimal(windowScore) },
      },
      {
        id: 'spread-score',
        label: 'Carry spread',
        description: 'Weighted percentile spread is mapped against elite, good, and zero-score spread thresholds.',
        values: { lowerCarry: oneDecimal(lowerCarry), upperCarry: oneDecimal(upperCarry), carrySpread: oneDecimal(carrySpread), eliteSpread: oneDecimal(eliteSpread), goodSpread: oneDecimal(goodSpread), zeroSpread: oneDecimal(zeroSpread), spreadScore: oneDecimal(spreadScore) },
      },
      {
        id: 'distance-blend',
        label: 'Distance Window score',
        description: 'Legacy-v1 blends the per-shot window score with the spread score.',
        values: { windowScoreWeight: config.windowScoreWeight, spreadScoreWeight: config.spreadScoreWeight, finalScore: score },
      },
    ],
  }
}
