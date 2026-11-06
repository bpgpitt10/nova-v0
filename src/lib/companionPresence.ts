import { readLooperCompanionStatus } from '../adapters/looperCompanion'
import {
  companionUpdateState,
  isWindowsBrowser,
  type CompanionLatest,
  type CompanionUpdateState,
} from './companionRelease'

/**
 * Is the Looper Companion here? The browser can only see whether something
 * answers on the companion port, so "installed but not running" and "never
 * installed" look the same. We remember when a companion has answered in this
 * browser; after that, silence reads as "not running", not "not installed".
 */

const SEEN_KEY = 'looper.companion-seen.v1'

export type CompanionSeen = Readonly<{ at: string; release: string | null }>

export const companionSeenBefore = (): CompanionSeen | null => {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CompanionSeen>
    return typeof parsed.at === 'string' ? { at: parsed.at, release: typeof parsed.release === 'string' ? parsed.release : null } : null
  } catch {
    return null
  }
}

export const markCompanionSeen = (release: string | null): void => {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify({ at: new Date().toISOString(), release }))
  } catch {
    // storage unavailable: the page still works, we just can't remember
  }
}

export type CompanionPresence = Readonly<{
  /**
   * checking: first look not done yet
   * connected: answering now
   * not-running: answered in this browser before, silent now
   * not-installed: never answered in this browser (on Windows: offer the download)
   * elsewhere: not a Windows browser; the companion runs on the GSPro PC
   */
  status: 'checking' | 'connected' | 'not-running' | 'not-installed' | 'elsewhere'
  release: string | null
  gspro: 'connected' | 'waiting' | 'ambiguous' | null
  latest: CompanionLatest | null
  update: CompanionUpdateState
  seen: CompanionSeen | null
  checkedAt: number | null
}>

export const POLL_MS = 15_000

/** One look at the companion, no React. */
export const checkCompanionPresence = async (latest: CompanionLatest | null): Promise<CompanionPresence> => {
  const seen = companionSeenBefore()
  try {
    const status = await readLooperCompanionStatus(2500)
    const release = (status as { release?: string }).release ?? status.version ?? null
    markCompanionSeen(release)
    return {
      status: 'connected', release, gspro: status.gspro.status, latest,
      update: companionUpdateState(release, latest), seen: companionSeenBefore(), checkedAt: Date.now(),
    }
  } catch {
    const status = seen ? 'not-running' : isWindowsBrowser() ? 'not-installed' : 'elsewhere'
    return { status, release: seen?.release ?? null, gspro: null, latest, update: 'unknown', seen, checkedAt: Date.now() }
  }
}
