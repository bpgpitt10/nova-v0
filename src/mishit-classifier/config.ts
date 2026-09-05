import type { MishitConfig } from './types'

/**
 * Initial shadow-mode assumptions.
 *
 * IMPORTANT: these values are deliberately centralized here so they can be
 * reviewed, copied, tuned, and versioned without reading classifier logic.
 * They are not yet authoritative for Looper Stock/Pure calculations.
 */
export const DEFAULT_MISHIT_CONFIG: MishitConfig = {
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
}
