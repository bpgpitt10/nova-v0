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
