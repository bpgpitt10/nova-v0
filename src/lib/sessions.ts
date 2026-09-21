import type { ActiveSessionDraft, SavedSession } from '../types'
import { isSystemOldExcludedSession } from './historicalModel'
import { applyPersonalEmlCalibration } from './personalEmlCalibration'

const STORAGE_KEY = 'nova-validation-sessions'
const ACTIVE_SESSION_STORAGE_KEY = 'nova-validation-active-session'

export const loadSavedSessions = (): SavedSession[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return applyPersonalEmlCalibration([])
    }

    const parsed: unknown = JSON.parse(raw)
    return applyPersonalEmlCalibration(
      Array.isArray(parsed) ? (parsed as SavedSession[]) : [],
    )
  } catch {
    return applyPersonalEmlCalibration([])
  }
}

export const saveSessionHistory = (sessions: SavedSession[]) => {
  const calibratedSessions = applyPersonalEmlCalibration(sessions)
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(calibratedSessions))
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
