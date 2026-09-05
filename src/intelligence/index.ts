export type {
  IntelligenceDependency,
  IntelligenceEvidence,
  IntelligenceLegacyReference,
  IntelligenceModelDefinition,
  IntelligenceModelStatus,
  IntelligenceParameterDefinition,
  IntelligenceParameterValue,
  IntelligenceResult,
  IntelligenceTraceStep,
  IntelligenceTraceValue,
} from './contracts'

export type {
  IntelligenceAnalysisDataset,
  IntelligenceAnalysisPolicyId,
  IntelligenceClubId,
  IntelligenceSession,
  IntelligenceShot,
  IntelligenceShotRank,
  PatternStabilityInput,
  PatternStabilityInputShot,
  PerformanceDriverInput,
  PerformanceDriverInputShot,
} from './input'

export {
  getDownstreamConsumers,
  getIntelligenceModel,
  listIntelligenceModels,
} from './registry'

export {
  buildLegacySavedHistoryDataset,
  LEGACY_MANUAL_CLEANUP_POLICY_ID,
  patternStabilityInputFromDataset,
  performanceDriverInputFromDataset,
} from './adapters/legacySavedHistory'

export { distanceWindowLegacyV1Config } from './models/distanceWindow/config'
export { distanceWindowDefinition } from './models/distanceWindow/definition'
export { calculateDistanceWindowLegacyV1 } from './models/distanceWindow/legacyV1'

export { directionWindowLegacyV1Config } from './models/directionWindow/config'
export { directionWindowDefinition } from './models/directionWindow/definition'
export { calculateDirectionWindowLegacyV1 } from './models/directionWindow/legacyV1'

export { flightQualityLegacyV1Config } from './models/flightQuality/config'
export { flightQualityDefinition } from './models/flightQuality/definition'
export { calculateFlightQualityLegacyV1 } from './models/flightQuality/legacyV1'

export {
  patternStabilityLegacyV1Config,
  type PatternStabilityConfig,
} from './models/patternStability/config'
export { patternStabilityDefinition } from './models/patternStability/definition'
export { calculatePatternStabilityLegacyV1 } from './models/patternStability/legacyV1'

export { dataConfidenceLegacyV1Config } from './models/dataConfidence/config'
export { dataConfidenceDefinition } from './models/dataConfidence/definition'
export { calculateDataConfidenceLegacyV1 } from './models/dataConfidence/legacyV1'

export { clubConfidenceLegacyV1Config } from './models/clubConfidence/config'
export { clubConfidenceDefinition } from './models/clubConfidence/definition'
export {
  calculateClubConfidenceLegacyV1,
  type ClubConfidenceComponents,
  type ClubConfidenceInput,
  type ClubConfidenceValue,
} from './models/clubConfidence/legacyV1'

export {
  calculateLegacyPerformanceProfile,
  type LegacyPerformanceProfile,
} from './models/performanceProfile/legacyV1'

export { comparePatternStabilityFixture } from './parity/patternStabilityParity'
export { comparePerformanceProfileFixture } from './parity/performanceProfileParity'
