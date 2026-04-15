import type { Club } from './lib/bagConfig'

export type Shot = {
  id: string
  club: Club
  included: boolean
  capturedAt: string
  enrichmentStatus: 'raw_only' | 'enriched' | 'enrichment_failed'
  openGolfCoach?: OpenGolfCoachPayload
  ballSpeedMetersPerSecond?: number
  verticalLaunchAngleDegrees?: number
  horizontalLaunchAngleDegrees?: number
  totalSpinRpm?: number
  spinAxisDegrees?: number
  ballSpeedMph?: number
  carryYards?: number
  totalYards?: number
  offlineYards?: number
  launchAngleDeg?: number
  spinRpm?: number
  shotName?: string
  shotRanking?: number | string
  feltPerfect?: boolean
  feltPerfectTaggedAt?: string
  feltPerfectSource?: 'session_intelligence' | 'data_management'
  source: 'nova' | 'mock'
}

export type IncomingNovaShot = {
  id?: string
  timestamp?: string
  ballSpeedMetersPerSecond?: number
  ball_speed_meters_per_second?: number
  verticalLaunchAngleDegrees?: number
  vertical_launch_angle_degrees?: number
  horizontalLaunchAngleDegrees?: number
  horizontal_launch_angle_degrees?: number
  totalSpinRpm?: number
  total_spin_rpm?: number
  spinAxisDegrees?: number
  spin_axis_degrees?: number
  ballSpeedMph?: number
  carryYards?: number
  carry?: number
  totalYards?: number
  total?: number
  offlineYards?: number
  offline?: number
  launchAngleDeg?: number
  vla?: number
  spinRpm?: number
  spin?: number
  shotName?: string
  shot_name?: string
  shotRanking?: number | string
}

export type OpenGolfCoachInput = {
  ball_speed_meters_per_second?: number
  vertical_launch_angle_degrees?: number
  horizontal_launch_angle_degrees?: number
  total_spin_rpm?: number
  spin_axis_degrees?: number
}

export type OpenGolfCoachPayload = Record<string, unknown>

export type OpenGolfCoachDerivedValues = {
  carry_distance_yards?: number
  total_distance_yards?: number
  offline_distance_yards?: number
  shot_name?: string
  shot_rank?: number | string
}

export type SessionMetadata = {
  app: 'nova-validation'
  schemaVersion: number
  feedMode?: 'mock' | 'real'
  includeInAnalysis?: boolean
}

export type SavedSession = {
  id: string
  startedAt: string
  endedAt: string
  shots: Shot[]
  metadata?: SessionMetadata
}

export type ActiveSessionDraft = {
  id: string
  startedAt: string
  shots: Shot[]
  metadata: SessionMetadata
}

export type ClubSummary = {
  club: Club
  totalShots: number
  includedShots: number
  averageCarryYards: number | null
  confidence: 'No data' | 'Low' | 'Medium' | 'High'
}

export type ReviewClubSummary = {
  club: Club
  includedShots: number
  carryAverageYards: number | null
  carryStdDevYards: number | null
  offlineAverageYards: number | null
  offlineStdDevYards: number | null
  shotRankSummary: string
  caddieScore: number
  caddieCall: 'Attack' | 'Play' | 'Manage' | 'Careful' | 'Liability' | 'Insufficient Data'
  componentScores: {
    distanceWindow: number
    directionWindow: number
    flightQuality: number | null
    patternStability: number | null
    dataConfidence: number
  }
  explanation: string
  insights: string[]
}

export type { Club }
