export type DataConfidenceConfig = {
  targetIncludedShots: number
  targetSessions: number
  shotEvidenceWeight: number
  sessionEvidenceWeight: number
}

export const dataConfidenceLegacyV1Config: DataConfidenceConfig = {
  targetIncludedShots: 20,
  targetSessions: 3,
  shotEvidenceWeight: 0.65,
  sessionEvidenceWeight: 0.35,
}
