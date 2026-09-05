import type { IntelligenceModelDefinition } from '../../contracts'

export const directionWindowDefinition = {
  id: 'performance.direction_window',
  name: 'Direction Window',
  version: 'legacy-v1',
  status: 'shadow',
  purpose: 'Measure how tightly a club finishes around the target line and penalize meaningful two-way misses.',
  question: 'How predictable is this club laterally?',
  inputs: ['included club shots', 'carry yards', 'offline yards', 'session analysis weight'],
  outputs: ['direction window score (0-100)', 'average absolute offline and two-way-miss explanation'],
  algorithmSummary: [
    'Establish typical carry with a weighted median and size the directional target width as 15% of carry.',
    'Score each shot from 100 inside half the target width to zero at one-and-a-half target widths.',
    'Calculate meaningful left and right miss weight using half the target width as the planning-miss threshold.',
    'Apply a two-way penalty based on the minority share of meaningful misses, capped at 16 points.',
  ],
  parameters: [
    { key: 'targetWidthPct', label: 'Target width', description: 'Directional target width as a percentage of typical carry.', defaultValue: 0.15, editable: true, unit: 'ratio', min: 0 },
    { key: 'planningMissThresholdPctOfTargetWidth', label: 'Meaningful miss threshold', description: 'Share of target width required for a miss to count toward two-way balance.', defaultValue: 0.5, editable: true, unit: 'ratio', min: 0 },
    { key: 'inWindowThresholdPctOfTargetWidth', label: 'Full-score width', description: 'Share of target width inside which a shot scores 100.', defaultValue: 0.5, editable: true, unit: 'ratio', min: 0 },
    { key: 'zeroScoreThresholdPctOfTargetWidth', label: 'Zero-score width', description: 'Share of target width at which a shot reaches zero.', defaultValue: 1.5, editable: true, unit: 'ratio', min: 0 },
    { key: 'twoWayPenaltyMultiplier', label: 'Two-way penalty multiplier', description: 'Penalty points per minority-share unit among meaningful left/right misses.', defaultValue: 40, editable: true, min: 0 },
    { key: 'twoWayPenaltyCap', label: 'Two-way penalty cap', description: 'Maximum two-way directional penalty.', defaultValue: 16, editable: true, unit: 'points', min: 0 },
  ],
  dependencies: [
    { modelId: 'analysis.eligibility', relationship: 'Determines which shots participate.' },
    { modelId: 'analysis.session_recency_weight', relationship: 'Weights shot outcomes and miss balance.' },
  ],
  downstreamConsumers: [
    { modelId: 'performance.pattern_stability', relationship: 'Legacy Pattern Stability borrows the target-width assumption.' },
    { modelId: 'decision.club_confidence', relationship: 'Weighted component of the aggregate club score.' },
  ],
  legacyReferences: [
    { sourcePath: 'src/lib/scoring.ts', symbol: 'buildDirectionScore' },
    { sourcePath: 'src/lib/confidenceConfig.ts', symbol: 'confidenceConfig.directionWindow' },
  ],
  notes: [
    'This shadow definition preserves current behavior before mishit automation. The legacy model assumed users manually removed true mishits from analysis.',
    'Legacy config also contains club-specific target widths and other directional fields that buildDirectionScore does not consume; they are not active legacy-v1 parameters here.',
  ],
} satisfies IntelligenceModelDefinition
