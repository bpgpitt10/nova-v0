import type { SavedSession } from '../types'

const STORAGE_KEY = 'nova-validation-sessions'

export const loadSavedSessions = (): SavedSession[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }

    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SavedSession[]) : []
  } catch {
    return []
  }
}

export const saveSessionHistory = (sessions: SavedSession[]) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
}
