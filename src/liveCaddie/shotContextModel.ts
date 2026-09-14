import {
  buildCaddieModelContract,
  type CaddieModelContract,
  type PlayerBaselineInput,
  type ShotContextInput,
} from './modelContract'

export type ModeledShotContext = {
  baseline: PlayerBaselineInput
  rawContext: ShotContextInput
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

/**
 * Canonical transformation boundary for Live Caddie context.
 *
 * V0 intentionally applies zero adjustment for uncalibrated factors. This is not
 * a placeholder hidden inside the optimizer: the companion contract explicitly
 * exposes which factors are measured but not yet allowed to affect a recommendation.
 */
export const modelShotContext = (
  baseline: PlayerBaselineInput,
  context: ShotContextInput,
): ModeledShotContext => {
  const stockCarry =
    typeof baseline.stockCarryYds === 'number' && Number.isFinite(baseline.stockCarryYds)
      ? baseline.stockCarryYds
      : null
  const carrySigma =
    typeof baseline.carrySigmaYds === 'number' && Number.isFinite(baseline.carrySigmaYds)
      ? baseline.carrySigmaYds
      : null
  const lateralBias =
    typeof baseline.lateralBiasYds === 'number' && Number.isFinite(baseline.lateralBiasYds)
      ? baseline.lateralBiasYds
      : null
  const lateralSigma =
    typeof baseline.lateralSigmaYds === 'number' && Number.isFinite(baseline.lateralSigmaYds)
      ? baseline.lateralSigmaYds
      : null
  const targetDistance =
    typeof context.targetDistanceYds === 'number' && Number.isFinite(context.targetDistanceYds)
      ? context.targetDistanceYds
      : null

  const appliedAdjustments = {
    elevationYds: 0,
    windCarryYds: 0,
    windLateralYds: 0,
    surfaceCarryYds: 0,
    lieCarryYds: 0,
    lieLateralYds: 0,
  }

  return {
    baseline,
    rawContext: context,
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
    contract: buildCaddieModelContract(baseline, context),
  }
}
