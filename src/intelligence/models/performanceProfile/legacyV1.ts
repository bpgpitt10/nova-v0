import type { IntelligenceResult } from '../../contracts'
import type { PerformanceDriverInput } from '../../input'
import { calculateClubConfidenceLegacyV1 } from '../clubConfidence/legacyV1'
import { calculateDataConfidenceLegacyV1 } from '../dataConfidence/legacyV1'
import { calculateDirectionWindowLegacyV1 } from '../directionWindow/legacyV1'
import { calculateDistanceWindowLegacyV1 } from '../distanceWindow/legacyV1'
import { calculateFlightQualityLegacyV1 } from '../flightQuality/legacyV1'
import { calculatePatternStabilityLegacyV1 } from '../patternStability/legacyV1'

export type LegacyPerformanceProfile = {
  clubId: string
  includedShotCount: number
  drivers: {
    distanceWindow: IntelligenceResult<number>
    directionWindow: IntelligenceResult<number>
    flightQuality: IntelligenceResult<number | null>
    patternStability: IntelligenceResult<number | null>
    dataConfidence: IntelligenceResult<number>
  }
  clubConfidence: ReturnType<typeof calculateClubConfidenceLegacyV1>
}

export const calculateLegacyPerformanceProfile = (
  input: PerformanceDriverInput,
): LegacyPerformanceProfile => {
  const includedShotCount = input.shots.filter(
    (shot) => shot.included && shot.analysisWeight > 0,
  ).length

  const distanceWindow = calculateDistanceWindowLegacyV1(input)
  const directionWindow = calculateDirectionWindowLegacyV1(input)
  const flightQuality = calculateFlightQualityLegacyV1(input)
  const patternStability = calculatePatternStabilityLegacyV1(input)
  const dataConfidence = calculateDataConfidenceLegacyV1(input)

  const clubConfidence = calculateClubConfidenceLegacyV1({
    includedShotCount,
    componentScores: {
      distanceWindow: distanceWindow.value,
      directionWindow: directionWindow.value,
      flightQuality: flightQuality.value,
      patternStability: patternStability.value,
      dataConfidence: dataConfidence.value,
    },
  })

  return {
    clubId: input.clubId,
    includedShotCount,
    drivers: {
      distanceWindow,
      directionWindow,
      flightQuality,
      patternStability,
      dataConfidence,
    },
    clubConfidence,
  }
}
