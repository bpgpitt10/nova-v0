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
    carryDeltaYds: atAltitude.carryYds - baseline.carryYds,
    lateralDeltaYds: atAltitude.offlineYds - baseline.offlineYds,
    status: 'ready',
    note: 'Air-density delta from the representative Stock launch packet versus the sea-level physics reference.',
  }
}
