import type { MishitInputDefinition } from './types'

const numberInput = (
  path: string,
  label: string,
  group: string,
  description: string,
  options: Pick<MishitInputDefinition, 'min' | 'max' | 'step'> = {},
): MishitInputDefinition => ({
  path,
  label,
  group,
  scope: 'global_policy',
  kind: 'number',
  description,
  ...options,
})

const booleanInput = (
  path: string,
  label: string,
  group: string,
  description: string,
): MishitInputDefinition => ({
  path,
  label,
  group,
  scope: 'global_policy',
  kind: 'boolean',
  description,
})

/**
 * UI-ready metadata for every editable value in DEFAULT_MISHIT_INPUTS.
 *
 * The classifier engine never imports this file. A future Inputs page can use
 * it as a registry instead of discovering assumptions in algorithm code.
 */
export const MISHIT_INPUT_DEFINITIONS: MishitInputDefinition[] = [
  numberInput(
    'sample.provisionalSampleSize',
    'Provisional sample size',
    'Sample maturity',
    'Minimum shots before the classifier can make a provisional call.',
    { min: 1, step: 1 },
  ),
  numberInput(
    'sample.stableSampleSize',
    'Stable sample size',
    'Sample maturity',
    'Minimum shots before player-specific variability is considered stable.',
    { min: 1, step: 1 },
  ),
  numberInput(
    'sample.maturePopulationSize',
    'Mature population size',
    'Sample maturity',
    'Population size where refresh cadence can slow down.',
    { min: 1, step: 1 },
  ),
  numberInput(
    'sample.maxReferenceShots',
    'Reference window',
    'Sample maturity',
    'Maximum recent shots used to define the current player baseline.',
    { min: 1, step: 1 },
  ),

  numberInput(
    'refresh.earlyEveryNewShots',
    'Early refresh cadence',
    'Refresh policy',
    'New shots between baseline rebuilds while the population is early.',
    { min: 1, step: 1 },
  ),
  numberInput(
    'refresh.matureEveryNewShots',
    'Mature refresh cadence',
    'Refresh policy',
    'New shots between baseline rebuilds once the population is mature.',
    { min: 1, step: 1 },
  ),
  numberInput(
    'refresh.fullReclassUntilSampleSize',
    'Full reclass sample cutoff',
    'Refresh policy',
    'Population size below which a baseline rebuild reclassifies the full population.',
    { min: 1, step: 1 },
  ),
  numberInput(
    'refresh.baselineChange.carryCenterPct',
    'Material carry-center change',
    'Refresh policy',
    'Relative carry-center movement that counts as a material baseline change.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'refresh.baselineChange.offlineCenterYards',
    'Material offline-center change',
    'Refresh policy',
    'Offline-center movement in yards that counts as material.',
    { min: 0, step: 1 },
  ),
  numberInput(
    'refresh.baselineChange.ballSpeedCenterPct',
    'Material ball-speed change',
    'Refresh policy',
    'Relative ball-speed-center movement that counts as material.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'refresh.baselineChange.smashFactorAbsolute',
    'Material smash change',
    'Refresh policy',
    'Absolute smash-factor-center movement that counts as material.',
    { min: 0, step: 0.01 },
  ),

  booleanInput(
    'baselineRefinement.enabled',
    'Refine baseline',
    'Baseline refinement',
    'Allows severe first-pass outliers to be removed before rebuilding the robust baseline.',
  ),
  numberInput(
    'baselineRefinement.maxPasses',
    'Refinement passes',
    'Baseline refinement',
    'Maximum robust baseline refinement passes.',
    { min: 1, step: 1 },
  ),

  numberInput(
    'carry.mishitLossPct',
    'Carry mishit loss %',
    'Carry',
    'Shared starter percentage loss floor before player variability is applied.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'carry.mishitLossFloorYards',
    'Carry mishit floor',
    'Carry',
    'Shared starter absolute carry-loss floor in yards.',
    { min: 0, step: 1 },
  ),
  numberInput(
    'carry.severeLossPct',
    'Carry severe loss %',
    'Carry',
    'Shared starter severe carry-loss percentage.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'carry.severeLossFloorYards',
    'Carry severe floor',
    'Carry',
    'Shared starter severe absolute carry-loss floor in yards.',
    { min: 0, step: 1 },
  ),

  numberInput(
    'direction.mishitAbsoluteFloorYards',
    'Directional mishit floor',
    'Direction',
    'Shared starter absolute offline floor before player variability is applied.',
    { min: 0, step: 1 },
  ),
  numberInput(
    'direction.mishitPctOfCarryCenter',
    'Directional mishit % of carry',
    'Direction',
    'Carry-scaled starter directional mishit floor.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'direction.severeAbsoluteFloorYards',
    'Directional severe floor',
    'Direction',
    'Shared starter severe absolute offline floor.',
    { min: 0, step: 1 },
  ),
  numberInput(
    'direction.severePctOfCarryCenter',
    'Directional severe % of carry',
    'Direction',
    'Carry-scaled starter severe directional floor.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'direction.mishitDeviationFromCenterYards',
    'Directional mishit deviation',
    'Direction',
    'Shared starter deviation from the player directional center.',
    { min: 0, step: 1 },
  ),
  numberInput(
    'direction.severeDeviationFromCenterYards',
    'Directional severe deviation',
    'Direction',
    'Shared starter severe deviation from the player directional center.',
    { min: 0, step: 1 },
  ),

  numberInput(
    'strike.ballSpeedMishitLossPct',
    'Ball-speed mishit loss %',
    'Strike',
    'Shared starter ball-speed loss percentage.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'strike.ballSpeedSevereLossPct',
    'Ball-speed severe loss %',
    'Strike',
    'Shared starter severe ball-speed loss percentage.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'strike.smashFactorMishitLoss',
    'Smash mishit loss',
    'Strike',
    'Shared starter absolute smash-factor loss.',
    { min: 0, step: 0.01 },
  ),
  numberInput(
    'strike.smashFactorSevereLoss',
    'Smash severe loss',
    'Strike',
    'Shared starter severe absolute smash-factor loss.',
    { min: 0, step: 0.01 },
  ),

  numberInput(
    'compound.mishitSignalCount',
    'Compound mishit signals',
    'Compound evidence',
    'Mishit-level signals required for a compound mishit.',
    { min: 1, step: 1 },
  ),
  numberInput(
    'compound.severeSignalCount',
    'Compound severe signals',
    'Compound evidence',
    'Mishit-level signals required for a compound severe mishit.',
    { min: 1, step: 1 },
  ),

  booleanInput(
    'personalization.enabled',
    'Use player variability',
    'Personalization',
    'Allows each player population to widen boundaries using its own robust variability.',
  ),
  booleanInput(
    'personalization.stableBaselineOnly',
    'Require stable baseline',
    'Personalization',
    'Prevents variability-based personalization until the player baseline is stable.',
  ),
  ...[
    ['carryMadMultiplier', 'Carry'],
    ['directionMadMultiplier', 'Direction'],
    ['ballSpeedMadMultiplier', 'Ball speed'],
    ['smashFactorMadMultiplier', 'Smash factor'],
  ].flatMap(([key, label]) => [
    numberInput(
      `personalization.${key}.mishit`,
      `${label} mishit MAD multiplier`,
      'Personalization',
      'Player MAD units required before the mishit boundary widens beyond the shared starter floor.',
      { min: 0, step: 0.1 },
    ),
    numberInput(
      `personalization.${key}.severe`,
      `${label} severe MAD multiplier`,
      'Personalization',
      'Player MAD units required before the severe boundary widens beyond the shared starter floor.',
      { min: 0, step: 0.1 },
    ),
  ]),
]

export const MISHIT_PLAYER_OVERRIDE_DEFINITIONS: MishitInputDefinition[] = [
  ['carry.mishitLossYards', 'Carry mishit boundary', 'Carry'],
  ['carry.severeLossYards', 'Carry severe boundary', 'Carry'],
  ['direction.mishitAbsoluteYards', 'Directional mishit absolute boundary', 'Direction'],
  ['direction.severeAbsoluteYards', 'Directional severe absolute boundary', 'Direction'],
  ['direction.mishitDeviationYards', 'Directional mishit deviation boundary', 'Direction'],
  ['direction.severeDeviationYards', 'Directional severe deviation boundary', 'Direction'],
  ['ballSpeed.mishitLossMph', 'Ball-speed mishit boundary', 'Strike'],
  ['ballSpeed.severeLossMph', 'Ball-speed severe boundary', 'Strike'],
  ['smashFactor.mishitLoss', 'Smash mishit boundary', 'Strike'],
  ['smashFactor.severeLoss', 'Smash severe boundary', 'Strike'],
].map(([path, label, group]) => ({
  path,
  label,
  group,
  scope: 'player_override',
  kind: 'number',
  description: 'Optional player/population-specific floor. Stored outside shared classifier defaults.',
  min: 0,
  step: 0.1,
}))
