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
    launch_profile: {
      ball_speed_mph: stock.ballSpeed,
      vla_deg: stock.launch,
      hla_deg: stock.hla,
      total_spin_rpm: stock.spin,
      spin_axis_deg: stock.spinAxis,
      peak_height_yds: stock.peakHeight,
      descent_angle_deg: stock.descentAngle,
    },
  }
}
