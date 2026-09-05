import type { IntelligenceResult } from '../../contracts'
import type { PerformanceDriverInput } from '../../input'
import {
  dataConfidenceLegacyV1Config,
  type DataConfidenceConfig,
} from './config'

const MODEL_ID = 'performance.data_confidence'
const MODEL_VERSION = 'legacy-v1'

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value))

export const calculateDataConfidenceLegacyV1 = (
  input: PerformanceDriverInput,
  config: DataConfidenceConfig = dataConfidenceLegacyV1Config,
): IntelligenceResult<number> => {
  const includedShots = input.shots.filter(
    (shot) => shot.included && shot.analysisWeight > 0,
  )
  const distinctSessionCount = new Set(
    includedShots
      .map((shot) => shot.sessionId)
      .filter((sessionId): sessionId is string => typeof sessionId === 'string'),
  ).size

  const includedShotScore = clamp(
    (includedShots.length / config.targetIncludedShots) * 100,
  )
  const sessionScore = clamp(
    (distinctSessionCount / config.targetSessions) * 100,
  )
  const score = clamp(
    Math.round(
      includedShotScore * config.shotEvidenceWeight +
        sessionScore * config.sessionEvidenceWeight,
    ),
  )

  return {
    modelId: MODEL_ID,
    modelVersion: MODEL_VERSION,
    value: score,
    explanation: `${includedShots.length} eligible shots across ${distinctSessionCount} sessions`,
    evidence: {
      shotCount: includedShots.length,
      sessionCount: distinctSessionCount,
    },
    trace: [
      {
        id: 'shot-evidence',
        label: 'Shot evidence',
        description: 'Included shot count is scored against the legacy target.',
        values: {
          includedShots: includedShots.length,
          targetIncludedShots: config.targetIncludedShots,
          shotEvidenceScore: Math.round(includedShotScore),
        },
      },
      {
        id: 'session-evidence',
        label: 'Session evidence',
        description: 'Distinct session count is scored against the legacy target.',
        values: {
          distinctSessions: distinctSessionCount,
          targetSessions: config.targetSessions,
          sessionEvidenceScore: Math.round(sessionScore),
        },
      },
      {
        id: 'data-confidence-blend',
        label: 'Data Confidence score',
        description: 'Shot and session evidence are blended using the legacy weights.',
        values: {
          shotEvidenceWeight: config.shotEvidenceWeight,
          sessionEvidenceWeight: config.sessionEvidenceWeight,
          finalScore: score,
        },
      },
    ],
  }
}
