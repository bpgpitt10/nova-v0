import { syncShotVariantsToCloud } from '../cloud/shotVariantCloud'
import type { Club } from './bagConfig'
import {
  getActiveLocalUserId,
  persistCacheValueForUser,
  persistWorkingCacheValueForActiveUser,
  SHOT_VARIANTS_DIRTY_STORAGE_KEY,
  SHOT_VARIANTS_STORAGE_KEY,
} from './localUserScope'

export type ShotVariant = {
  id: string
  name: string
  club?: Club
}

export const STOCK_SHOT_VARIANT_ID = 'stock'

export const resolveShotVariantId = (shotVariantId?: string) =>
  shotVariantId?.trim() || STOCK_SHOT_VARIANT_ID

const isShotVariant = (variant: unknown): variant is ShotVariant => {
  if (!variant || typeof variant !== 'object') {
    return false
  }
  const candidate = variant as Partial<ShotVariant>
  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim() !== '' &&
    typeof candidate.name === 'string' &&
    candidate.name.trim() !== ''
  )
}

export const normalizeCustomShotVariants = (variants: unknown): ShotVariant[] =>
  Array.isArray(variants)
    ? variants
        .filter(isShotVariant)
        .filter((variant) => variant.id !== STOCK_SHOT_VARIANT_ID)
    : []

const stockShotVariant: ShotVariant = {
  id: STOCK_SHOT_VARIANT_ID,
  name: 'Full',
}

let pendingShotVariantSync: Promise<void> | null = null

const readStoredShotVariants = () => {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const raw = window.localStorage.getItem(SHOT_VARIANTS_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { variants?: unknown }).variants)
    ) {
      return (parsed as { variants: unknown[] }).variants
    }
  } catch {
    // Stock remains the safe fallback.
  }

  return []
}

export const getCustomShotVariants = () =>
  normalizeCustomShotVariants(readStoredShotVariants())

export const flushPendingShotVariantSync = async () => {
  await pendingShotVariantSync
}

export const saveCustomShotVariants = (
  variants: ShotVariant[],
  options: { syncCloud?: boolean } = {},
) => {
  if (typeof window === 'undefined') {
    return
  }

  const normalized = normalizeCustomShotVariants(variants)
  const serialized = JSON.stringify(normalized)
  window.localStorage.setItem(SHOT_VARIANTS_STORAGE_KEY, serialized)
  persistWorkingCacheValueForActiveUser(SHOT_VARIANTS_STORAGE_KEY, serialized)

  if (options.syncCloud === false) {
    return
  }

  const userId = getActiveLocalUserId()
  if (!userId) {
    return
  }

  // Mark the edit dirty before starting any async work. If logout wins the race,
  // the next bootstrap for this golfer uploads this newer local copy first rather
  // than replacing it with an older cloud row.
  window.localStorage.setItem(SHOT_VARIANTS_DIRTY_STORAGE_KEY, '1')
  persistWorkingCacheValueForActiveUser(SHOT_VARIANTS_DIRTY_STORAGE_KEY, '1')

  // Serialize writes so an older request cannot finish after a newer edit and
  // overwrite the cloud row. Only the newest queued write may clear the dirty bit.
  const previousSync = pendingShotVariantSync ?? Promise.resolve()
  let syncPromise: Promise<void>
  syncPromise = previousSync.then(async () => {
    const result = await syncShotVariantsToCloud(normalized, userId)
    if (result.status === 'synced') {
      if (pendingShotVariantSync === syncPromise) {
        persistCacheValueForUser(SHOT_VARIANTS_DIRTY_STORAGE_KEY, userId, null)
      }
      return
    }

    if (result.status === 'failed') {
      console.warn('[Cloud Sync] shot variant sync failed; local copy retained', {
        error: result.error,
      })
      return
    }

    console.info('[Cloud Sync] shot variant sync deferred; local copy retained', {
      reason: result.reason,
    })
  })

  pendingShotVariantSync = syncPromise
  void syncPromise.finally(() => {
    if (pendingShotVariantSync === syncPromise) {
      pendingShotVariantSync = null
    }
  })
}

export const getShotVariantsForClub = (club: Club): ShotVariant[] => {
  const storedVariants = getCustomShotVariants().filter((variant) => {
    return !variant.club || variant.club === club
  })

  return [
    stockShotVariant,
    ...storedVariants.filter((variant) => variant.id !== STOCK_SHOT_VARIANT_ID),
  ]
}

export const getShotVariantLabel = (club: Club, shotVariantId?: string) => {
  const resolvedId = resolveShotVariantId(shotVariantId)
  return (
    getShotVariantsForClub(club).find((variant) => variant.id === resolvedId)?.name ??
    stockShotVariant.name
  )
}

export const shotMatchesIdentity = (
  shot: { club: Club; shotVariantId?: string },
  club: Club,
  shotVariantId?: string,
) =>
  shot.club === club &&
  resolveShotVariantId(shot.shotVariantId) === resolveShotVariantId(shotVariantId)

export const shotsForClubVariant = <T extends { club: Club; shotVariantId?: string }>(
  shots: T[],
  club: Club,
  shotVariantId?: string,
) => shots.filter((shot) => shotMatchesIdentity(shot, club, shotVariantId))
