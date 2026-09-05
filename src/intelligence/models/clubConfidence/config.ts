export type ClubConfidenceCall =
  | 'Attack'
  | 'Play'
  | 'Manage'
  | 'Careful'
  | 'Liability'
  | 'Insufficient Data'

export type ClubConfidenceConfig = {
  componentWeights: {
    distanceWindow: number
    directionWindow: number
    flightQuality: number
    patternStability: number
    dataConfidence: number
  }
  minimumIncludedShots: number
  calls: readonly {
    minScore: number
    label: Exclude<ClubConfidenceCall, 'Insufficient Data'>
  }[]
}

export const clubConfidenceLegacyV1Config: ClubConfidenceConfig = {
  componentWeights: {
    distanceWindow: 0.28,
    directionWindow: 0.24,
    flightQuality: 0.16,
    patternStability: 0.18,
    dataConfidence: 0.14,
  },
  minimumIncludedShots: 4,
  calls: [
    { minScore: 85, label: 'Attack' },
    { minScore: 72, label: 'Play' },
    { minScore: 58, label: 'Manage' },
    { minScore: 40, label: 'Careful' },
    { minScore: 0, label: 'Liability' },
  ],
}
