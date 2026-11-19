import {
  simulateFlight,
  type FlightLaunchInput,
} from './flightPhysics'

export type AirAltitudeAdjustment = {
  altitudeFt: number | null
  carryDeltaYds: number
  lateralDeltaYds: number
  status: 'ready' | 'unavailable'
  note: string
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * How much further (as a fraction of carry) GSPro flies this launch at altitude.
 *
 * Measured on the Practice Range (GSPro 4.1.9, 18 Nov 2026): the 25 designed
 * launches at 0, 2,500 and 5,000 ft. The gain is linear in altitude (the
 * 5,000 ft gain is 1.93x the 2,500 ft gain) and depends on the launch: about
 * 0.8% per 1,000 ft for a driver, 1.2% for a 7-iron, 1.4% for a wedge, and
 * slightly negative for a slow, low, low-spin shot. Fitted per 1,000 ft on
 * ball speed, launch angle, spin and their pairs; holding out each shot it is
 * right to 0.7 yd on average (worst 3.9).
 *
 * The flight model's own answer was about half of GSPro's and went the wrong
 * way for slower shots (median +0.1% at 2,500 ft against GSPro's +4.0%).
 */
const ALTITUDE_FIT = {
  base: -0.0425681, speed: 0.000205755, vla: 0.000730253, spinK: 0.00424163,
  speedVla: 4.1983e-6, speedSpinK: -6.85368e-6, vlaSpinK: -9.9394e-5,
} as const
const within = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export const gsproAltitudeCarryFraction = (launch: FlightLaunchInput, altitudeFt: number): number => {
  // Held inside what was measured, so an odd launch can't push the fit somewhere silly.
  const speed = within(launch.ballSpeedMph, 70, 165)
  const vla = within(launch.vlaDeg, 9, 30)
  const spinK = within(launch.totalSpinRpm, 2200, 10200) / 1000
  const perThousandFt = ALTITUDE_FIT.base + ALTITUDE_FIT.speed * speed + ALTITUDE_FIT.vla * vla + ALTITUDE_FIT.spinK * spinK
    + ALTITUDE_FIT.speedVla * speed * vla + ALTITUDE_FIT.speedSpinK * speed * spinK + ALTITUDE_FIT.vlaSpinK * vla * spinK
  return perThousandFt * within(altitudeFt, -1000, 12000) / 1000
}

/**
 * Convert absolute course elevation into a player-relative flight delta.
 *
 * Looper keeps the player's observed Stock carry as the authority. The physics
 * model is only used to estimate how the same representative launch packet
 * changes in thinner/denser air versus the sea-level reference condition.
 * Rollout remains the player's observed Stock rollout until landing-surface
 * rollout physics are separately validated.
 */
export const buildAirAltitudeAdjustment = (
  launch: FlightLaunchInput | null,
  altitudeFt: number | null | undefined,
  /** The player's own carry with this club. The gain is a share of this, not of the simulated carry. */
  stockCarryYds?: number | null,
): AirAltitudeAdjustment => {
  if (!launch || !finite(altitudeFt)) {
    return {
      altitudeFt: finite(altitudeFt) ? altitudeFt : null,
      carryDeltaYds: 0,
      lateralDeltaYds: 0,
      status: 'unavailable',
      note: 'Absolute course elevation or representative launch data are unavailable.',
    }
  }

  const baseline = simulateFlight(launch, {})
  const atAltitude = simulateFlight(launch, { airAltitudeFt: altitudeFt })
  if (
    !baseline.ok ||
    !atAltitude.ok ||
    !finite(baseline.carryYds) ||
    !finite(atAltitude.carryYds) ||
    !finite(baseline.offlineYds) ||
    !finite(atAltitude.offlineYds)
  ) {
    return {
      altitudeFt,
      carryDeltaYds: 0,
      lateralDeltaYds: 0,
      status: 'unavailable',
      note: 'Altitude flight simulation did not produce a usable landing solution.',
    }
  }

  return {
    altitudeFt,
    // Carry: GSPro's own altitude effect, measured. Sideways: still the flight model's.
    // A share of the player's real carry: the simulation runs long for irons (a 158 yd 7-iron simulates at 170).
    carryDeltaYds: gsproAltitudeCarryFraction(launch, altitudeFt)
      * (finite(stockCarryYds) && stockCarryYds > 0 ? stockCarryYds : baseline.carryYds),
    lateralDeltaYds: atAltitude.offlineYds - baseline.offlineYds,
    status: 'ready',
    note: 'Carry change from GSPro\'s measured altitude effect for this launch (50 range shots at 2,500 and 5,000 ft); sideways change from the flight model.',
  }
}
