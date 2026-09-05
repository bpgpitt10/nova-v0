import type { IntelligenceModelDefinition } from '../../contracts'

export const distanceWindowDefinition = {
  id: 'performance.distance_window',
  name: 'Distance Window',
  version: 'legacy-v1',
  status: 'shadow',
  purpose: 'Measure how tightly a club produces carry outcomes around its typical carry.',
  question: 'How predictable is this club in carry distance?',
  inputs: ['included club shots', 'carry yards', 'session analysis weight', 'shot rank'],
  outputs: ['distance window score (0-100)', 'carry anchor and spread explanation'],
  algorithmSummary: [
    'Use rank-adjusted session weights to establish typical carry with a weighted median.',
    'Score each carry by its distance from the carry anchor using an in-window and zero-score threshold.',
    'Measure weighted P90-P10 carry spread and map that spread onto a 0-100 score.',
    'Blend per-shot window control at 25% and carry spread at 75%.',
  ],
  parameters: [
    { key: 'inWindowThresholdPct', label: 'In-window carry tolerance', description: 'Percent of typical carry considered fully in-window before the floor.', defaultValue: 0.015, editable: true, unit: 'ratio', min: 0 },
    { key: 'inWindowThresholdFloorYards', label: 'In-window floor', description: 'Minimum fully in-window carry tolerance.', defaultValue: 2, editable: true, unit: 'yards', min: 0 },
    { key: 'zeroScoreThresholdPct', label: 'Zero-score carry gap', description: 'Percent carry gap that reaches zero before the floor.', defaultValue: 0.12, editable: true, unit: 'ratio', min: 0 },
    { key: 'zeroScoreThresholdFloorYards', label: 'Zero-score floor', description: 'Minimum carry gap that reaches zero.', defaultValue: 24, editable: true, unit: 'yards', min: 0 },
    { key: 'windowScoreWeight', label: 'Window score weight', description: 'Contribution from per-shot carry gaps.', defaultValue: 0.25, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'spreadScoreWeight', label: 'Spread score weight', description: 'Contribution from weighted carry spread.', defaultValue: 0.75, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'spreadLowerPercentile', label: 'Spread lower percentile', description: 'Lower bound of carry spread.', defaultValue: 10, editable: true, unit: 'percentile', min: 0, max: 100 },
    { key: 'spreadUpperPercentile', label: 'Spread upper percentile', description: 'Upper bound of carry spread.', defaultValue: 90, editable: true, unit: 'percentile', min: 0, max: 100 },
  ],
  dependencies: [
    { modelId: 'analysis.eligibility', relationship: 'Determines which shots participate.' },
    { modelId: 'analysis.session_recency_weight', relationship: 'Provides base shot weighting.' },
    { modelId: 'classification.shot_rank', relationship: 'Adjusts carry weights by OpenGolfCoach rank.' },
  ],
  downstreamConsumers: [
    { modelId: 'decision.club_confidence', relationship: 'Weighted component of the aggregate club score.' },
  ],
  legacyReferences: [
    { sourcePath: 'src/lib/scoring.ts', symbol: 'buildDistanceScore' },
    { sourcePath: 'src/lib/confidenceConfig.ts', symbol: 'confidenceConfig.distanceWindow' },
    { sourcePath: 'src/lib/shotRank.ts', symbol: 'shotRankWeight' },
  ],
  notes: [
    'This shadow definition preserves current behavior before mishit automation. The legacy model assumed users manually removed true mishits from analysis.',
    'Several older distanceWindow config fields are not consumed by buildDistanceScore and are intentionally not treated as active legacy-v1 parameters here.',
  ],
} satisfies IntelligenceModelDefinition
