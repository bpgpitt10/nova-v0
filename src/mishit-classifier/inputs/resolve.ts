import type { MishitBaseline, MishitConfig } from '../types'
import type {
  MishitEffectiveThresholdDetail,
  MishitEffectiveThresholds,
  MishitPlayerCalibration,
} from './types'

const finiteNonNegative = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined

const finitePositive = (value: number | undefined) => {
  const candidate = finiteNonNegative(value)
  return typeof candidate === 'number' && candidate > 0 ? candidate : undefined
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const interpolate = (
  value: number,
  fromValue: number,
  toValue: number,
  fromWeight: number,
  toWeight: number,
) => {
  if (toValue <= fromValue) {
    return toWeight
  }
  const progress = clamp01((value - fromValue) / (toValue - fromValue))
  return fromWeight + (toWeight - fromWeight) * progress
}

/**
 * The global classifier policy is a cold-start prior, not a permanent floor.
 * The player population earns increasing influence as sample maturity grows.
 */
export const resolveMishitPlayerWeight = (
  baseline: MishitBaseline,
  config: MishitConfig,
) => {
  if (!config.personalization.enabled) {
    return 0
  }

  const sampleSize = baseline.referenceShotCount
  const provisionalSize = Math.max(1, config.sample.provisionalSampleSize)
  const stableSize = Math.max(provisionalSize, config.sample.stableSampleSize)
  const matureSize = Math.max(stableSize, config.sample.maturePopulationSize)
  const maxReferenceSize = Math.max(matureSize, config.sample.maxReferenceShots)

  if (sampleSize < provisionalSize) {
    return 0
  }

  const configured = config.personalization.maturityWeight
  const provisionalWeight = clamp01(configured.playerWeightAtProvisional)
  const stableWeight = Math.max(
    provisionalWeight,
    clamp01(configured.playerWeightAtStable),
  )
  const matureWeight = Math.max(
    stableWeight,
    clamp01(configured.playerWeightAtMature),
  )
  const maxReferenceWeight = Math.max(
    matureWeight,
    clamp01(configured.playerWeightAtMaxReference),
  )

  if (sampleSize <= stableSize) {
    return interpolate(
      sampleSize,
      provisionalSize,
      stableSize,
      provisionalWeight,
      stableWeight,
    )
  }
  if (sampleSize <= matureSize) {
    return interpolate(
      sampleSize,
      stableSize,
      matureSize,
      stableWeight,
      matureWeight,
    )
  }
  if (sampleSize <= maxReferenceSize) {
    return interpolate(
      sampleSize,
      matureSize,
      maxReferenceSize,
      matureWeight,
      maxReferenceWeight,
    )
  }

  return maxReferenceWeight
}

const thresholdDetail = (
  globalPrior: number,
  playerVariation: number | undefined,
  playerWeight: number,
  playerOverride: number | undefined,
  sanityMinimum: number,
): MishitEffectiveThresholdDetail => {
  const prior = finiteNonNegative(globalPrior) ?? 0
  const variation = finiteNonNegative(playerVariation)
  const override = finitePositive(playerOverride)
  const sanity = finiteNonNegative(sanityMinimum) ?? 0
  const effectivePlayerWeight =
    typeof variation === 'number' ? clamp01(playerWeight) : 0
  const blendedBoundary =
    typeof variation === 'number' && effectivePlayerWeight > 0
      ? prior * (1 - effectivePlayerWeight) + variation * effectivePlayerWeight
      : undefined
  const resolutionSource = override
    ? 'player_override'
    : typeof blendedBoundary === 'number'
      ? 'maturity_blend'
      : 'global_prior'
  const unconstrained = override ?? blendedBoundary ?? prior
  const effective = Math.max(sanity, unconstrained)

  return {
    globalPrior: prior,
    playerVariation: variation,
    playerWeight: effectivePlayerWeight,
    blendedBoundary,
    playerOverride: override,
    sanityMinimum: sanity,
    sanityConstrained: effective > unconstrained,
    resolutionSource,
    effective,
  }
}

export const resolveMishitEffectiveThresholds = (
  baseline: MishitBaseline,
  config: MishitConfig,
  calibration?: MishitPlayerCalibration,
): MishitEffectiveThresholds => {
  const playerWeight = resolveMishitPlayerWeight(baseline, config)
  const carryCenter = baseline.carry.center
  const offlineCenter = baseline.offline.center ?? 0
  const ballSpeedCenter = baseline.ballSpeed.center

  const carryMishitPrior = Math.max(
    config.carry.mishitLossPriorYards,
    typeof carryCenter === 'number' ? carryCenter * config.carry.mishitLossPct : 0,
  )
  const carrySeverePrior = Math.max(
    config.carry.severeLossPriorYards,
    typeof carryCenter === 'number' ? carryCenter * config.carry.severeLossPct : 0,
  )

  const directionMishitAbsolutePrior = Math.max(
    config.direction.mishitAbsolutePriorYards,
    typeof carryCenter === 'number'
      ? carryCenter * config.direction.mishitPctOfCarryCenter
      : 0,
  )
  const directionSevereAbsolutePrior = Math.max(
    config.direction.severeAbsolutePriorYards,
    typeof carryCenter === 'number'
      ? carryCenter * config.direction.severePctOfCarryCenter
      : 0,
  )

  const carryMishitVariation =
    typeof baseline.carry.mad === 'number'
      ? baseline.carry.mad * config.personalization.carryMadMultiplier.mishit
      : undefined
  const carrySevereVariation =
    typeof baseline.carry.mad === 'number'
      ? baseline.carry.mad * config.personalization.carryMadMultiplier.severe
      : undefined
  const directionMishitVariation =
    typeof baseline.offline.mad === 'number'
      ? baseline.offline.mad * config.personalization.directionMadMultiplier.mishit
      : undefined
  const directionSevereVariation =
    typeof baseline.offline.mad === 'number'
      ? baseline.offline.mad * config.personalization.directionMadMultiplier.severe
      : undefined
  const ballSpeedMishitVariation =
    typeof baseline.ballSpeed.mad === 'number'
      ? baseline.ballSpeed.mad * config.personalization.ballSpeedMadMultiplier.mishit
      : undefined
  const ballSpeedSevereVariation =
    typeof baseline.ballSpeed.mad === 'number'
      ? baseline.ballSpeed.mad * config.personalization.ballSpeedMadMultiplier.severe
      : undefined
  const smashMishitVariation =
    typeof baseline.smashFactor.mad === 'number'
      ? baseline.smashFactor.mad * config.personalization.smashFactorMadMultiplier.mishit
      : undefined
  const smashSevereVariation =
    typeof baseline.smashFactor.mad === 'number'
      ? baseline.smashFactor.mad * config.personalization.smashFactorMadMultiplier.severe
      : undefined

  const overrides = calibration?.overrides
  const sanity = config.personalization.sanityMinimums

  const result: MishitEffectiveThresholds = {
    personalizationApplied: false,
    playerWeight,
    calibrationVersion: calibration?.version,
    carry: {
      mishitLossYards: thresholdDetail(
        carryMishitPrior,
        carryMishitVariation,
        playerWeight,
        overrides?.carry?.mishitLossYards,
        sanity.carry.mishitLossYards,
      ),
      severeLossYards: thresholdDetail(
        carrySeverePrior,
        carrySevereVariation,
        playerWeight,
        overrides?.carry?.severeLossYards,
        sanity.carry.severeLossYards,
      ),
    },
    direction: {
      mishitAbsoluteYards: thresholdDetail(
        directionMishitAbsolutePrior,
        typeof directionMishitVariation === 'number'
          ? Math.abs(offlineCenter) + directionMishitVariation
          : undefined,
        playerWeight,
        overrides?.direction?.mishitAbsoluteYards,
        sanity.direction.mishitAbsoluteYards,
      ),
      severeAbsoluteYards: thresholdDetail(
        directionSevereAbsolutePrior,
        typeof directionSevereVariation === 'number'
          ? Math.abs(offlineCenter) + directionSevereVariation
          : undefined,
        playerWeight,
        overrides?.direction?.severeAbsoluteYards,
        sanity.direction.severeAbsoluteYards,
      ),
      mishitDeviationYards: thresholdDetail(
        config.direction.mishitDeviationPriorYards,
        directionMishitVariation,
        playerWeight,
        overrides?.direction?.mishitDeviationYards,
        sanity.direction.mishitDeviationYards,
      ),
      severeDeviationYards: thresholdDetail(
        config.direction.severeDeviationPriorYards,
        directionSevereVariation,
        playerWeight,
        overrides?.direction?.severeDeviationYards,
        sanity.direction.severeDeviationYards,
      ),
    },
    ballSpeed: {
      mishitLossMph: thresholdDetail(
        typeof ballSpeedCenter === 'number'
          ? ballSpeedCenter * config.strike.ballSpeedMishitLossPct
          : 0,
        ballSpeedMishitVariation,
        playerWeight,
        overrides?.ballSpeed?.mishitLossMph,
        sanity.ballSpeed.mishitLossMph,
      ),
      severeLossMph: thresholdDetail(
        typeof ballSpeedCenter === 'number'
          ? ballSpeedCenter * config.strike.ballSpeedSevereLossPct
          : 0,
        ballSpeedSevereVariation,
        playerWeight,
        overrides?.ballSpeed?.severeLossMph,
        sanity.ballSpeed.severeLossMph,
      ),
    },
    smashFactor: {
      mishitLoss: thresholdDetail(
        config.strike.smashFactorMishitLoss,
        smashMishitVariation,
        playerWeight,
        overrides?.smashFactor?.mishitLoss,
        sanity.smashFactor.mishitLoss,
      ),
      severeLoss: thresholdDetail(
        config.strike.smashFactorSevereLoss,
        smashSevereVariation,
        playerWeight,
        overrides?.smashFactor?.severeLoss,
        sanity.smashFactor.severeLoss,
      ),
    },
  }

  result.personalizationApplied = [
    result.carry.mishitLossYards,
    result.carry.severeLossYards,
    result.direction.mishitAbsoluteYards,
    result.direction.severeAbsoluteYards,
    result.direction.mishitDeviationYards,
    result.direction.severeDeviationYards,
    result.ballSpeed.mishitLossMph,
    result.ballSpeed.severeLossMph,
    result.smashFactor.mishitLoss,
    result.smashFactor.severeLoss,
  ].some(
    (detail) =>
      detail.resolutionSource === 'maturity_blend' ||
      detail.resolutionSource === 'player_override',
  )

  return result
}
