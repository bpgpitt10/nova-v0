import {
  loadGsproDirectoryHandle,
  queryGsproDirectoryPermission,
  type BrowserDirectoryHandle,
} from '../adapters/browserGsproAccess'
import { loadSavedSessions } from '../lib/sessions'
import { getCurrentLooperUser } from '../cloud/supabaseClient'
import { buildLiveCaddieProfileSet } from './profileProvider'
import type { LiveCaddieProfileSet } from './types'

export const LIVE_CADDIE_PROFILE_FILENAME = 'looper-live-caddie-profiles.json'

type WritableFileHandle = {
  createWritable(): Promise<{
    write(data: string): Promise<void>
    close(): Promise<void>
    abort?(): Promise<void>
  }>
}

export type LiveCaddieProfilePublishResult =
  | {
      status: 'published'
      fileName: string
      clubs: number
      shots: number
      generatedAt: string
    }
  | {
      status: 'skipped'
      reason: 'no-gspro-handle' | 'permission-not-granted' | 'no-player-profiles'
    }
  | {
      status: 'failed'
      error: string
    }

const writeProfileFile = async (
  handle: BrowserDirectoryHandle,
  payload: LiveCaddieProfileSet & { owner?: { id: string; email?: string | null } },
) => {
  const fileHandle = await handle.getFileHandle(LIVE_CADDIE_PROFILE_FILENAME, {
    create: true,
  })
  const writableHandle = fileHandle as unknown as WritableFileHandle
  if (typeof writableHandle.createWritable !== 'function') {
    throw new Error('Browser GSPro folder handle does not support writing profile files.')
  }

  const writable = await writableHandle.createWritable()
  try {
    await writable.write(`${JSON.stringify(payload, null, 2)}\n`)
    await writable.close()
  } catch (error) {
    try {
      await writable.abort?.()
    } catch {
      // The original write error is the useful one.
    }
    throw error
  }
}

/**
 * Materialize the authenticated web player's existing Looper model into the local
 * GSPro folder. The Python live-caddie process reads this file; it never recalculates
 * Stock/Pure from Supabase rows and never needs the user's Supabase credentials.
 */
export const publishLiveCaddieProfilesToGsproFolder = async (): Promise<LiveCaddieProfilePublishResult> => {
  try {
    const handle = await loadGsproDirectoryHandle()
    if (!handle) {
      return { status: 'skipped', reason: 'no-gspro-handle' }
    }

    const permission = await queryGsproDirectoryPermission(handle, 'readwrite')
    if (permission !== 'granted') {
      return { status: 'skipped', reason: 'permission-not-granted' }
    }

    const sessions = loadSavedSessions()
    const profileSet = buildLiveCaddieProfileSet(sessions)
    if (profileSet.clubs.length === 0) {
      return { status: 'skipped', reason: 'no-player-profiles' }
    }

    const user = await getCurrentLooperUser()
    await writeProfileFile(handle, {
      ...profileSet,
      owner: user
        ? {
            id: user.id,
            email: user.email,
          }
        : undefined,
    })

    return {
      status: 'published',
      fileName: LIVE_CADDIE_PROFILE_FILENAME,
      clubs: profileSet.clubs.length,
      shots: profileSet.shot_count,
      generatedAt: profileSet.generated_at,
    }
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
