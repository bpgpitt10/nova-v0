import { gsproCarryRatio } from './gsproCarryModel'
import { buildFlightPhysicsPrior, type FlightLaunchInput, type FlightPhysicsPrior } from './flightPhysics'
import {
  buildSidehillLieResponse,
  buildUpDownLieResponse,
  type SidehillLieResponse,
  type UpDownLieResponse,
} from './lieResponse'
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
  sidehillLieResponse: SidehillLieResponse
  upDownLieResponse: UpDownLieResponse
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
 * Sidehill physical lie uses the existing conservative loft-aware geometric prior
 * at 50% of the raw geometric effect. Up/down uses a weaker provisional prior:
 * 25% of measured slope is applied to VLA, capped at ±3°, and the resulting carry
 * response is capped at ±3% of measured Stock carry.
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

  // The flight model runs long against GSPro: its changes in yards are taken as a share of
  // its own carry and applied to the player's measured carry.
  const simulatedStock = physicsPrior.baseline?.carryYds
  const carryScale = stockCarry != null && finite(simulatedStock) && simulatedStock > 1
    ? Math.min(1.25, Math.max(0.75, stockCarry / simulatedStock))
    : 1
  const combinedAirborneCarryYds = finite(physicsPrior.deltas.combinedCarryYds)
    ? physicsPrior.deltas.combinedCarryYds * carryScale
    : 0
  const combinedAirborneLateralYds = finite(physicsPrior.deltas.combinedLateralYds)
    ? physicsPrior.deltas.combinedLateralYds
    : 0

  const surfaceResponse = getSurfaceResponse(context.surface, launch)
  const surfaceLaunch = launch && surfaceResponse.modeled
    ? applySurfaceLaunchFactors(launch, surfaceResponse)
    : null
  const surfacePhysics =
    surfaceLaunch && surfaceResponse.kind !== 'baseline'
      ? buildFlightPhysicsPrior(surfaceLaunch, flightEnvironment)
      : null

  // What the lie takes off the carry: GSPro's own carry for the penalised launch against the
  // clean one, when both are inside what was measured; the flight model otherwise.
  const surfaceRatio = surfaceLaunch && surfaceResponse.kind !== 'baseline' ? gsproCarryRatio(launch, surfaceLaunch) : null
  const surfaceCarryYds =
    surfaceRatio != null && stockCarry != null
      ? stockCarry * (surfaceRatio - 1)
      : surfacePhysics?.combined &&
        physicsPrior.combined &&
        finite(surfacePhysics.combined.carryYds) &&
        finite(physicsPrior.combined.carryYds)
        ? (surfacePhysics.combined.carryYds - physicsPrior.combined.carryYds) * carryScale
        : 0
  const surfaceLateralYds =
    surfacePhysics?.combined &&
    physicsPrior.combined &&
    finite(surfacePhysics.combined.offlineYds) &&
    finite(physicsPrior.combined.offlineYds)
      ? surfacePhysics.combined.offlineYds - physicsPrior.combined.offlineYds
      : 0

  const preLieCarryYds = stockCarry == null
    ? null
    : stockCarry + combinedAirborneCarryYds + surfaceCarryYds
  const upDownLieResponse = buildUpDownLieResponse({
    launch: surfaceLaunch ?? launch,
    environment: flightEnvironment,
    lieUpDownDeg: context.lieUpDownDeg,
    stockCarryYds: stockCarry,
  })
  const physicalLieCarryYds = preLieCarryYds == null
    ? null
    : preLieCarryYds + (upDownLieResponse.status === 'ready' ? upDownLieResponse.carryDeltaYds : 0)
  // Convert sidehill angle to yards at the final carry after wind, elevation,
  // surface and the conservative fore/aft lie prior have all been applied.
  const sidehillLieResponse = buildSidehillLieResponse({
    club: baseline.club,
    lieLeftRightDeg: context.lieLeftRightDeg,
    carryYds: physicalLieCarryYds,
    launchVlaDeg: (surfaceLaunch ?? launch)?.vlaDeg,
  })

  const appliedAdjustments = {
    elevationYds: finite(physicsPrior.deltas.elevationCarryYds)
      ? physicsPrior.deltas.elevationCarryYds * carryScale
      : 0,
    windCarryYds: finite(physicsPrior.deltas.windCarryYds)
      ? physicsPrior.deltas.windCarryYds * carryScale
      : 0,
    windLateralYds: finite(physicsPrior.deltas.windLateralYds)
      ? physicsPrior.deltas.windLateralYds
      : 0,
    combinedAirborneCarryYds,
    combinedAirborneLateralYds,
    surfaceCarryYds,
    surfaceLateralYds,
    lieCarryYds: upDownLieResponse.status === 'ready'
      ? upDownLieResponse.carryDeltaYds
      : 0,
    lieLateralYds: sidehillLieResponse.status === 'ready'
      ? sidehillLieResponse.lateralDeltaYds
      : 0,
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
    sidehillLieResponse,
    upDownLieResponse,
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
