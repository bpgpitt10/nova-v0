export type Club =
  | 'Driver'
  | '3 Wood'
  | '5 Wood'
  | '4 Iron'
  | '5 Iron'
  | '6 Iron'
  | '7 Iron'
  | '8 Iron'
  | '9 Iron'
  | 'PW'
  | 'GW'
  | 'SW'
  | 'LW'

export type Shot = {
  id: string
  club: Club
  included: boolean
  capturedAt: string
  enrichmentStatus: 'raw_only' | 'enriched' | 'enrichment_failed'
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

export type OpenGolfCoachDerivedValues = {
  carry_distance_yards?: number
  total_distance_yards?: number
  offline_distance_yards?: number
  shot_name?: string
  shot_rank?: number | string
}

export type SavedSession = {
  id: string
  startedAt: string
  endedAt: string
  shots: Shot[]
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
    flightQuality: number
    patternStability: number
    dataConfidence: number
  }
  explanation: string
}

export const clubs: Club[] = [
  'Driver',
  '3 Wood',
  '5 Wood',
  '4 Iron',
  '5 Iron',
  '6 Iron',
  '7 Iron',
  '8 Iron',
  '9 Iron',
  'PW',
  'GW',
  'SW',
  'LW',
]
