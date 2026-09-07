export type LiveCaddieClubProfile = {
  club: string
  stock_carry_yds: number
  carry_sigma_yds?: number
  lateral_bias_yds?: number
  lateral_sigma_yds?: number
  pure_carry_yds?: number
  explicit_variants?: Array<{
    name: string
    carry_yds: number
    sigma_factor?: number
    playable?: boolean
  }>
}

export type LiveCaddieProfileSet = {
  schema_version: 'looper-live-caddie-player-profiles-v1'
  generated_at: string
  source: 'looper-existing-shot-profile-calculations'
  historical_model_now: string
  session_count: number
  shot_count: number
  clubs: LiveCaddieClubProfile[]
  club_support: Array<{
    club: string
    included_stock_shots: number
    sessions: number
    pure_tagged_shots: number
  }>
}

export type LiveCaddieRecommendation = {
  recommended: {
    candidate: {
      club: string
      variant: string
      planned_carry_yds: number
      aim_offset_yds: number
      landing: { forward: number; right: number }
    }
    total_score: number
    distance_fit_score: number
    hazard_boundary_risk: number
    green_containment?: number | null
    minimum_boundary_clearance_yds?: number | null
    reasons: string[]
  } | null
  alternatives: unknown[]
  confidence: number
  fallbacks: string[]
  calculation_versions: Record<string, string>
  assumption_version: string
}
