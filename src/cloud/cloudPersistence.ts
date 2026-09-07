import type { Club } from '../lib/bagConfig'
import type { SavedSession, Shot } from '../types'
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
        // Using the auth user UUID as the default-bag UUID gives us an idempotent
        // single-bag write now while preserving room for extra bags later.
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
