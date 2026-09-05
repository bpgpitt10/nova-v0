import type { IntelligenceModelDefinition } from '../../contracts'

export const clubConfidenceDefinition = {
  id: 'decision.club_confidence',
  name: 'Club Confidence',
  version: 'legacy-v1',
  status: 'shadow',
  purpose: 'Combine Looper performance drivers into the aggregate club trust score and caddie call.',
  question: 'How much should I trust this club as a playing option right now?',
  inputs: ['Distance Window', 'Direction Window', 'Flight Quality', 'Pattern Stability', 'Data Confidence', 'included shot count'],
  outputs: ['aggregate club score', 'caddie call', 'component score snapshot'],
  algorithmSummary: [
    'Weight the five performance drivers using the legacy component weights.',
    'If a nullable component is unavailable, remove its weight and renormalize the active components.',
    'Round the weighted aggregate to the nearest whole score.',
    'Map the score to Attack / Play / Manage / Careful / Liability, unless fewer than 4 shots are included.',
  ],
  parameters: [
    { key: 'distanceWindowWeight', label: 'Distance Window weight', description: 'Aggregate contribution from distance predictability.', defaultValue: 0.28, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'directionWindowWeight', label: 'Direction Window weight', description: 'Aggregate contribution from directional predictability.', defaultValue: 0.24, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'flightQualityWeight', label: 'Flight Quality weight', description: 'Aggregate contribution from ball-flight repeatability when available.', defaultValue: 0.16, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'patternStabilityWeight', label: 'Pattern Stability weight', description: 'Aggregate contribution from recent-vs-prior pattern drift when available.', defaultValue: 0.18, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'dataConfidenceWeight', label: 'Data Confidence weight', description: 'Aggregate contribution from evidence sufficiency.', defaultValue: 0.14, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'minimumIncludedShots', label: 'Minimum included shots', description: 'Minimum included shots before Looper emits a normal caddie call.', defaultValue: 4, editable: true, unit: 'shots', min: 1 },
  ],
  dependencies: [
    { modelId: 'performance.distance_window', relationship: 'Weighted aggregate component.' },
    { modelId: 'performance.direction_window', relationship: 'Weighted aggregate component.' },
    { modelId: 'performance.flight_quality', relationship: 'Weighted aggregate component when available.' },
    { modelId: 'performance.pattern_stability', relationship: 'Weighted aggregate component when available.' },
    { modelId: 'performance.data_confidence', relationship: 'Weighted aggregate component.' },
  ],
  downstreamConsumers: [
    { modelId: 'insight.club_review', relationship: 'Current review copy and strongest/weakest driver insights use this score and components.' },
    { modelId: 'future.caddie_recommendation', relationship: 'Future decision engine can consume club trust as an input.' },
  ],
  legacyReferences: [
    { sourcePath: 'src/lib/scoring.ts', symbol: 'summarizeReviewClub' },
    { sourcePath: 'src/lib/confidenceConfig.ts', symbol: 'confidenceConfig.componentWeights' },
    { sourcePath: 'src/lib/confidenceConfig.ts', symbol: 'confidenceConfig.caddieCalls' },
  ],
  notes: [
    'Legacy-v1 assumes the driver inputs were calculated after the user manually removed shots they considered true mishits.',
    'Automated mishit classification should initially change the upstream analysis policy, not this aggregate formula. Any later decision to score mishit frequency as execution risk should be a new algorithm/version decision.',
  ],
} satisfies IntelligenceModelDefinition
