import { syncSavedSessionToCloud } from '../cloud/cloudPersistence'
import type { ActiveSessionDraft, SavedSession, Shot } from '../types'
import { isSystemOldExcludedSession } from './historicalModel'
import {
  ACTIVE_SESSION_STORAGE_KEY,
  SESSION_HISTORY_STORAGE_KEY,
  persistWorkingCacheValueForActiveUser,
} from './localUserScope'
import { installMishitPlanningState } from './mishitPlanningPopulation'
import { resolveHandedOpenGolfCoachValue } from './openGolfCoach'

export const SESSION_HISTORY_UPDATED_EVENT = 'looper-session-history-updated'

const payloadRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const finiteNumber = (value: unknown) => {
  const resolved = resolveHandedOpenGolfCoachValue(value)
  return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : undefined
}

const directFiniteNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const resolveOgcClubAngle = (
  currentValue: number | undefined,
  ogcValue: number | undefined,
  source: unknown,
) => {
  if (source === 'gspro') {
    return currentValue
  }

  if (source === 'ambiguous' || source === 'missing') {
    return ogcValue ?? currentValue
  }

  // Backward compatibility for shots captured before per-field provenance was
  // recorded. A non-zero GSPro club angle is clearly real and remains primary;
  // a legacy zero is treated as ambiguous so OGC can fill it.
  if (source === undefined) {
    if (typeof currentValue === 'number' && currentValue !== 0) {
      return currentValue
    }
    return ogcValue ?? currentValue
  }

  return currentValue ?? ogcValue
}

/**
 * GSPro is the primary record whenever a field is known to be measured. OGC fills
 * genuine gaps and ambiguous GSPro zero placeholders. The raw GSPro value and its
 * source remain inside openGolfCoach.simread.resolvedShot, so a legitimate 0.0
 * club angle is never discarded just because its numeric value is zero.
 */
const normalizeOgcDerivedShotFields = (shot: Shot): Shot => {
  const root = payloadRecord(shot.openGolfCoach)
  const coach = root ? payloadRecord(root.open_golf_coach) : null
  if (!root || !coach) {
    return shot
  }

  const customary = payloadRecord(coach.us_customary_units)
  const clubSpeedOgc = finiteNumber(customary?.club_speed_mph)
  const smashFactorOgc = finiteNumber(coach.smash_factor)
  const clubPathOgc = finiteNumber(coach.club_path_degrees)
  const faceToPathOgc = finiteNumber(coach.club_face_to_path_degrees)
  const faceToTargetOgc = finiteNumber(coach.club_face_to_target_degrees)

  const simread = payloadRecord(root.simread)
  const resolvedShot = simread ? payloadRecord(simread.resolvedShot) : null

  const currentClubSpeed = directFiniteNumber(shot.clubSpeed)
  const currentSmashFactor = directFiniteNumber(shot.smashFactor)
  const currentClubPath = directFiniteNumber(shot.clubPathDegrees ?? shot.clubPath)
  const currentFaceToPath = directFiniteNumber(
    shot.faceToPathDegrees ?? shot.faceToPath,
  )
  const currentFaceToTarget = directFiniteNumber(
    shot.faceToTargetDegrees ?? shot.faceToTarget,
  )

  // Speed and smash cannot legitimately be zero on a recorded shot. A positive
  // GSPro measurement is authoritative; OGC only fills when GSPro did not provide one.
  const clubSpeed =
    typeof currentClubSpeed === 'number' && currentClubSpeed > 0
      ? currentClubSpeed
      : clubSpeedOgc
  const smashFactor =
    typeof currentSmashFactor === 'number' && currentSmashFactor > 0
      ? currentSmashFactor
      : smashFactorOgc

  const clubPath = resolveOgcClubAngle(
    currentClubPath,
    clubPathOgc,
    resolvedShot?.clubPathSource,
  )
  const faceToPath = resolveOgcClubAngle(
    currentFaceToPath,
    faceToPathOgc,
    resolvedShot?.faceToPathSource,
  )
  const faceToTarget = resolveOgcClubAngle(
    currentFaceToTarget,
    faceToTargetOgc,
    resolvedShot?.faceToTargetSource,
  )

  const openGolfCoach = {
    ...root,
    ...(typeof clubSpeedOgc === 'number' ? { club_speed_mph: clubSpeedOgc } : {}),
    ...(typeof smashFactorOgc === 'number' ? { smash_factor: smashFactorOgc } : {}),
    ...(typeof clubPathOgc === 'number' ? { club_path_degrees: clubPathOgc } : {}),
    ...(typeof faceToPathOgc === 'number'
      ? { club_face_to_path_degrees: faceToPathOgc }
      : {}),
    ...(typeof faceToTargetOgc === 'number'
      ? { club_face_to_target_degrees: faceToTargetOgc }
      : {}),
  }

  return {
    ...shot,
    openGolfCoach,
    ...(typeof clubSpeed === 'number' ? { clubSpeed } : {}),
    ...(typeof smashFactor === 'number' ? { smashFactor } : {}),
    ...(typeof clubPath === 'number'
      ? { clubPath, clubPathDegrees: clubPath }
      : {}),
    ...(typeof faceToPath === 'number'
      ? { faceToPath, faceToPathDegrees: faceToPath }
      : {}),
    ...(typeof faceToTarget === 'number'
      ? { faceToTarget, faceToTargetDegrees: faceToTarget }
      : {}),
  }
}

const normalizeSessions = (sessions: SavedSession[]) =>
  sessions.map((session) => ({
    ...session,
    shots: session.shots.map(normalizeOgcDerivedShotFields),
  }))

const installPlanningState = (sessions: SavedSession[]) => {
  installMishitPlanningState(sessions)
  return sessions
}

export const loadSavedSessions = (): SavedSession[] => {
  try {
    const raw = window.localStorage.getItem(SESSION_HISTORY_STORAGE_KEY)
    if (!raw) {
      return installPlanningState([])
    }

    const parsed: unknown = JSON.parse(raw)
    const sessions = Array.isArray(parsed) ? (parsed as SavedSession[]) : []
    return installPlanningState(normalizeSessions(sessions))
  } catch {
    return installPlanningState([])
  }
}

export const saveSessionHistory = (sessions: SavedSession[]) => {
  const previousSessions = loadSavedSessions()
  const previousById = new Map(
    previousSessions.map((session) => [session.id, JSON.stringify(session)]),
  )
  const normalizedSessions = normalizeSessions(sessions)

  const serialized = JSON.stringify(normalizedSessions)
  window.localStorage.setItem(SESSION_HISTORY_STORAGE_KEY, serialized)
  persistWorkingCacheValueForActiveUser(SESSION_HISTORY_STORAGE_KEY, serialized)

  // Derived mishit state follows the latest raw history immediately. It is not
  // written back into the source Shot records and does not alter human Pure tags.
  installMishitPlanningState(normalizedSessions)
  window.dispatchEvent(new Event(SESSION_HISTORY_UPDATED_EVENT))

  normalizedSessions.forEach((session) => {
    const previousSerialized = previousById.get(session.id)
    const nextSerialized = JSON.stringify(session)
    if (previousSerialized === nextSerialized) {
      return
    }

    void syncSavedSessionToCloud(session).then((result) => {
      if (result.status === 'failed') {
        console.warn('[Cloud Sync] session sync failed; local copy retained', {
          sessionId: session.id,
          error: result.error,
        })
      }
    })
  })
}

export const saveActiveSessionDraft = (session: ActiveSessionDraft) => {
  const normalizedSession: ActiveSessionDraft = {
    ...session,
    shots: session.shots.map(normalizeOgcDerivedShotFields),
  }
  const serialized = JSON.stringify(normalizedSession)
  window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, serialized)
  persistWorkingCacheValueForActiveUser(ACTIVE_SESSION_STORAGE_KEY, serialized)
}

export const loadActiveSessionDraft = (): ActiveSessionDraft | null => {
  try {
    const raw = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)
    if (!raw) {
      return null
    }

    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const draft = parsed as ActiveSessionDraft
    return {
      ...draft,
      shots: draft.shots.map(normalizeOgcDerivedShotFields),
    }
  } catch {
    return null
  }
}

export const clearActiveSessionDraft = () => {
  window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
  persistWorkingCacheValueForActiveUser(ACTIVE_SESSION_STORAGE_KEY, null)
}

export const isSessionIncludedInAnalysis = (session: SavedSession) =>
  session.metadata?.includeInAnalysis !== false

export const isSessionOldExcludedBySystem = (
  session: SavedSession,
  nowMs = Date.now(),
) => isSystemOldExcludedSession(session, nowMs)

export const isSessionEligibleForAnalysis = (
  session: SavedSession,
  nowMs = Date.now(),
) => !isSessionOldExcludedBySystem(session, nowMs)
