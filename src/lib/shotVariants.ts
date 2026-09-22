import { syncShotVariantsToCloud } from '../cloud/shotVariantCloud'
import type { Club } from './bagConfig'
import {
  persistWorkingCacheValueForActiveUser,
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

  void syncShotVariantsToCloud(normalized).then((result) => {
    if (result.status === 'failed') {
      console.warn('[Cloud Sync] shot variant sync failed; local copy retained', {
        error: result.error,
      })
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
