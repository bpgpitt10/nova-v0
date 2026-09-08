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

/**
 * GSPro's range row can contain literal zero placeholders for club-delivery fields
 * the launch monitor did not provide. Once OpenGolfCoach enrichment succeeds,
 * promote the OGC-derived values into the canonical Shot fields so every consumer
 * (dashboard, mishit model, Manage Data, CSV, and cloud persistence) sees the same
 * values instead of the raw zero sentinels.
 */
const normalizeOgcDerivedShotFields = (shot: Shot): Shot => {
  const root = payloadRecord(shot.openGolfCoach)
  const coach = root ? payloadRecord(root.open_golf_coach) : null
  if (!root || !coach) {
    return shot
  }

  const customary = payloadRecord(coach.us_customary_units)
  const clubSpeed = finiteNumber(customary?.club_speed_mph)
  const smashFactor = finiteNumber(coach.smash_factor)
  const clubPath = finiteNumber(coach.club_path_degrees)
  const faceToPath = finiteNumber(coach.club_face_to_path_degrees)
  const faceToTarget = finiteNumber(coach.club_face_to_target_degrees)

  const openGolfCoach = {
    ...root,
    ...(typeof clubSpeed === 'number' ? { club_speed_mph: clubSpeed } : {}),
    ...(typeof smashFactor === 'number' ? { smash_factor: smashFactor } : {}),
    ...(typeof clubPath === 'number' ? { club_path_degrees: clubPath } : {}),
    ...(typeof faceToPath === 'number'
      ? { club_face_to_path_degrees: faceToPath }
      : {}),
    ...(typeof faceToTarget === 'number'
      ? { club_face_to_target_degrees: faceToTarget }
      : {}),
  }

  return {
    ...shot,
    openGolfCoach,
    ...(typeof clubSpeed === 'number' ? { clubSpeed } : {}),
    ...(typeof smashFactor === 'number' ? { smashFactor } : {}),
    ...(typeof clubPath === 'number' ? { clubPathDegrees: clubPath } : {}),
    ...(typeof faceToPath === 'number' ? { faceToPathDegrees: faceToPath } : {}),
    ...(typeof faceToTarget === 'number' ? { faceToTargetDegrees: faceToTarget } : {}),
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
