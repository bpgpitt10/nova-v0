import type { ShotProfileSnapshot } from './shotProfiles'

export type StrategyShotDistribution = {
  carryMeanYards: number
  lateralMeanYards: number
  sigmaForwardYards: number
  sigmaLateralYards: number
  correlation: number
  source: 'most-likely-shot-profile'
  assumptions: string[]
}

export type StrategyShotDistributionResult =
  | {
      available: true
      distribution: StrategyShotDistribution
      unavailableReasons: []
    }
  | {
      available: false
      distribution: null
      unavailableReasons: string[]
    }

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * Convert Looper's existing most-likely club profile into the minimum 2-D landing
 * distribution needed by the geometry-only strategy risk engine.
 *
 * v0 deliberately does not pretend we know carry/offline covariance. The current
 * ShotProfileSnapshot exposes the two marginal spreads but not their correlation,
 * so correlation=0 is an explicit temporary assumption until the profile contract
 * stores empirical covariance/correlation.
 */
export const strategyShotDistributionFromProfile = (
  profile: ShotProfileSnapshot,
): StrategyShotDistributionResult => {
  const unavailableReasons: string[] = []

  if (!profile) {
    return {
      available: false,
      distribution: null,
      unavailableReasons: ['shot profile unavailable'],
    }
  }

  if (!finiteNumber(profile.carry)) {
    unavailableReasons.push('carry mean unavailable')
  }
  if (!finiteNumber(profile.carryVariability) || profile.carryVariability <= 0) {
    unavailableReasons.push('carry variability unavailable')
  }
  if (!finiteNumber(profile.offlineMean)) {
    unavailableReasons.push('offline mean unavailable')
  }
  if (!finiteNumber(profile.dispersionVariability) || profile.dispersionVariability <= 0) {
    unavailableReasons.push('offline variability unavailable')
  }

  if (unavailableReasons.length > 0) {
    return {
      available: false,
      distribution: null,
      unavailableReasons,
    }
  }

  return {
    available: true,
    distribution: {
      carryMeanYards: profile.carry as number,
      lateralMeanYards: profile.offlineMean as number,
      sigmaForwardYards: profile.carryVariability as number,
      sigmaLateralYards: profile.dispersionVariability as number,
      correlation: 0,
      source: 'most-likely-shot-profile',
      assumptions: [
        'carry/offline correlation is not yet stored in ShotProfileSnapshot; v0 uses correlation=0',
      ],
    },
    unavailableReasons: [],
  }
}
