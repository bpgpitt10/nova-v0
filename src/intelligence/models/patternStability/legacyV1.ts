import type { IntelligenceResult } from '../../contracts'
import type { PatternStabilityInput } from '../../input'
import { weightedAverage, weightedMedian } from '../../math/weighted'
import {
  patternStabilityLegacyV1Config,
  type PatternStabilityConfig,
} from './config'

const MODEL_ID = 'performance.pattern_stability'
const MODEL_VERSION = 'legacy-v1'

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value))

const oneDecimal = (value: number) => Number(value.toFixed(1))

const timestampMs = (value: string | null) => {
  if (!value) {
    return undefined
  }
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : undefined
}

const unavailableResult = (
  explanation: string,
  shotCount: number,
  sessionCount: number,
  trace: IntelligenceResult<number | null>['trace'],
): IntelligenceResult<number | null> => ({
  modelId: MODEL_ID,
  modelVersion: MODEL_VERSION,
  value: null,
  explanation,
  evidence: {
    shotCount,
    sessionCount,
    warnings: [explanation],
  },
  trace,
})

export const calculatePatternStabilityLegacyV1 = (
  input: PatternStabilityInput,
  config: PatternStabilityConfig = patternStabilityLegacyV1Config,
): IntelligenceResult<number | null> => {
  const carryValues = input.shots.map((shot) => shot.carryYards)
  const carryWeights = input.shots.map((shot) => shot.analysisWeight)
  const typicalCarry = weightedMedian(carryValues, carryWeights)

  if (typeof typicalCarry !== 'number') {
    return unavailableResult('No carry reference', 0, 0, [
      {
        id: 'carry-reference',
        label: 'Carry reference',
        description: 'No positively weighted carry observations were available.',
      },
    ])
  }

  const targetWidth = config.directionTargetWidthPct * typicalCarry
  if (!(targetWidth > 0)) {
    return unavailableResult('Invalid target width', 0, 0, [
      {
        id: 'carry-reference',
        label: 'Carry reference',
        description: 'Weighted median carry establishes the scale for drift tolerances.',
        values: { typicalCarry },
      },
      {
        id: 'target-width',
        label: 'Direction target width',
        description: 'Legacy Pattern Stability borrows the Direction Window target width.',
        values: {
          directionTargetWidthPct: config.directionTargetWidthPct,
          targetWidth,
        },
      },
    ])
  }

  const carryDriftTolerance = Math.max(
    config.carryDriftToleranceFloorYards,
    config.carryDriftTolerancePct * typicalCarry,
  )
  const offlineDriftTolerance =
    config.offlineToleranceTargetWidthMultiplier * targetWidth

  const usableShots = input.shots
    .map((shot) => {
      const capturedAt = timestampMs(shot.capturedAt)
      if (
        !shot.included ||
        typeof shot.carryYards !== 'number' ||
        !Number.isFinite(shot.carryYards) ||
        typeof shot.offlineYards !== 'number' ||
        !Number.isFinite(shot.offlineYards) ||
        !(shot.analysisWeight > 0) ||
        typeof capturedAt !== 'number'
      ) {
        return null
      }

      return {
        ...shot,
        capturedAtMs: capturedAt,
      }
    })
    .filter((shot): shot is NonNullable<typeof shot> => shot !== null)
    .sort((left, right) => right.capturedAtMs - left.capturedAtMs)

  const distinctSessionCount = new Set(
    usableShots
      .map((shot) => shot.sessionId)
      .filter((sessionId): sessionId is string => typeof sessionId === 'string'),
  ).size

  const setupTrace = [
    {
      id: 'carry-reference',
      label: 'Carry reference',
      description: 'Weighted median carry establishes the scale for drift tolerances.',
      values: { typicalCarry: oneDecimal(typicalCarry) },
    },
    {
      id: 'drift-tolerances',
      label: 'Drift tolerances',
      description: 'Carry and offline center drift are each scored against their legacy tolerances.',
      values: {
        carryDriftTolerance: oneDecimal(carryDriftTolerance),
        offlineDriftTolerance: oneDecimal(offlineDriftTolerance),
        targetWidth: oneDecimal(targetWidth),
      },
    },
    {
      id: 'usable-evidence',
      label: 'Usable evidence',
      description: 'Pattern Stability requires included, timestamped, positively weighted shots with both carry and offline values.',
      values: {
        usableShots: usableShots.length,
        distinctSessions: distinctSessionCount,
      },
    },
  ] as const

  if (usableShots.length < config.totalUsableMinShots) {
    return unavailableResult(
      `Need at least ${config.totalUsableMinShots} usable carry/offline shots for rolling pattern trend`,
      usableShots.length,
      distinctSessionCount,
      setupTrace,
    )
  }

  if (distinctSessionCount < config.minDistinctSessions) {
    return unavailableResult(
      `Need at least ${config.minDistinctSessions} sessions for rolling pattern trend`,
      usableShots.length,
      distinctSessionCount,
      setupTrace,
    )
  }

  const recentCount = Math.min(
    config.recentWindowTargetShots,
    usableShots.length - config.priorBaselineMinShots,
  )

  if (recentCount < config.recentWindowMinShots) {
    return unavailableResult(
      `Need at least ${config.recentWindowMinShots} recent and ${config.priorBaselineMinShots} prior usable shots for rolling pattern trend`,
      usableShots.length,
      distinctSessionCount,
      setupTrace,
    )
  }

  const recentGroup = usableShots.slice(0, recentCount)
  const priorGroup = usableShots.slice(recentCount)

  if (
    recentGroup.length < config.recentWindowMinShots ||
    priorGroup.length < config.priorBaselineMinShots
  ) {
    return unavailableResult(
      `Need at least ${config.recentWindowMinShots} recent and ${config.priorBaselineMinShots} prior usable shots for rolling pattern trend`,
      usableShots.length,
      distinctSessionCount,
      setupTrace,
    )
  }

  const recentCarryCenter = weightedAverage(
    recentGroup.map((shot) => shot.carryYards),
    recentGroup.map((shot) => shot.analysisWeight),
  )
  const recentOfflineCenter = weightedAverage(
    recentGroup.map((shot) => shot.offlineYards),
    recentGroup.map((shot) => shot.analysisWeight),
  )
  const priorCarryCenter = weightedAverage(
    priorGroup.map((shot) => shot.carryYards),
    priorGroup.map((shot) => shot.analysisWeight),
  )
  const priorOfflineCenter = weightedAverage(
    priorGroup.map((shot) => shot.offlineYards),
    priorGroup.map((shot) => shot.analysisWeight),
  )

  if (
    typeof recentCarryCenter !== 'number' ||
    typeof recentOfflineCenter !== 'number' ||
    typeof priorCarryCenter !== 'number' ||
    typeof priorOfflineCenter !== 'number'
  ) {
    return unavailableResult(
      'Insufficient drift centers',
      usableShots.length,
      distinctSessionCount,
      setupTrace,
    )
  }

  const carryDrift = Math.abs(recentCarryCenter - priorCarryCenter)
  const offlineDrift = Math.abs(recentOfflineCenter - priorOfflineCenter)
  const carryDriftScore = clamp(100 - (100 * carryDrift) / carryDriftTolerance)
  const offlineDriftScore = clamp(100 - (100 * offlineDrift) / offlineDriftTolerance)
  const rawPatternStability = clamp(
    Math.round(
      config.carryDriftWeight * carryDriftScore +
        config.offlineDriftWeight * offlineDriftScore,
    ),
  )
  const evidenceScale = Math.min(
    1,
    recentGroup.length / config.fullEvidenceShotsPerWindow,
    priorGroup.length / config.fullEvidenceShotsPerWindow,
  )
  const patternStability = clamp(
    Math.round(
      config.evidenceAnchorScore +
        (rawPatternStability - config.evidenceAnchorScore) * evidenceScale,
    ),
  )

  return {
    modelId: MODEL_ID,
    modelVersion: MODEL_VERSION,
    value: patternStability,
    explanation: `Recent window drift: carry ${oneDecimal(carryDrift)} yd, offline ${oneDecimal(offlineDrift)} yd`,
    evidence: {
      shotCount: usableShots.length,
      sessionCount: distinctSessionCount,
    },
    trace: [
      ...setupTrace,
      {
        id: 'window-split',
        label: 'Recent vs prior windows',
        description: 'Newest usable shots form the recent window; all remaining usable shots form the prior baseline.',
        values: {
          recentShots: recentGroup.length,
          priorShots: priorGroup.length,
        },
      },
      {
        id: 'centers',
        label: 'Weighted centers',
        description: 'Recency-weighted carry and offline centers are calculated independently for each window.',
        values: {
          recentCarryCenter: oneDecimal(recentCarryCenter),
          priorCarryCenter: oneDecimal(priorCarryCenter),
          recentOfflineCenter: oneDecimal(recentOfflineCenter),
          priorOfflineCenter: oneDecimal(priorOfflineCenter),
        },
      },
      {
        id: 'drift-scores',
        label: 'Drift scores',
        description: 'Each center drift is linearly converted to a 0-100 score against its tolerance.',
        values: {
          carryDrift: oneDecimal(carryDrift),
          offlineDrift: oneDecimal(offlineDrift),
          carryDriftScore: oneDecimal(carryDriftScore),
          offlineDriftScore: oneDecimal(offlineDriftScore),
        },
      },
      {
        id: 'raw-blend',
        label: 'Raw Pattern Stability',
        description: 'Legacy-v1 blends carry and offline drift scores using the configured weights.',
        values: {
          carryDriftWeight: config.carryDriftWeight,
          offlineDriftWeight: config.offlineDriftWeight,
          rawPatternStability,
        },
      },
      {
        id: 'evidence-shrinkage',
        label: 'Evidence adjustment',
        description: 'Low-evidence results are shrunk toward the neutral anchor until both windows reach the full-evidence shot count.',
        values: {
          evidenceScale: Number(evidenceScale.toFixed(3)),
          evidenceAnchorScore: config.evidenceAnchorScore,
          finalPatternStability: patternStability,
        },
      },
    ],
  }
}
