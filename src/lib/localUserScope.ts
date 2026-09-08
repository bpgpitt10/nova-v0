export const SESSION_HISTORY_STORAGE_KEY = 'nova-validation-sessions'
export const ACTIVE_SESSION_STORAGE_KEY = 'nova-validation-active-session'
export const BAG_CONFIG_STORAGE_KEY = 'nova-validation-bag-config'

const ACTIVE_LOCAL_USER_KEY = 'looper-active-local-user-v1'
const LEGACY_BACKUP_PREFIX = 'looper-unscoped-legacy-backup-v1:'

const scopedKey = (baseKey: string, userId: string) =>
  `${baseKey}:user:${userId}`

const managedKeys = [
  SESSION_HISTORY_STORAGE_KEY,
  ACTIVE_SESSION_STORAGE_KEY,
  BAG_CONFIG_STORAGE_KEY,
] as const

const dispatchLocalDataChanged = () => {
  window.dispatchEvent(new Event('looper-session-history-updated'))
  window.dispatchEvent(new Event('bag-config-updated'))
}

const copyWorkingCacheToScope = (userId: string) => {
  managedKeys.forEach((baseKey) => {
    const value = window.localStorage.getItem(baseKey)
    const targetKey = scopedKey(baseKey, userId)
    if (value == null) {
      window.localStorage.removeItem(targetKey)
    } else {
      window.localStorage.setItem(targetKey, value)
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
      window.localStorage.setItem(baseKey, value)
    }
  })
}

const preserveUnscopedLegacyCache = () => {
  managedKeys.forEach((baseKey) => {
    const value = window.localStorage.getItem(baseKey)
    if (value != null) {
      const backupKey = `${LEGACY_BACKUP_PREFIX}${baseKey}`
      if (window.localStorage.getItem(backupKey) == null) {
        window.localStorage.setItem(backupKey, value)
      }
    }
  })
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
) => {
  if (typeof window === 'undefined') {
    return
  }

  const currentUserId = getActiveLocalUserId()
  if (currentUserId === userId) {
    // The working cache already belongs to this user. Keep it as-is so a reload
    // does not discard newer offline-safe data that has not synced yet.
    return
  }

  if (currentUserId) {
    copyWorkingCacheToScope(currentUserId)
  } else if (options.claimUnscopedLegacyData) {
    // One-time migration of the old, pre-auth Looper browser cache.
    copyWorkingCacheToScope(userId)
  } else {
    // Do not silently throw old unscoped data away, but do not expose it to the
    // newly signed-in user either.
    preserveUnscopedLegacyCache()
  }

  clearWorkingCache()
  restoreScopeToWorkingCache(userId)
  window.localStorage.setItem(ACTIVE_LOCAL_USER_KEY, userId)
  dispatchLocalDataChanged()
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
  const key = scopedKey(baseKey, userId)
  if (value == null) {
    window.localStorage.removeItem(key)
  } else {
    window.localStorage.setItem(key, value)
  }
}

/**
 * Preserve the current user's safety copy, then clear the generic working cache
 * so a subsequent account cannot see it before its own scope is activated.
 */
export const deactivateLocalUserScope = () => {
  if (typeof window === 'undefined') {
    return
  }
  const userId = getActiveLocalUserId()
  if (userId) {
    copyWorkingCacheToScope(userId)
  }
  clearWorkingCache()
  window.localStorage.removeItem(ACTIVE_LOCAL_USER_KEY)
  dispatchLocalDataChanged()
}
