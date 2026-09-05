import { clubConfidenceDefinition } from './clubConfidence/definition'
import { dataConfidenceDefinition } from './dataConfidence/definition'
import { directionWindowDefinition } from './directionWindow/definition'
import { distanceWindowDefinition } from './distanceWindow/definition'
import { flightQualityDefinition } from './flightQuality/definition'
import { patternStabilityDefinition } from './patternStability/definition'

export const intelligenceModelDefinitions = [
  distanceWindowDefinition,
  directionWindowDefinition,
  flightQualityDefinition,
  patternStabilityDefinition,
  dataConfidenceDefinition,
  clubConfidenceDefinition,
] as const
