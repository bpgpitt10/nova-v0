import type { ActiveSessionDraft, SavedSession } from '../types'
import { isSystemOldExcludedSession } from './historicalModel'
import { installPersonalEmlCalibrationState } from './personalEmlCalibration'

const STORAGE_KEY = 'nova-validation-sessions'
const ACTIVE_SESSION_STORAGE_KEY = 'nova-validation-active-session'

const installDerivedSessionState = (sessions: SavedSession[]) => {
  installPersonalEmlCalibrationState(sessions)
  return sessions
}

export const loadSavedSessions = (): SavedSession[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return installDerivedSessionState([])
    }

    const parsed: unknown = JSON.parse(raw)
    return installDerivedSessionState(
      Array.isArray(parsed) ? (parsed as SavedSession[]) : [],
    )
  } catch {
    return installDerivedSessionState([])
  }
}

export const saveSessionHistory = (sessions: SavedSession[]) => {
  installDerivedSessionState(sessions)
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
}

export const saveActiveSessionDraft = (session: ActiveSessionDraft) => {
  window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(session))
}

export const loadActiveSessionDraft = (): ActiveSessionDraft | null => {
  try {
    const raw = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)
    if (!raw) {
      return null
    }

    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as ActiveSessionDraft) : null
  } catch {
    return null
  }
}

export const clearActiveSessionDraft = () => {
  window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
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
) => isSessionIncludedInAnalysis(session) && !isSessionOldExcludedBySystem(session, nowMs)
