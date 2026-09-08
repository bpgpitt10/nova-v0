import { loadBagConfig, saveBagConfig } from '../lib/bagConfig'
import { activateLocalUserScope } from '../lib/localUserScope'
import { loadSavedSessions, saveSessionHistory } from '../lib/sessions'
import type { SavedSession } from '../types'
import {
  hydrateDefaultBagForUser,
  hydrateSessionsForUser,
} from './cloudHydration'
import {
  syncBagConfigToCloud,
  syncSavedSessionToCloud,
} from './cloudPersistence'

const BOOTSTRAP_VERSION = 2
const bootstrapKey = (userId: string) => `looper-cloud-bootstrap-v${BOOTSTRAP_VERSION}:${userId}`

const mergeSessions = (local: SavedSession[], cloud: SavedSession[]) => {
  const byId = new Map<string, SavedSession>()

  cloud.forEach((session) => byId.set(session.id, session))
  // Within the already-isolated user scope, the browser's local copy wins for
  // an identical session id because it may contain newer offline-safe changes.
  local.forEach((session) => byId.set(session.id, session))

  return Array.from(byId.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export type CloudBootstrapResult = {
  uploadedLocalSessions: number
  downloadedCloudSessions: number
  mergedSessionCount: number
  sessionHistoryChanged: boolean
  loadedCloudBag: boolean
  warnings: string[]
}

export const bootstrapLooperCloudData = async (
  userId: string,
  options: { claimUnscopedLegacyData?: boolean } = {},
): Promise<CloudBootstrapResult> => {
  // This must happen before any session or bag read. It prevents a second
  // account on the same browser from seeing or uploading the first golfer's
  // local safety copy. Only an explicitly approved migration path may claim the
  // old pre-auth cache.
  activateLocalUserScope(userId, {
    claimUnscopedLegacyData: options.claimUnscopedLegacyData,
  })

  const warnings: string[] = []
  const key = bootstrapKey(userId)
  const hasBootstrapped = window.localStorage.getItem(key) === 'done'

  const localSessions = loadSavedSessions()
  const localBag = loadBagConfig()
  let uploadedLocalSessions = 0

  if (!hasBootstrapped) {
    for (const session of localSessions) {
      const result = await syncSavedSessionToCloud(session)
      if (result.status === 'synced') {
        uploadedLocalSessions += 1
      } else if (result.status === 'failed') {
        warnings.push(`Session ${session.id}: ${result.error}`)
      }
    }

    if (localBag) {
      const bagResult = await syncBagConfigToCloud(localBag.selectedClubs)
      if (bagResult.status === 'failed') {
        warnings.push(`Bag: ${bagResult.error}`)
      }
    }
  }

  // The auth gate has already resolved this exact user. Hydrate by that stable
  // user id rather than re-checking auth inside the read path and potentially
  // mistaking a startup timing gap for a genuinely empty account.
  const cloudSessions = await hydrateSessionsForUser(userId)
  const mergedSessions = mergeSessions(localSessions, cloudSessions)
  const sessionHistoryChanged =
    JSON.stringify(mergedSessions) !== JSON.stringify(localSessions)
  if (sessionHistoryChanged) {
    saveSessionHistory(mergedSessions)
  }

  const cloudBag = await hydrateDefaultBagForUser(userId)
  let loadedCloudBag = false
  if (!localBag && cloudBag?.length) {
    saveBagConfig(cloudBag)
    loadedCloudBag = true
  }

  // Only mark the one-time migration complete when every attempted local upload
  // succeeded. A cloud read failure throws before this point, preserving retry.
  if (warnings.length === 0) {
    window.localStorage.setItem(key, 'done')
  }

  return {
    uploadedLocalSessions,
    downloadedCloudSessions: cloudSessions.length,
    mergedSessionCount: mergedSessions.length,
    sessionHistoryChanged,
    loadedCloudBag,
    warnings,
  }
}
