export type IntelligenceClubId = string
export type IntelligenceAnalysisPolicyId = string

export type IntelligenceShotRank = number | string | null

export type IntelligenceShot = {
  id: string
  clubId: IntelligenceClubId
  included: boolean
  capturedAt: string | null
  sessionId: string | null
  analysisWeight: number
  carryYards: number | null
  totalYards: number | null
  offlineYards: number | null
  ballSpeedMph: number | null
  verticalLaunchAngleDegrees: number | null
  horizontalLaunchAngleDegrees: number | null
  totalSpinRpm: number | null
  spinAxisDegrees: number | null
  descentAngleDegrees: number | null
  shotRank: IntelligenceShotRank
}

export type IntelligenceSession = {
  id: string
  startedAt: string | null
  endedAt: string | null
  includedInAnalysis: boolean
}

export type IntelligenceAnalysisDataset = {
  asOf: string
  analysisPolicyId: IntelligenceAnalysisPolicyId
  shots: readonly IntelligenceShot[]
  sessions: readonly IntelligenceSession[]
}

export type PerformanceDriverInputShot = Pick<
  IntelligenceShot,
  | 'id'
  | 'included'
  | 'capturedAt'
  | 'sessionId'
  | 'analysisWeight'
  | 'carryYards'
  | 'offlineYards'
  | 'verticalLaunchAngleDegrees'
  | 'totalSpinRpm'
  | 'spinAxisDegrees'
  | 'descentAngleDegrees'
  | 'shotRank'
>

export type PerformanceDriverInput = {
  clubId: IntelligenceClubId
  shots: readonly PerformanceDriverInputShot[]
}

export type PatternStabilityInputShot = Pick<
  IntelligenceShot,
  | 'id'
  | 'included'
  | 'capturedAt'
  | 'sessionId'
  | 'analysisWeight'
  | 'carryYards'
  | 'offlineYards'
>

export type PatternStabilityInput = {
  clubId: IntelligenceClubId
  shots: readonly PatternStabilityInputShot[]
}
