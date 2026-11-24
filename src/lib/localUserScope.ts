export const SESSION_HISTORY_STORAGE_KEY = 'nova-validation-sessions'
export const ACTIVE_SESSION_STORAGE_KEY = 'nova-validation-active-session'
export const BAG_CONFIG_STORAGE_KEY = 'nova-validation-bag-config'
export const SHOT_VARIANTS_STORAGE_KEY = 'nova-shot-variants'
export const SHOT_VARIANTS_DIRTY_STORAGE_KEY = 'nova-shot-variants-dirty-v1'
export const MISHIT_PLAYER_CALIBRATIONS_STORAGE_KEY = 'looper-mishit-player-calibrations-v1'
export const RETIRED_HUMAN_SHOT_REVIEWS_STORAGE_KEY = 'looper-human-shot-reviews-v1'
export const LIVE_GSPRO_ROUND_ARCHIVE_STORAGE_KEY = 'looper-live-gspro-round-archive-v1'
export const LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY = 'looper-live-caddie-armed-club-v1'
export const LIVE_CADDIE_LINEAGE_STORAGE_KEY = 'looper-live-caddie-lineage-v1'
export const QUICK_BAG_STORAGE_KEY = 'looper-quick-bag-v1'

const ACTIVE_LOCAL_USER_KEY = 'looper-active-local-user-v1'
const LEGACY_BACKUP_PREFIX = 'looper-unscoped-legacy-backup-v1:'

const scopedKey = (baseKey: string, userId: string) =>
  `${baseKey}:user:${userId}`

const managedKeys = [
  SESSION_HISTORY_STORAGE_KEY,
  ACTIVE_SESSION_STORAGE_KEY,
  BAG_CONFIG_STORAGE_KEY,
  SHOT_VARIANTS_STORAGE_KEY,
  SHOT_VARIANTS_DIRTY_STORAGE_KEY,
  MISHIT_PLAYER_CALIBRATIONS_STORAGE_KEY,
  LIVE_GSPRO_ROUND_ARCHIVE_STORAGE_KEY,
  LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY,
  LIVE_CADDIE_LINEAGE_STORAGE_KEY,
  QUICK_BAG_STORAGE_KEY,
] as const

const dispatchLocalDataChanged = () => {
  window.dispatchEvent(new Event('looper-session-history-updated'))
  window.dispatchEvent(new Event('bag-config-updated'))
  window.dispatchEvent(new Event('looper-live-caddie-armed-club-updated'))
  window.dispatchEvent(new Event('looper-quick-bag-updated'))
}

const purgeRetiredHumanShotReviews = () => {
  window.localStorage.removeItem(RETIRED_HUMAN_SHOT_REVIEWS_STORAGE_KEY)
}

/**
 * Caches that can be rebuilt: the round archive comes back from GSPro's own files and the
 * account, the caddie lineage from the account. They are also the big ones. When the browser's
 * storage is full they are the first to go, and losing one is never an error.
 */
const rebuildableKeys: readonly string[] = [
  LIVE_GSPRO_ROUND_ARCHIVE_STORAGE_KEY,
  LIVE_CADDIE_LINEAGE_STORAGE_KEY,
]

const allStorageKeys = () => {
  const keys: string[] = []
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (key != null) keys.push(key)
  }
  return keys
}

/**
 * Make room: drop the old pre-sign-in backups of the big caches, and other accounts' copies of
 * them. Each of those accounts gets its own back from GSPro and the cloud when it next signs in.
 */
const freeRebuildableSpace = (keepUserId: string) => {
  allStorageKeys().forEach((key) => {
    const mine = rebuildableKeys.some((baseKey) => key === scopedKey(baseKey, keepUserId))
    const someonesCopy = rebuildableKeys.some((baseKey) => key.startsWith(`${baseKey}:user:`))
    const oldBackup = rebuildableKeys.some((baseKey) => key === `${LEGACY_BACKUP_PREFIX}${baseKey}`)
    if (oldBackup || (someonesCopy && !mine)) window.localStorage.removeItem(key)
  })
}

/**
 * Save one account's copy of a value. A full browser store (5 MB, and the round archive is big:
 * two accounts on one browser filled it on 23 Nov 2026 and blocked sign-in and sign-out) is
 * handled by making room and trying once more. A rebuildable cache that still doesn't fit is
 * dropped; anything else is the player's own data and the failure is reported.
 */
const setScopedValue = (baseKey: string, userId: string, value: string) => {
  const targetKey = scopedKey(baseKey, userId)
  try {
    window.localStorage.setItem(targetKey, value)
    return
  } catch {
    freeRebuildableSpace(userId)
  }
  try {
    window.localStorage.setItem(targetKey, value)
  } catch (error) {
    if (!rebuildableKeys.includes(baseKey)) throw error
    window.localStorage.removeItem(targetKey)
  }
}

/** The same for the shared working cache. */
const setWorkingValue = (baseKey: string, userId: string, value: string) => {
  try {
    window.localStorage.setItem(baseKey, value)
    return
  } catch {
    freeRebuildableSpace(userId)
  }
  try {
    window.localStorage.setItem(baseKey, value)
  } catch (error) {
    if (!rebuildableKeys.includes(baseKey)) throw error
    window.localStorage.removeItem(baseKey)
  }
}

/**
 * Put the working cache away under its account. Always followed by clearing the working cache,
 * so each value is moved, not copied: the store never holds it twice.
 */
const copyWorkingCacheToScope = (userId: string) => {
  managedKeys.forEach((baseKey) => {
    const value = window.localStorage.getItem(baseKey)
    const targetKey = scopedKey(baseKey, userId)
    if (value == null) {
      window.localStorage.removeItem(targetKey)
    } else {
      window.localStorage.removeItem(baseKey)
      window.localStorage.removeItem(targetKey)
      setScopedValue(baseKey, userId, value)
    }
  })
}

/**
 * Signing out, or handing the browser to another account, always completes. If the departing
 * account's copy can't be saved (a full store), the next account still must not see it: the
 * caller clears the working cache either way, and that account's data comes back from the cloud.
 */
const putAwayWorkingCache = (userId: string) => {
  try {
    copyWorkingCacheToScope(userId)
  } catch (error) {
    console.warn('[Looper] could not keep a local copy for the account leaving this browser.', error)
  }
}

const claimUnscopedWorkingCacheToScope = (userId: string) => {
  managedKeys.forEach((baseKey) => {
    const value = window.localStorage.getItem(baseKey)
    if (value != null) {
      // Migration is additive: an empty shared cache on a later login must not
      // erase a previously established user-scoped safety copy.
      setScopedValue(baseKey, userId, value)
    }
  })
}

const clearWorkingCache = () => {
  managedKeys.forEach((baseKey) => window.localStorage.removeItem(baseKey))
}

const restoreScopeToWorkingCache = (userId: string) => {
  managedKeys.forEach((baseKey) => {
    const value = window.localStorage.getItem(scopedKey(baseKey, userId))
    if (value == null) {
      window.localStorage.removeItem(baseKey)
    } else {
      setWorkingValue(baseKey, userId, value)
    }
  })
}

const preserveUnscopedLegacyCache = () => {
  managedKeys.forEach((baseKey) => {
    const value = window.localStorage.getItem(baseKey)
    if (value != null) {
      const backupKey = `${LEGACY_BACKUP_PREFIX}${baseKey}`
      // The big rebuildable caches aren't worth a backup: it is what fills the store.
      if (!rebuildableKeys.includes(baseKey) && window.localStorage.getItem(backupKey) == null) {
        try {
          window.localStorage.setItem(backupKey, value)
        } catch {
          // No room for a safety copy of old pre-sign-in data: carry on without it.
        }
      }
    }
  })
}

export const clearPreservedLegacyBackups = () => {
  if (typeof window === 'undefined') {
    return
  }
  managedKeys.forEach((baseKey) => {
    window.localStorage.removeItem(`${LEGACY_BACKUP_PREFIX}${baseKey}`)
  })
  purgeRetiredHumanShotReviews()
}

/**
 * The account this tab last ran as. Pages read user data into memory when they load, so a tab
 * that has held one account's data must start again before it shows or saves another's
 * (23 Nov 2026: a verification link opened in a browser signed in to another account, and the
 * new account's Bag page showed the first account's sessions from memory).
 */
let tabUserId: string | null = null

/** Any managed value in the shared working cache right now. */
const workingCacheHasData = () =>
  managedKeys.some((baseKey) => window.localStorage.getItem(baseKey) != null)

/**
 * Another tab switched this browser to a different account: this tab still holds the old
 * account's data in memory. Start again before it can show it or save it under the new one.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== ACTIVE_LOCAL_USER_KEY || tabUserId == null) return
    if (event.newValue != null && event.newValue !== tabUserId) window.location.reload()
  })
}

/** False when the working cache now belongs to a different account than this tab ran as. */
export const workingCacheBelongsToThisTab = () => {
  if (typeof window === 'undefined' || tabUserId == null) return true
  const active = getActiveLocalUserId()
  return active == null || active === tabUserId
}

export const getActiveLocalUserId = () => {
  if (typeof window === 'undefined') {
    return null
  }
  return window.localStorage.getItem(ACTIVE_LOCAL_USER_KEY)
}

/**
 * Make the generic working cache represent exactly one signed-in Looper user.
 *
 * Existing pre-auth local data may be claimed only when the caller explicitly
 * allows it (currently the invited admin migration path). Normal invited users
 * never inherit an unscoped cache from another golfer.
 */
export const activateLocalUserScope = (
  userId: string,
  options: { claimUnscopedLegacyData?: boolean } = {},
): { replacedAnotherAccount: boolean } => {
  if (typeof window === 'undefined') {
    return { replacedAnotherAccount: false }
  }

  purgeRetiredHumanShotReviews()

  // This tab ran as someone else, or the cache it loaded from was someone else's: whatever the
  // page read into memory before now is not this account's. The caller must reload.
  const previousTabUser = tabUserId
  const currentUserId = getActiveLocalUserId()
  const replacedAnotherAccount =
    (previousTabUser != null && previousTabUser !== userId)
    || (currentUserId != null && currentUserId !== userId)
    || (currentUserId == null && !options.claimUnscopedLegacyData && workingCacheHasData())
  tabUserId = userId

  if (currentUserId === userId) {
    // The working cache already belongs to this user. Keep it as-is so a reload
    // does not discard newer offline-safe data that has not synced yet.
    return { replacedAnotherAccount }
  }

  if (currentUserId) {
    putAwayWorkingCache(currentUserId)
  } else if (options.claimUnscopedLegacyData) {
    // One-time migration of the old, pre-auth Looper browser cache.
    claimUnscopedWorkingCacheToScope(userId)
  } else {
    // Do not silently throw old unscoped data away, but do not expose it to the
    // newly signed-in user either.
    preserveUnscopedLegacyCache()
  }

  clearWorkingCache()
  restoreScopeToWorkingCache(userId)
  window.localStorage.setItem(ACTIVE_LOCAL_USER_KEY, userId)
  dispatchLocalDataChanged()
  return { replacedAnotherAccount }
}

export const persistCacheValueForUser = (
  baseKey: string,
  userId: string,
  value: string | null,
) => {
  if (typeof window === 'undefined') {
    return
  }

  const key = scopedKey(baseKey, userId)
  if (value == null) {
    window.localStorage.removeItem(key)
  } else {
    setScopedValue(baseKey, userId, value)
  }

  // Keep the generic working cache in sync only when it still belongs to the
  // same golfer. A late async completion must never mutate the next user's view.
  if (getActiveLocalUserId() === userId) {
    if (value == null) {
      window.localStorage.removeItem(baseKey)
    } else {
      setWorkingValue(baseKey, userId, value)
    }
  }
}

export const persistWorkingCacheValueForActiveUser = (
  baseKey: string,
  value: string | null,
) => {
  if (typeof window === 'undefined') {
    return
  }
  const userId = getActiveLocalUserId()
  if (!userId) {
    return
  }
  // A tab still running as the previous account must not save its memory under the new one.
  if (tabUserId != null && tabUserId !== userId) {
    return
  }
  persistCacheValueForUser(baseKey, userId, value)
}

/**
 * Preserve the current user's safety copy, then clear the generic working cache
 * so a subsequent account cannot see it before its own scope is activated.
 */
export const deactivateLocalUserScope = () => {
  if (typeof window === 'undefined') {
    return
  }
  purgeRetiredHumanShotReviews()
  const userId = getActiveLocalUserId()
  if (userId) {
    putAwayWorkingCache(userId)
  }
  clearWorkingCache()
  window.localStorage.removeItem(ACTIVE_LOCAL_USER_KEY)
  dispatchLocalDataChanged()
}
