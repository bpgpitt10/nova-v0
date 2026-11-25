/** A hard, club-identity eligibility rule, independent of carry, rank, or lie penalty. */
export type ShotOriginEligibility = 'tee' | 'non-tee' | 'unknown'

const normalizedClub = (club: string) =>
  club.trim().toLowerCase().replace(/[-_\s]+/g, ' ')

export const isTeeOnlyClub = (club: string): boolean => {
  const identity = normalizedClub(club)
  return identity === 'driver' || identity === 'mini driver'
}

/** If tee has not been affirmatively established, neither driver is eligible. */
export const clubEligibleForShot = (
  club: string,
  origin: ShotOriginEligibility,
): boolean => origin === 'tee' || !isTeeOnlyClub(club)

/** Preserve explicit authority from Live Caddie; only offline Aim Lab can
 * infer tee origin from an actual tee polygon when no live shot state exists. */
export const resolveShotOriginEligibility = (
  explicit: ShotOriginEligibility | undefined,
  surface: string | null | undefined,
): ShotOriginEligibility => {
  if (explicit != null) return explicit
  return surface?.trim().toLowerCase() === 'tee' ? 'tee' : 'unknown'
}

/** Fairway woods (3W, 5W, 7W, ...) and driver-type clubs: never Looper's pick from sand or deep rough. */
export const isWoodClub = (club: string): boolean => {
  const identity = normalizedClub(club)
  return isTeeOnlyClub(club) || /^\d+\s*w$/.test(identity) || /\bwood\b/.test(identity)
}

const normalizedSurface = (surface: string | null | undefined) =>
  (surface ?? '').trim().toLowerCase().replace(/[-_\s]+/g, '')

/** Sand and deep rough: GSPro lets a wood out, but no caddie would pick one (Brian, 25 Nov:
 * a 3 wood from a fairway bunker at Tobacco Road 4, hit 157 of 247). */
export const isWoodlessLie = (surface: string | null | undefined): boolean => {
  const value = normalizedSurface(surface)
  return value === 'sand' || value === 'bunker' || value === 'tvgsand'
    || value === 'deeprough' || value === 'tvgdeeprough'
}

/** May Looper recommend this club from this lie? The player can still arm it themselves. */
export const clubRecommendableFromLie = (club: string, surface: string | null | undefined): boolean =>
  !(isWoodlessLie(surface) && isWoodClub(club))
