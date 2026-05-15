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
  clubPathDegrees?: number
  faceToPathDegrees?: number
  faceToTargetDegrees?: number
  clubPath?: number
  faceToPath?: number
  faceToTarget?: number
  clubPathDeg?: number
  faceToPathDeg?: number
  faceToTargetDeg?: number
  club_path_degrees?: number
  club_path_deg?: number
  club_path?: number
  face_to_path_degrees?: number
  face_to_path_deg?: number
  face_to_path?: number
  clubFaceToPathDegrees?: number
  club_face_to_path_degrees?: number
  clubFaceToPath?: number
  club_face_to_path?: number
  face_to_target_degrees?: number
  face_to_target_deg?: number
  face_to_target?: number
  clubFaceToTargetDegrees?: number
  club_face_to_target_degrees?: number
  clubFaceToTarget?: number
  club_face_to_target?: number
  ballSpeedMph?: number
  carryYards?: number
  totalYards?: number
  offlineYards?: number
  launchAngleDeg?: number
  spinRpm?: number
  shotName?: string
  shotRanking?: number | string
  shotVariantId?: string
  feltPerfect?: boolean
  feltPerfectTaggedAt?: string
  feltPerfectSource?: 'session_intelligence' | 'data_management'
  source: 'nova' | 'mock' | 'simread'
}

export type IncomingNovaShot = {
  id?: string
  timestamp?: string
  openGolfCoach?: OpenGolfCoachPayload
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
  clubPathDegrees?: number
  club_path_degrees?: number
  clubPathDeg?: number
  club_path_deg?: number
  clubPath?: number
  club_path?: number
  faceToPathDegrees?: number
  face_to_path_degrees?: number
  faceToPathDeg?: number
  face_to_path_deg?: number
  faceToPath?: number
  face_to_path?: number
  clubFaceToPathDegrees?: number
  club_face_to_path_degrees?: number
  clubFaceToPath?: number
  club_face_to_path?: number
  faceToTargetDegrees?: number
  face_to_target_degrees?: number
  faceToTargetDeg?: number
  face_to_target_deg?: number
  faceToTarget?: number
  face_to_target?: number
  clubFaceToTargetDegrees?: number
  club_face_to_target_degrees?: number
  clubFaceToTarget?: number
  club_face_to_target?: number
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
