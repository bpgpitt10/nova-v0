import type { Club } from '../lib/bagConfig'
import type { ShotProfiles } from '../lib/shotProfiles'
import type { LiveCaddieClubProfile } from './types'

/**
 * Contract-only adapter from Looper's existing player model into the live-caddie
 * engine. This does not recalculate Stock/Pure; it passes through the outputs that
 * shotProfiles.ts already owns.
 */
export const shotProfilesToLiveCaddieClubProfile = (
  club: Club,
  profiles: ShotProfiles,
): LiveCaddieClubProfile | null => {
  const stock = profiles.mostLikely
  if (!stock || typeof stock.carry !== 'number') {
    return null
  }

  return {
    club: String(club),
    stock_carry_yds: stock.carry,
    carry_sigma_yds: stock.carryVariability,
    lateral_bias_yds: stock.offlineMean ?? 0,
    lateral_sigma_yds: stock.dispersionVariability,
    pure_carry_yds: profiles.bestAvailable?.carry,
  }
}
