import type { IntelligenceModelDefinition } from '../../contracts'

export const dataConfidenceDefinition = {
  id: 'performance.data_confidence',
  name: 'Data Confidence',
  version: 'legacy-v1',
  status: 'shadow',
  purpose: 'Measure whether Looper has enough eligible evidence to trust the club read.',
  question: 'Do we have enough shots and sessions to trust the rest of the model?',
  inputs: ['included club shots', 'distinct session count'],
  outputs: ['data confidence score (0-100)', 'evidence count explanation'],
  algorithmSummary: [
    'Score eligible shot count against a 20-shot target, capped at 100.',
    'Score distinct session count against a 3-session target, capped at 100.',
    'Blend shot evidence at 65% and session evidence at 35%.',
  ],
  parameters: [
    { key: 'targetIncludedShots', label: 'Target included shots', description: 'Included shots required for full shot-evidence credit.', defaultValue: 20, editable: true, unit: 'shots', min: 1 },
    { key: 'targetSessions', label: 'Target sessions', description: 'Distinct sessions required for full session-evidence credit.', defaultValue: 3, editable: true, unit: 'sessions', min: 1 },
    { key: 'shotEvidenceWeight', label: 'Shot evidence weight', description: 'Contribution from included shot count.', defaultValue: 0.65, editable: true, unit: 'ratio', min: 0, max: 1 },
    { key: 'sessionEvidenceWeight', label: 'Session evidence weight', description: 'Contribution from distinct session count.', defaultValue: 0.35, editable: true, unit: 'ratio', min: 0, max: 1 },
  ],
  dependencies: [
    { modelId: 'analysis.eligibility', relationship: 'Determines the evidence set being counted.' },
  ],
  downstreamConsumers: [
    { modelId: 'decision.club_confidence', relationship: 'Weighted component of the aggregate club score.' },
  ],
  legacyReferences: [
    { sourcePath: 'src/lib/scoring.ts', symbol: 'buildDataConfidenceScore' },
    { sourcePath: 'src/lib/confidenceConfig.ts', symbol: 'confidenceConfig.dataConfidence' },
  ],
  notes: [
    'This model is about evidence sufficiency, not shot quality.',
    'confidenceConfig.dataConfidence.missingRequiredFieldPenalty is not consumed by the current buildDataConfidenceScore implementation and is not treated as an active legacy-v1 parameter.',
  ],
} satisfies IntelligenceModelDefinition
