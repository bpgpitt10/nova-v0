import type { MishitBaseline, MishitConfig } from '../types'
import type {
  MishitEffectiveThresholdDetail,
  MishitEffectiveThresholds,
  MishitPlayerCalibration,
} from './types'

const finitePositive = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined

const thresholdDetail = (
  globalBase: number,
  playerVariation: number | undefined,
  playerOverride: number | undefined,
): MishitEffectiveThresholdDetail => {
  const variation = finitePositive(playerVariation)
  const override = finitePositive(playerOverride)

  return {
    globalBase,
    playerVariation: variation,
    playerOverride: override,
    // V1 personalization is intentionally conservative: player-specific data
    // may widen the exclusion boundary but never make it more aggressive than
    // the shared starter floor.
    effective: Math.max(globalBase, variation ?? 0, override ?? 0),
  }
}

const variationEnabled = (baseline: MishitBaseline, config: MishitConfig) =>
  config.personalization.enabled &&
  (!config.personalization.stableBaselineOnly || baseline.status === 'stable')

export const resolveMishitEffectiveThresholds = (
  baseline: MishitBaseline,
  config: MishitConfig,
  calibration?: MishitPlayerCalibration,
): MishitEffectiveThresholds => {
  const useVariation = variationEnabled(baseline, config)
  const carryCenter = baseline.carry.center
  const offlineCenter = baseline.offline.center ?? 0
  const ballSpeedCenter = baseline.ballSpeed.center

  const carryMishitBase = Math.max(
    config.carry.mishitLossFloorYards,
    typeof carryCenter === 'number' ? carryCenter * config.carry.mishitLossPct : 0,
  )
  const carrySevereBase = Math.max(
    config.carry.severeLossFloorYards,
    typeof carryCenter === 'number' ? carryCenter * config.carry.severeLossPct : 0,
  )

  const directionMishitAbsoluteBase = Math.max(
    config.direction.mishitAbsoluteFloorYards,
    typeof carryCenter === 'number'
      ? carryCenter * config.direction.mishitPctOfCarryCenter
      : 0,
  )
  const directionSevereAbsoluteBase = Math.max(
    config.direction.severeAbsoluteFloorYards,
    typeof carryCenter === 'number'
      ? carryCenter * config.direction.severePctOfCarryCenter
      : 0,
  )

  const carryMishitVariation =
    useVariation && typeof baseline.carry.mad === 'number'
      ? baseline.carry.mad * config.personalization.carryMadMultiplier.mishit
      : undefined
  const carrySevereVariation =
    useVariation && typeof baseline.carry.mad === 'number'
      ? baseline.carry.mad * config.personalization.carryMadMultiplier.severe
      : undefined
  const directionMishitVariation =
    useVariation && typeof baseline.offline.mad === 'number'
      ? baseline.offline.mad * config.personalization.directionMadMultiplier.mishit
      : undefined
  const directionSevereVariation =
    useVariation && typeof baseline.offline.mad === 'number'
      ? baseline.offline.mad * config.personalization.directionMadMultiplier.severe
      : undefined
  const ballSpeedMishitVariation =
    useVariation && typeof baseline.ballSpeed.mad === 'number'
      ? baseline.ballSpeed.mad * config.personalization.ballSpeedMadMultiplier.mishit
      : undefined
  const ballSpeedSevereVariation =
    useVariation && typeof baseline.ballSpeed.mad === 'number'
      ? baseline.ballSpeed.mad * config.personalization.ballSpeedMadMultiplier.severe
      : undefined
  const smashMishitVariation =
    useVariation && typeof baseline.smashFactor.mad === 'number'
      ? baseline.smashFactor.mad * config.personalization.smashFactorMadMultiplier.mishit
      : undefined
  const smashSevereVariation =
    useVariation && typeof baseline.smashFactor.mad === 'number'
      ? baseline.smashFactor.mad * config.personalization.smashFactorMadMultiplier.severe
      : undefined

  const overrides = calibration?.overrides

  const result: MishitEffectiveThresholds = {
    personalizationApplied: false,
    calibrationVersion: calibration?.version,
    carry: {
      mishitLossYards: thresholdDetail(
        carryMishitBase,
        carryMishitVariation,
        overrides?.carry?.mishitLossYards,
      ),
      severeLossYards: thresholdDetail(
        carrySevereBase,
        carrySevereVariation,
        overrides?.carry?.severeLossYards,
      ),
    },
    direction: {
      mishitAbsoluteYards: thresholdDetail(
        directionMishitAbsoluteBase,
        typeof directionMishitVariation === 'number'
          ? Math.abs(offlineCenter) + directionMishitVariation
          : undefined,
        overrides?.direction?.mishitAbsoluteYards,
      ),
      severeAbsoluteYards: thresholdDetail(
        directionSevereAbsoluteBase,
        typeof directionSevereVariation === 'number'
          ? Math.abs(offlineCenter) + directionSevereVariation
          : undefined,
        overrides?.direction?.severeAbsoluteYards,
      ),
      mishitDeviationYards: thresholdDetail(
        config.direction.mishitDeviationFromCenterYards,
        directionMishitVariation,
        overrides?.direction?.mishitDeviationYards,
      ),
      severeDeviationYards: thresholdDetail(
        config.direction.severeDeviationFromCenterYards,
        directionSevereVariation,
        overrides?.direction?.severeDeviationYards,
      ),
    },
    ballSpeed: {
      mishitLossMph: thresholdDetail(
        typeof ballSpeedCenter === 'number'
          ? ballSpeedCenter * config.strike.ballSpeedMishitLossPct
          : 0,
        ballSpeedMishitVariation,
        overrides?.ballSpeed?.mishitLossMph,
      ),
      severeLossMph: thresholdDetail(
        typeof ballSpeedCenter === 'number'
          ? ballSpeedCenter * config.strike.ballSpeedSevereLossPct
          : 0,
        ballSpeedSevereVariation,
        overrides?.ballSpeed?.severeLossMph,
      ),
    },
    smashFactor: {
      mishitLoss: thresholdDetail(
        config.strike.smashFactorMishitLoss,
        smashMishitVariation,
        overrides?.smashFactor?.mishitLoss,
      ),
      severeLoss: thresholdDetail(
        config.strike.smashFactorSevereLoss,
        smashSevereVariation,
        overrides?.smashFactor?.severeLoss,
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
      typeof detail.playerVariation === 'number' ||
      typeof detail.playerOverride === 'number',
  )

  return result
}
