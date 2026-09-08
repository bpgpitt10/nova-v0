import type { Club } from '../lib/bagConfig'
import type { SavedSession, SessionSource, Shot } from '../types'
import { getSupabaseClient } from './supabaseClient'

type CloudSessionRow = {
  id: string
  started_at: string
  ended_at: string | null
  source: string | null
  feed_mode: string | null
  include_in_analysis: boolean
  schema_version: number
}

type CloudShotRow = {
  id: string
  session_id: string
  captured_at: string
  club: string
  included: boolean
  source: string
  enrichment_status: string
  shot_variant_id: string | null
  felt_perfect: boolean | null
  felt_perfect_tagged_at: string | null
  felt_perfect_source: string | null
  carry_yards: number | null
  total_yards: number | null
  offline_yards: number | null
  ball_speed_mph: number | null
  ball_speed_meters_per_second: number | null
  vertical_launch_angle_degrees: number | null
  horizontal_launch_angle_degrees: number | null
  total_spin_rpm: number | null
  spin_axis_degrees: number | null
  peak_height: number | null
  descent_angle: number | null
  back_spin: number | null
  side_spin: number | null
  club_speed: number | null
  club_path_degrees: number | null
  face_to_path_degrees: number | null
  face_to_target_degrees: number | null
  club_aoa: number | null
  club_lie: number | null
  club_loft: number | null
  dynamic_loft: number | null
  closure_rate: number | null
  club_face_h_impact: number | null
  club_face_v_impact: number | null
  smash_factor: number | null
  distance_to_pin: number | null
  shot_name: string | null
  shot_ranking: string | null
  open_golf_coach: Record<string, unknown> | null
}

type CloudBagRow = {
  selected_clubs: string[]
}

type AwaitableQueryResult<T> = {
  data: T | null
  error: { message: string } | null
}

const awaitQuery = async <T>(query: unknown): Promise<T | null> => {
  const result = await (query as Promise<AwaitableQueryResult<T>>)
  if (result.error) {
    throw new Error(result.error.message)
  }
  return result.data
}

const nullable = <T>(value: T | null): T | undefined => value ?? undefined

const cloudShotToShot = (row: CloudShotRow): Shot => ({
  id: row.id,
  club: row.club as Club,
  included: row.included,
  capturedAt: row.captured_at,
  enrichmentStatus: row.enrichment_status as Shot['enrichmentStatus'],
  source: row.source as Shot['source'],
  shotVariantId: nullable(row.shot_variant_id),
  feltPerfect: nullable(row.felt_perfect),
  feltPerfectTaggedAt: nullable(row.felt_perfect_tagged_at),
  feltPerfectSource: nullable(row.felt_perfect_source) as Shot['feltPerfectSource'],
  carryYards: nullable(row.carry_yards),
  totalYards: nullable(row.total_yards),
  offlineYards: nullable(row.offline_yards),
  ballSpeedMph: nullable(row.ball_speed_mph),
  ballSpeedMetersPerSecond: nullable(row.ball_speed_meters_per_second),
  verticalLaunchAngleDegrees: nullable(row.vertical_launch_angle_degrees),
  horizontalLaunchAngleDegrees: nullable(row.horizontal_launch_angle_degrees),
  totalSpinRpm: nullable(row.total_spin_rpm),
  spinAxisDegrees: nullable(row.spin_axis_degrees),
  peakHeight: nullable(row.peak_height),
  descentAngle: nullable(row.descent_angle),
  backSpin: nullable(row.back_spin),
  sideSpin: nullable(row.side_spin),
  clubSpeed: nullable(row.club_speed),
  clubPathDegrees: nullable(row.club_path_degrees),
  faceToPathDegrees: nullable(row.face_to_path_degrees),
  faceToTargetDegrees: nullable(row.face_to_target_degrees),
  clubAoa: nullable(row.club_aoa),
  clubLie: nullable(row.club_lie),
  clubLoft: nullable(row.club_loft),
  dynamicLoft: nullable(row.dynamic_loft),
  closureRate: nullable(row.closure_rate),
  clubFaceHImpact: nullable(row.club_face_h_impact),
  clubFaceVImpact: nullable(row.club_face_v_impact),
  smashFactor: nullable(row.smash_factor),
  distanceToPin: nullable(row.distance_to_pin),
  shotName: nullable(row.shot_name),
  shotRanking: nullable(row.shot_ranking),
  openGolfCoach: nullable(row.open_golf_coach),
})

// The auth gate has already established the account and allowlist before calling
// this module. Querying by that known user id avoids a second auth-state lookup
// silently turning a valid cloud account into an empty history during startup.
export const hydrateSessionsForUser = async (userId: string): Promise<SavedSession[]> => {
  const client = await getSupabaseClient()
  const sessionRows =
    (await awaitQuery<CloudSessionRow[]>(
      client
        .from<CloudSessionRow[]>('sessions')
        .select('id, started_at, ended_at, source, feed_mode, include_in_analysis, schema_version')
        .eq('user_id', userId),
    )) ?? []
  const shotRows =
    (await awaitQuery<CloudShotRow[]>(
      client.from<CloudShotRow[]>('shots').select('*').eq('user_id', userId),
    )) ?? []

  const shotsBySession = new Map<string, Shot[]>()
  shotRows.forEach((row) => {
    const rows = shotsBySession.get(row.session_id) ?? []
    rows.push(cloudShotToShot(row))
    shotsBySession.set(row.session_id, rows)
  })

  return sessionRows
    .map<SavedSession>((row) => ({
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? row.started_at,
      shots: (shotsBySession.get(row.id) ?? []).sort((a, b) =>
        a.capturedAt.localeCompare(b.capturedAt),
      ),
      metadata: {
        app: 'nova-validation',
        schemaVersion: row.schema_version,
        source: nullable(row.source) as SessionSource | undefined,
        feedMode: nullable(row.feed_mode) as 'mock' | 'real' | undefined,
        includeInAnalysis: row.include_in_analysis,
      },
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export const hydrateDefaultBagForUser = async (userId: string): Promise<Club[] | null> => {
  const client = await getSupabaseClient()
  const result = await client
    .from<CloudBagRow>('bags')
    .select('selected_clubs')
    .eq('user_id', userId)
    .eq('is_default', true)
    .maybeSingle()

  if (result.error) {
    throw new Error(result.error.message)
  }

  return result.data?.selected_clubs?.length
    ? (result.data.selected_clubs as Club[])
    : null
}
