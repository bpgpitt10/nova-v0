import type { Club } from '../lib/bagConfig'
import type { SavedSession, SessionSource, Shot } from '../types'
import {
  getAllowedUserRecord,
  getCurrentLooperUser,
  getSupabaseClient,
  isSupabaseConfigured,
  type LooperAuthUser,
} from './supabaseClient'

export type CloudSyncResult =
  | { status: 'skipped'; reason: 'not-configured' | 'signed-out' | 'not-allowed' }
  | { status: 'synced' }
  | { status: 'failed'; error: string }

const getAllowedSignedInUser = async (): Promise<LooperAuthUser | null> => {
  if (!isSupabaseConfigured()) {
    return null
  }

  const user = await getCurrentLooperUser()
  if (!user) {
    return null
  }

  const allowed = await getAllowedUserRecord(user)
  return allowed ? user : null
}

const firstNumber = (...values: Array<number | undefined>) =>
  values.find((value): value is number => typeof value === 'number' && Number.isFinite(value))

const shotToCloudRow = (userId: string, sessionId: string, shot: Shot) => ({
  id: shot.id,
  user_id: userId,
  session_id: sessionId,
  captured_at: shot.capturedAt,
  club: shot.club,
  included: shot.included,
  source: shot.source,
  enrichment_status: shot.enrichmentStatus,
  shot_variant_id: shot.shotVariantId ?? null,
  felt_perfect: shot.feltPerfect ?? null,
  felt_perfect_tagged_at: shot.feltPerfectTaggedAt ?? null,
  felt_perfect_source: shot.feltPerfectSource ?? null,

  carry_yards: shot.carryYards ?? null,
  total_yards: shot.totalYards ?? null,
  offline_yards: shot.offlineYards ?? null,
  ball_speed_mph: shot.ballSpeedMph ?? null,
  ball_speed_meters_per_second: shot.ballSpeedMetersPerSecond ?? null,
  vertical_launch_angle_degrees:
    firstNumber(shot.verticalLaunchAngleDegrees, shot.launchAngleDeg) ?? null,
  horizontal_launch_angle_degrees: shot.horizontalLaunchAngleDegrees ?? null,
  total_spin_rpm: firstNumber(shot.totalSpinRpm, shot.spinRpm) ?? null,
  spin_axis_degrees: shot.spinAxisDegrees ?? null,
  peak_height: shot.peakHeight ?? null,
  descent_angle: shot.descentAngle ?? null,
  back_spin: shot.backSpin ?? null,
  side_spin: shot.sideSpin ?? null,
  club_speed: shot.clubSpeed ?? null,
  club_path_degrees:
    firstNumber(
      shot.clubPathDegrees,
      shot.clubPathDeg,
      shot.club_path_degrees,
      shot.club_path_deg,
      shot.clubPath,
      shot.club_path,
    ) ?? null,
  face_to_path_degrees:
    firstNumber(
      shot.faceToPathDegrees,
      shot.clubFaceToPathDegrees,
      shot.faceToPathDeg,
      shot.face_to_path_degrees,
      shot.face_to_path_deg,
      shot.faceToPath,
      shot.face_to_path,
      shot.clubFaceToPath,
      shot.club_face_to_path,
      shot.club_face_to_path_degrees,
    ) ?? null,
  face_to_target_degrees:
    firstNumber(
      shot.faceToTargetDegrees,
      shot.clubFaceToTargetDegrees,
      shot.faceToTargetDeg,
      shot.face_to_target_degrees,
      shot.face_to_target_deg,
      shot.faceToTarget,
      shot.face_to_target,
      shot.clubFaceToTarget,
      shot.club_face_to_target,
      shot.club_face_to_target_degrees,
    ) ?? null,
  club_aoa: shot.clubAoa ?? null,
  club_lie: shot.clubLie ?? null,
  club_loft: shot.clubLoft ?? null,
  dynamic_loft: shot.dynamicLoft ?? null,
  closure_rate: shot.closureRate ?? null,
  club_face_h_impact: shot.clubFaceHImpact ?? null,
  club_face_v_impact: shot.clubFaceVImpact ?? null,
  smash_factor: shot.smashFactor ?? null,
  distance_to_pin: firstNumber(shot.distanceToPin, shot.distToPin) ?? null,
  shot_name: shot.shotName ?? null,
  shot_ranking:
    typeof shot.shotRanking === 'number' || typeof shot.shotRanking === 'string'
      ? String(shot.shotRanking)
      : null,
  open_golf_coach: shot.openGolfCoach ?? null,
})

const syncFailure = (error: unknown): CloudSyncResult => ({
  status: 'failed',
  error: error instanceof Error ? error.message : String(error),
})

export const syncSavedSessionToCloud = async (
  session: SavedSession,
): Promise<CloudSyncResult> => {
  if (!isSupabaseConfigured()) {
    return { status: 'skipped', reason: 'not-configured' }
  }

  try {
    const user = await getAllowedSignedInUser()
    if (!user) {
      const currentUser = await getCurrentLooperUser()
      return {
        status: 'skipped',
        reason: currentUser ? 'not-allowed' : 'signed-out',
      }
    }

    const client = await getSupabaseClient()
    const sessionResult = await client.from<unknown>('sessions').upsert(
      {
        id: session.id,
        user_id: user.id,
        started_at: session.startedAt,
        ended_at: session.endedAt,
        source: session.metadata?.source ?? null,
        feed_mode: session.metadata?.feedMode ?? null,
        include_in_analysis: session.metadata?.includeInAnalysis !== false,
        schema_version: session.metadata?.schemaVersion ?? 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )
    if (sessionResult.error) {
      throw new Error(sessionResult.error.message)
    }

    if (session.shots.length > 0) {
      const shotResult = await client.from<unknown>('shots').upsert(
        session.shots.map((shot) => shotToCloudRow(user.id, session.id, shot)),
        { onConflict: 'id' },
      )
      if (shotResult.error) {
        throw new Error(shotResult.error.message)
      }
    }

    return { status: 'synced' }
  } catch (error) {
    return syncFailure(error)
  }
}

export const syncBagConfigToCloud = async (
  selectedClubs: Club[],
): Promise<CloudSyncResult> => {
  if (!isSupabaseConfigured()) {
    return { status: 'skipped', reason: 'not-configured' }
  }

  try {
    const user = await getAllowedSignedInUser()
    if (!user) {
      const currentUser = await getCurrentLooperUser()
      return {
        status: 'skipped',
        reason: currentUser ? 'not-allowed' : 'signed-out',
      }
    }

    const client = await getSupabaseClient()
    const result = await client.from<unknown>('bags').upsert(
      {
        id: user.id,
        user_id: user.id,
        name: 'My Bag',
        selected_clubs: selectedClubs,
        version: 1,
        is_default: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )
    if (result.error) {
      throw new Error(result.error.message)
    }

    return { status: 'synced' }
  } catch (error) {
    return syncFailure(error)
  }
}

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

export const loadSavedSessionsFromCloud = async (): Promise<SavedSession[]> => {
  const user = await getAllowedSignedInUser()
  if (!user) {
    return []
  }

  const client = await getSupabaseClient()
  const sessionRows =
    (await awaitQuery<CloudSessionRow[]>(
      client.from<CloudSessionRow[]>('sessions').select(
        'id, started_at, ended_at, source, feed_mode, include_in_analysis, schema_version',
      ),
    )) ?? []
  const shotRows =
    (await awaitQuery<CloudShotRow[]>(client.from<CloudShotRow[]>('shots').select('*'))) ?? []

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

export const loadDefaultBagFromCloud = async (): Promise<Club[] | null> => {
  const user = await getAllowedSignedInUser()
  if (!user) {
    return null
  }

  const client = await getSupabaseClient()
  const result = await client
    .from<CloudBagRow>('bags')
    .select('selected_clubs')
    .eq('is_default', true)
    .maybeSingle()

  if (result.error) {
    throw new Error(result.error.message)
  }

  return result.data?.selected_clubs?.length
    ? (result.data.selected_clubs as Club[])
    : null
}

export type DiagnosticEventInput = {
  sessionId?: string
  courseKey?: string
  holeNumber?: number
  component: string
  modelVersion?: string
  result: string
  reason?: string
  confidence?: number
  metadata?: Record<string, unknown>
}

const metadataContainsImagePayload = (metadata: Record<string, unknown> | undefined) => {
  if (!metadata) {
    return false
  }
  const forbiddenKeys = new Set(['image', 'imageData', 'screenshot', 'base64', 'blob'])
  return Object.keys(metadata).some((key) => forbiddenKeys.has(key))
}

export const writeDiagnosticEventToCloud = async (
  input: DiagnosticEventInput,
): Promise<CloudSyncResult> => {
  if (!isSupabaseConfigured()) {
    return { status: 'skipped', reason: 'not-configured' }
  }
  if (metadataContainsImagePayload(input.metadata)) {
    return { status: 'failed', error: 'Diagnostic metadata cannot contain screenshot/image payloads.' }
  }

  try {
    const user = await getAllowedSignedInUser()
    if (!user) {
      const currentUser = await getCurrentLooperUser()
      return {
        status: 'skipped',
        reason: currentUser ? 'not-allowed' : 'signed-out',
      }
    }

    const client = await getSupabaseClient()
    const result = await client.from<unknown>('diagnostic_events').upsert({
      user_id: user.id,
      session_id: input.sessionId ?? null,
      course_key: input.courseKey ?? null,
      hole_number: input.holeNumber ?? null,
      component: input.component,
      model_version: input.modelVersion ?? null,
      result: input.result,
      reason: input.reason ?? null,
      confidence: input.confidence ?? null,
      metadata: input.metadata ?? null,
    })
    if (result.error) {
      throw new Error(result.error.message)
    }

    return { status: 'synced' }
  } catch (error) {
    return syncFailure(error)
  }
}
