import type { MishitConfig } from '../types'

/**
 * Bump this whenever the meaning or default value of a shared classifier input
 * changes. Analyses keep the version so input changes can force a deterministic
 * reclassification instead of silently reusing stale results.
 */
export const MISHIT_INPUT_VERSION = 2

/**
 * Shared starter policy only. These are NOT Brian-specific thresholds.
 *
 * Player-specific centers and variability come from each club + shot-variant
 * population. Optional per-player boundary overrides live in
 * MishitPlayerCalibration, not here.
 */
export const DEFAULT_MISHIT_INPUTS: MishitConfig = {
  version: MISHIT_INPUT_VERSION,
  sample: {
    provisionalSampleSize: 5,
    stableSampleSize: 12,
    maturePopulationSize: 30,
    maxReferenceShots: 100,
  },
  refresh: {
    earlyEveryNewShots: 5,
    matureEveryNewShots: 10,
    fullReclassUntilSampleSize: 30,
    baselineChange: {
      carryCenterPct: 0.03,
      offlineCenterYards: 3,
      ballSpeedCenterPct: 0.03,
      smashFactorAbsolute: 0.03,
    },
  },
  baselineRefinement: {
    enabled: true,
    maxPasses: 2,
  },
  carry: {
    mishitLossPct: 0.15,
    mishitLossFloorYards: 12,
    severeLossPct: 0.22,
    severeLossFloorYards: 20,
  },
  direction: {
    mishitAbsoluteFloorYards: 35,
    mishitPctOfCarryCenter: 0.2,
    severeAbsoluteFloorYards: 55,
    severePctOfCarryCenter: 0.25,
    mishitDeviationFromCenterYards: 30,
    severeDeviationFromCenterYards: 45,
  },
  strike: {
    ballSpeedMishitLossPct: 0.12,
    ballSpeedSevereLossPct: 0.18,
    smashFactorMishitLoss: 0.08,
    smashFactorSevereLoss: 0.13,
  },
  compound: {
    mishitSignalCount: 2,
    severeSignalCount: 3,
  },
  personalization: {
    enabled: true,
    stableBaselineOnly: true,
    carryMadMultiplier: {
      mishit: 4.5,
      severe: 6.5,
    },
    directionMadMultiplier: {
      mishit: 4.5,
      severe: 6.5,
    },
    ballSpeedMadMultiplier: {
      mishit: 4.5,
      severe: 6.5,
    },
    smashFactorMadMultiplier: {
      mishit: 4.5,
      severe: 6.5,
    },
  },
}
