import type { PreShotFreezeEvent } from './preShotTracker'

const STORAGE_KEY = 'looper:last-pre-shot-freeze:v1'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const validIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

const looksLikeFreezeEvent = (value: unknown): value is PreShotFreezeEvent => {
  if (!isRecord(value)) return false
  if (typeof value.triggerShotKey !== 'string' || !value.triggerShotKey.trim()) return false
  if (typeof value.sourceEpoch !== 'number' || !Number.isFinite(value.sourceEpoch)) return false
  if (!validIsoDate(value.frozenAt)) return false
  if (!isRecord(value.state)) return false
  if (typeof value.state.revision !== 'number' || !Number.isFinite(value.state.revision)) return false
  if (!validIsoDate(value.state.assembledAt)) return false
  return true
}

/**
 * Persist only completed immutable pre-shot freezes. This store is audit/history
 * continuity across a browser reload; it is never fed back into the live watcher
 * as a current candidate, so stale persisted state cannot fabricate an impact.
 */
export const saveLastPreShotFreeze = (event: PreShotFreezeEvent) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(event))
  } catch (error) {
    console.warn('[LiveShotState] could not persist last pre-shot freeze', error)
  }
}

export const loadLastPreShotFreeze = (): PreShotFreezeEvent | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!looksLikeFreezeEvent(parsed)) {
      window.localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return parsed
  } catch (error) {
    console.warn('[LiveShotState] could not restore last pre-shot freeze', error)
    return null
  }
}
