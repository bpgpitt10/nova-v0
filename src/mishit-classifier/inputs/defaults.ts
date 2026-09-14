import type { MishitConfig } from '../types'

/**
 * Bump this whenever the meaning or default value of a shared classifier input
 * changes. Analyses keep the version so input changes can force a deterministic
 * reclassification instead of silently reusing stale results.
 */
export const MISHIT_INPUT_VERSION = 4

/**
 * Shared starter policy only. These are NOT Brian-specific thresholds.
 *
 * The shared boundaries are priors for cold start. As each club + shot-variant
 * population matures, its own robust variability receives increasing weight and
 * may tighten OR widen the boundary. Optional per-player learned/manual
 * boundaries live in MishitPlayerCalibration, not here.
 */
export const DEFAULT_MISHIT_INPUTS: MishitConfig = {
  version: MISHIT_INPUT_VERSION,
  sample: {
    provisionalSampleSize: 5,
    stableSampleSize: 12,
    maturePopulationSize: 30,
    maxReferenceShots: 50,
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
    mishitLossPriorYards: 12,
    severeLossPct: 0.22,
    severeLossPriorYards: 20,
  },
  direction: {
    mishitAbsolutePriorYards: 35,
    mishitPctOfCarryCenter: 0.20,
    severeAbsolutePriorYards: 55,
    severePctOfCarryCenter: 0.25,
    mishitDeviationPriorYards: 30,
    severeDeviationPriorYards: 45,
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
    maturityWeight: {
      playerWeightAtProvisional: 0.10,
      playerWeightAtStable: 0.50,
      playerWeightAtMature: 0.80,
      playerWeightAtMaxReference: 0.95,
    },
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
    // These are numerical guardrails, not golf-performance priors. They exist
    // only to prevent a zero/tiny MAD from collapsing a mature boundary toward
    // zero. They are intentionally far below the cold-start priors.
    sanityMinimums: {
      carry: {
        mishitLossYards: 2,
        severeLossYards: 4,
      },
      direction: {
        mishitAbsoluteYards: 5,
        severeAbsoluteYards: 10,
        mishitDeviationYards: 5,
        severeDeviationYards: 10,
      },
      ballSpeed: {
        mishitLossMph: 2,
        severeLossMph: 4,
      },
      smashFactor: {
        mishitLoss: 0.015,
        severeLoss: 0.03,
      },
    },
  },
}
