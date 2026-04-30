import type { Club } from './bagConfig'

export type ShotVariant = {
  id: string
  name: string
  club?: Club
}

export const STOCK_SHOT_VARIANT_ID = 'stock'
export const SHOT_VARIANTS_STORAGE_KEY = 'nova-shot-variants'

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

const stockShotVariant: ShotVariant = {
  id: STOCK_SHOT_VARIANT_ID,
  name: 'Stock',
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
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { variants?: unknown }).variants)) {
      return (parsed as { variants: unknown[] }).variants
    }
  } catch {
    // Stock remains the safe fallback.
  }

  return []
}

export const getCustomShotVariants = () =>
  readStoredShotVariants().filter(isShotVariant)

export const saveCustomShotVariants = (variants: ShotVariant[]) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    SHOT_VARIANTS_STORAGE_KEY,
    JSON.stringify(variants.filter((variant) => variant.id !== STOCK_SHOT_VARIANT_ID)),
  )
}

export const getShotVariantsForClub = (club: Club): ShotVariant[] => {
  const storedVariants = getCustomShotVariants().filter((variant) => {
    return (
      !variant.club || variant.club === club
    )
  })

  return [
    stockShotVariant,
    ...storedVariants.filter((variant) => variant.id !== STOCK_SHOT_VARIANT_ID),
  ]
}
