import { loadBagConfig, saveBagConfig } from '../lib/bagConfig'
import { loadSavedSessions, saveSessionHistory } from '../lib/sessions'
import type { SavedSession } from '../types'
import {
  loadDefaultBagFromCloud,
  loadSavedSessionsFromCloud,
  syncBagConfigToCloud,
  syncSavedSessionToCloud,
} from './cloudPersistence'

const BOOTSTRAP_VERSION = 1
const bootstrapKey = (userId: string) => `looper-cloud-bootstrap-v${BOOTSTRAP_VERSION}:${userId}`

const mergeSessions = (local: SavedSession[], cloud: SavedSession[]) => {
  const byId = new Map<string, SavedSession>()

  cloud.forEach((session) => byId.set(session.id, session))
  // On the first migration pass, the current browser's local copy wins for an
  // identical session id because it is the data Looper has been actively using.
  local.forEach((session) => byId.set(session.id, session))

  return Array.from(byId.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export type CloudBootstrapResult = {
  uploadedLocalSessions: number
  downloadedCloudSessions: number
  mergedSessionCount: number
  loadedCloudBag: boolean
  warnings: string[]
}

export const bootstrapLooperCloudData = async (
  userId: string,
): Promise<CloudBootstrapResult> => {
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

  const cloudSessions = await loadSavedSessionsFromCloud()
  const mergedSessions = mergeSessions(localSessions, cloudSessions)
  if (JSON.stringify(mergedSessions) !== JSON.stringify(localSessions)) {
    saveSessionHistory(mergedSessions)
  }

  const cloudBag = await loadDefaultBagFromCloud()
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
    loadedCloudBag,
    warnings,
  }
}
