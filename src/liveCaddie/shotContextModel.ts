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
    combinedAirborneCarryYds: number
    combinedAirborneLateralYds: number
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
 * V1 treats the open airborne physics model as the provisional operative model for
 * wind + landing elevation. Measured Stock carry remains the anchor; only the
 * condition delta from the physics model moves the shot center. GSPro-specific
 * residual calibration can be added later without changing that architecture.
 *
 * Surface and physical-lie response remain blocked until separately validated.
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

  const combinedAirborneCarryYds = finite(physicsPrior.deltas.combinedCarryYds)
    ? physicsPrior.deltas.combinedCarryYds
    : 0
  const combinedAirborneLateralYds = finite(physicsPrior.deltas.combinedLateralYds)
    ? physicsPrior.deltas.combinedLateralYds
    : 0

  const appliedAdjustments = {
    elevationYds: finite(physicsPrior.deltas.elevationCarryYds)
      ? physicsPrior.deltas.elevationCarryYds
      : 0,
    windCarryYds: finite(physicsPrior.deltas.windCarryYds)
      ? physicsPrior.deltas.windCarryYds
      : 0,
    windLateralYds: finite(physicsPrior.deltas.windLateralYds)
      ? physicsPrior.deltas.windLateralYds
      : 0,
    combinedAirborneCarryYds,
    combinedAirborneLateralYds,
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
    // Elevation is already represented by the airborne trajectory delta. Keeping
    // the geometric target unchanged prevents a second plays-like adjustment.
    effectiveTargetDistanceYds: targetDistance,
    modeledCarryYds:
      stockCarry == null
        ? null
        : stockCarry +
          combinedAirborneCarryYds +
          appliedAdjustments.surfaceCarryYds +
          appliedAdjustments.lieCarryYds,
    modeledCarrySigmaYds: carrySigma,
    modeledLateralBiasYds:
      lateralBias == null
        ? null
        : lateralBias +
          combinedAirborneLateralYds +
          appliedAdjustments.lieLateralYds,
    modeledLateralSigmaYds: lateralSigma,
    appliedAdjustments,
    contract: buildCaddieModelContract(baseline, contractContext),
  }
}
