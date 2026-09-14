import { buildFlightPhysicsPrior, type FlightLaunchInput, type FlightPhysicsPrior } from './flightPhysics'
import {
  buildCaddieModelContract,
  type CaddieModelContract,
  type PlayerBaselineInput,
  type ShotContextInput,
} from './modelContract'

export type ModeledShotContext = {
  baseline: PlayerBaselineInput
  rawContext: ShotContextInput
  physicsPrior: FlightPhysicsPrior
  effectiveTargetDistanceYds: number | null
  modeledCarryYds: number | null
  modeledCarrySigmaYds: number | null
  modeledLateralBiasYds: number | null
  modeledLateralSigmaYds: number | null
  appliedAdjustments: {
    elevationYds: number
    windCarryYds: number
    windLateralYds: number
    surfaceCarryYds: number
    lieCarryYds: number
    lieLateralYds: number
  }
  contract: CaddieModelContract
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const launchFromBaseline = (baseline: PlayerBaselineInput): FlightLaunchInput | null => {
  if (
    !finite(baseline.launchBallSpeedMph) ||
    !finite(baseline.launchVlaDeg) ||
    !finite(baseline.launchSpinRpm)
  ) return null

  return {
    ballSpeedMph: baseline.launchBallSpeedMph,
    vlaDeg: baseline.launchVlaDeg,
    hlaDeg: baseline.launchHlaDeg ?? 0,
    totalSpinRpm: baseline.launchSpinRpm,
    spinAxisDeg: baseline.launchSpinAxisDeg ?? 0,
  }
}

/**
 * Canonical transformation boundary for Live Caddie context.
 *
 * The physics prior is allowed to calculate reviewable wind/elevation deltas,
 * but V1 still applies zero adjustment to the recommendation until GSPro residual
 * calibration is validated. The companion contract makes that distinction explicit.
 */
export const modelShotContext = (
  baseline: PlayerBaselineInput,
  context: ShotContextInput,
): ModeledShotContext => {
  const stockCarry = finite(baseline.stockCarryYds) ? baseline.stockCarryYds : null
  const carrySigma = finite(baseline.carrySigmaYds) ? baseline.carrySigmaYds : null
  const lateralBias = finite(baseline.lateralBiasYds) ? baseline.lateralBiasYds : null
  const lateralSigma = finite(baseline.lateralSigmaYds) ? baseline.lateralSigmaYds : null
  const targetDistance = finite(context.targetDistanceYds) ? context.targetDistanceYds : null

  const physicsPrior = buildFlightPhysicsPrior(
    launchFromBaseline(baseline),
    {
      windMph: context.windMph ?? 0,
      windRelativeDeg: context.windRelativeDeg ?? 0,
      landingElevationDeltaFt: context.elevationDeltaFt ?? 0,
    },
  )

  const appliedAdjustments = {
    elevationYds: 0,
    windCarryYds: 0,
    windLateralYds: 0,
    surfaceCarryYds: 0,
    lieCarryYds: 0,
    lieLateralYds: 0,
  }

  const contractContext: ShotContextInput = {
    ...context,
    physicsPrior,
  }

  return {
    baseline,
    rawContext: context,
    physicsPrior,
    effectiveTargetDistanceYds:
      targetDistance == null
        ? null
        : targetDistance + appliedAdjustments.elevationYds,
    modeledCarryYds:
      stockCarry == null
        ? null
        : stockCarry +
          appliedAdjustments.windCarryYds +
          appliedAdjustments.surfaceCarryYds +
          appliedAdjustments.lieCarryYds,
    modeledCarrySigmaYds: carrySigma,
    modeledLateralBiasYds:
      lateralBias == null
        ? null
        : lateralBias +
          appliedAdjustments.windLateralYds +
          appliedAdjustments.lieLateralYds,
    modeledLateralSigmaYds: lateralSigma,
    appliedAdjustments,
    contract: buildCaddieModelContract(baseline, contractContext),
  }
}
