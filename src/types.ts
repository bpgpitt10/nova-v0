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
  ballSpeedMph?: number
  carryYards?: number
  totalYards?: number
  offlineYards?: number
  launchAngleDeg?: number
  spinRpm?: number
  shotRanking?: number | string
  source: 'nova' | 'mock'
}

export type IncomingNovaShot = {
  id?: string
  timestamp?: string
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
  shotRanking?: number | string
}

export type ClubSummary = {
  club: Club
  totalShots: number
  includedShots: number
  averageCarryYards: number | null
  confidence: 'No data' | 'Low' | 'Medium' | 'High'
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
