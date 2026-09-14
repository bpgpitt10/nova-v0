import { buildFlightPhysicsPrior, type FlightLaunchInput, type FlightPhysicsPrior } from './flightPhysics'
import {
  buildCaddieModelContract,
  type CaddieModelContract,
  type PlayerBaselineInput,
  type ShotContextInput,
} from './modelContract'
import {
  applySurfaceLaunchFactors,
  getSurfaceResponse,
  type SurfaceResponse,
} from './surfaceResponse'

export type ModeledShotContext = {
  baseline: PlayerBaselineInput
  rawContext: ShotContextInput
  physicsPrior: FlightPhysicsPrior
  surfaceResponse: SurfaceResponse
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
    surfaceLateralYds: number
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
 * Surface response uses observed GSPro launch-condition modifiers. The modifiers
 * are applied to the representative Stock launch packet and converted into a
 * physics delta, so measured Stock carry still remains authoritative.
 *
 * Physical-lie angle response remains blocked until separately validated.
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
  const launch = launchFromBaseline(baseline)
  const flightEnvironment = {
    windMph: context.windMph ?? 0,
    windRelativeDeg: context.windRelativeDeg ?? 0,
    landingElevationDeltaFt: context.elevationDeltaFt ?? 0,
  }

  const physicsPrior = buildFlightPhysicsPrior(launch, flightEnvironment)

  const combinedAirborneCarryYds = finite(physicsPrior.deltas.combinedCarryYds)
    ? physicsPrior.deltas.combinedCarryYds
    : 0
  const combinedAirborneLateralYds = finite(physicsPrior.deltas.combinedLateralYds)
    ? physicsPrior.deltas.combinedLateralYds
    : 0

  const surfaceResponse = getSurfaceResponse(context.surface)
  const surfaceLaunch = launch && surfaceResponse.modeled
    ? applySurfaceLaunchFactors(launch, surfaceResponse)
    : null
  const surfacePhysics =
    surfaceLaunch && surfaceResponse.kind !== 'baseline'
      ? buildFlightPhysicsPrior(surfaceLaunch, flightEnvironment)
      : null

  const surfaceCarryYds =
    surfacePhysics?.combined &&
    physicsPrior.combined &&
    finite(surfacePhysics.combined.carryYds) &&
    finite(physicsPrior.combined.carryYds)
      ? surfacePhysics.combined.carryYds - physicsPrior.combined.carryYds
      : 0
  const surfaceLateralYds =
    surfacePhysics?.combined &&
    physicsPrior.combined &&
    finite(surfacePhysics.combined.offlineYds) &&
    finite(physicsPrior.combined.offlineYds)
      ? surfacePhysics.combined.offlineYds - physicsPrior.combined.offlineYds
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
    surfaceCarryYds,
    surfaceLateralYds,
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
    surfaceResponse,
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
          appliedAdjustments.surfaceLateralYds +
          appliedAdjustments.lieLateralYds,
    modeledLateralSigmaYds: lateralSigma,
    appliedAdjustments,
    contract: buildCaddieModelContract(baseline, contractContext),
  }
}
