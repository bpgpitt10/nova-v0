import type { ActiveSessionDraft, SavedSession } from '../types'
import { isSystemOldExcludedSession } from './historicalModel'
import { installMishitPlanningState } from './mishitPlanningPopulation'

const STORAGE_KEY = 'nova-validation-sessions'
const ACTIVE_SESSION_STORAGE_KEY = 'nova-validation-active-session'

const installPlanningState = (sessions: SavedSession[]) => {
  installMishitPlanningState(sessions)
  return sessions
}

export const loadSavedSessions = (): SavedSession[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return installPlanningState([])
    }
    const parsed: unknown = JSON.parse(raw)
    return installPlanningState(Array.isArray(parsed) ? (parsed as SavedSession[]) : [])
  } catch {
    return installPlanningState([])
  }
}

export const saveSessionHistory = (sessions: SavedSession[]) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
  // Derived planning interpretation follows the latest raw history immediately;
  // nothing is written back onto the source Shot records.
  installMishitPlanningState(sessions)
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
) => !isSessionOldExcludedBySystem(session, nowMs)
