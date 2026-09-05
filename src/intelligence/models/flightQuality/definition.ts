import type { IntelligenceModelDefinition } from '../../contracts'

export const flightQualityDefinition = {
  id: 'performance.flight_quality',
  name: 'Flight Quality',
  version: 'legacy-v1',
  status: 'shadow',
  purpose: 'Measure how repeatable the club\'s launch, spin, descent, and spin-axis profile is.',
  question: 'Is this club producing a repeatable ball-flight pattern?',
  inputs: ['included club shots', 'launch angle', 'total spin', 'descent angle', 'spin axis', 'session analysis weight'],
  outputs: ['flight quality score (0-100 or null)', 'field availability explanation'],
  algorithmSummary: [
    'For each available flight field, calculate a weighted median center and weighted mean absolute deviation.',
    'Normalize field deviation by the field center (with legacy denominator floors).',
    'Convert relative deviation to a 0-100 repeatability score.',
    'Blend available fields using legacy weights and renormalize when fields are missing.',
    'Require at least 8 shots with any flight-profile data and at least 2 scored fields; apply a missing-field availability adjustment.',
  ],
  parameters: [
    { key: 'descentWeight', label: 'Descent weight', description: 'Legacy base contribution of descent repeatability.', defaultValue: 0.35, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'spinWeight', label: 'Spin weight', description: 'Legacy base contribution of total-spin repeatability.', defaultValue: 0.3, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'spinAxisWeight', label: 'Spin-axis weight', description: 'Legacy base contribution of spin-axis repeatability.', defaultValue: 0.2, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'launchWeight', label: 'Launch weight', description: 'Legacy base contribution of launch repeatability.', defaultValue: 0.15, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'minimumQualifiedShots', label: 'Minimum qualified shots', description: 'Minimum shots containing at least one flight field.', defaultValue: 8, editable: true, unit: 'shots', min: 1 },
    { key: 'minimumCoreFields', label: 'Minimum scored fields', description: 'Minimum distinct flight fields required to return a score.', defaultValue: 2, editable: true, unit: 'fields', min: 1, max: 4 },
  ],
  dependencies: [
    { modelId: 'analysis.eligibility', relationship: 'Determines which shots participate.' },
    { modelId: 'analysis.session_recency_weight', relationship: 'Weights field centers and deviations.' },
  ],
  downstreamConsumers: [
    { modelId: 'decision.club_confidence', relationship: 'Weighted component of the aggregate club score when available.' },
  ],
  legacyReferences: [
    { sourcePath: 'src/lib/scoring.ts', symbol: 'buildFlightQualityScore' },
    { sourcePath: 'src/lib/confidenceConfig.ts', symbol: 'confidenceConfig.flightQuality' },
  ],
  notes: [
    'This shadow definition preserves current behavior before mishit automation. The legacy model assumed users manually removed true mishits from analysis.',
    'The currently active field weights, evidence thresholds, denominator floors, and availability penalties are hard-coded in scoring.ts rather than confidenceConfig.flightQuality.',
    'The range and missing-field settings currently stored under confidenceConfig.flightQuality are not consumed by buildFlightQualityScore and are not treated as active legacy-v1 assumptions.',
  ],
} satisfies IntelligenceModelDefinition
