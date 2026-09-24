import { loadBagConfig, saveBagConfig } from '../lib/bagConfig'
import {
  activateLocalUserScope,
  clearPreservedLegacyBackups,
  persistCacheValueForUser,
  SHOT_VARIANTS_DIRTY_STORAGE_KEY,
  SHOT_VARIANTS_STORAGE_KEY,
} from '../lib/localUserScope'
import { loadSavedSessions, saveSessionHistory } from '../lib/sessions'
import {
  getCustomShotVariants,
  normalizeCustomShotVariants,
  saveCustomShotVariants,
} from '../lib/shotVariants'
import type { SavedSession } from '../types'
import {
  hydrateDefaultBagForUser,
  hydrateSessionsForUser,
} from './cloudHydration'
import {
  syncBagConfigToCloud,
  syncSavedSessionToCloud,
} from './cloudPersistence'
import {
  loadShotVariantsForUser,
  syncShotVariantsToCloud,
} from './shotVariantCloud'

const BOOTSTRAP_VERSION = 3
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
  loadedCloudShotVariants: boolean
  warnings: string[]
}

export const bootstrapLooperCloudData = async (
  userId: string,
  options: { claimUnscopedLegacyData?: boolean } = {},
): Promise<CloudBootstrapResult> => {
  // This must happen before any user-owned local read. It prevents a second
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
  const hadLocalShotVariantCache =
    window.localStorage.getItem(SHOT_VARIANTS_STORAGE_KEY) !== null
  const localShotVariantsDirty =
    window.localStorage.getItem(SHOT_VARIANTS_DIRTY_STORAGE_KEY) === '1'
  const localShotVariants = getCustomShotVariants()
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

  let loadedCloudShotVariants = false
  let canHydrateCloudShotVariants = true

  // A dirty marker means a prior browser edit may have been interrupted by a
  // rapid logout. Upload that isolated local copy before reading cloud state so
  // an older cloud row cannot overwrite the newer golfer-owned edit.
  if (localShotVariantsDirty) {
    if (hadLocalShotVariantCache) {
      const dirtyVariantResult = await syncShotVariantsToCloud(localShotVariants, userId)
      if (dirtyVariantResult.status === 'synced') {
        persistCacheValueForUser(SHOT_VARIANTS_DIRTY_STORAGE_KEY, userId, null)
      } else {
        canHydrateCloudShotVariants = false
        warnings.push(
          dirtyVariantResult.status === 'failed'
            ? `Shot variants: ${dirtyVariantResult.error}`
            : `Shot variants: deferred (${dirtyVariantResult.reason})`,
        )
      }
    } else {
      // A marker without a local payload cannot represent a newer edit.
      persistCacheValueForUser(SHOT_VARIANTS_DIRTY_STORAGE_KEY, userId, null)
    }
  }

  if (canHydrateCloudShotVariants) {
    // Shot variant definitions are account data. Cloud is canonical once a row
    // exists, except when the dirty path above proved the local copy is newer.
    const cloudShotVariantRow = await loadShotVariantsForUser(userId)
    if (cloudShotVariantRow !== null) {
      const cloudShotVariants = normalizeCustomShotVariants(cloudShotVariantRow)
      if (
        !hadLocalShotVariantCache ||
        JSON.stringify(cloudShotVariants) !== JSON.stringify(localShotVariants)
      ) {
        saveCustomShotVariants(cloudShotVariants, { syncCloud: false })
        loadedCloudShotVariants = true
      }
    } else {
      const variantsToMigrate = hadLocalShotVariantCache ? localShotVariants : []
      if (!hadLocalShotVariantCache) {
        saveCustomShotVariants(variantsToMigrate, { syncCloud: false })
      }
      const variantResult = await syncShotVariantsToCloud(variantsToMigrate, userId)
      if (variantResult.status === 'failed') {
        warnings.push(`Shot variants: ${variantResult.error}`)
      } else if (variantResult.status === 'skipped') {
        warnings.push(`Shot variants: deferred (${variantResult.reason})`)
      }
    }
  }

  // Only mark the one-time migration complete when every attempted local upload
  // succeeded. A cloud read failure throws before this point, preserving retry.
  if (warnings.length === 0) {
    clearPreservedLegacyBackups()
    window.localStorage.setItem(key, 'done')
  }

  return {
    uploadedLocalSessions,
    downloadedCloudSessions: cloudSessions.length,
    mergedSessionCount: mergedSessions.length,
    sessionHistoryChanged,
    loadedCloudBag,
    loadedCloudShotVariants,
    warnings,
  }
}
