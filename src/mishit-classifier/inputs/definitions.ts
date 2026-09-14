import type { MishitInputDefinition } from './types'

const numberInput = (
  path: string,
  label: string,
  group: string,
  description: string,
  options: Pick<MishitInputDefinition, 'min' | 'max' | 'step'> = {},
  scope: MishitInputDefinition['scope'] = 'global_policy',
): MishitInputDefinition => ({
  path,
  label,
  group,
  scope,
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

const sanityInput = (
  path: string,
  label: string,
  description: string,
  options: Pick<MishitInputDefinition, 'min' | 'max' | 'step'> = {},
) => numberInput(
  path,
  label,
  'Statistical sanity constraints',
  description,
  options,
  'sanity_constraint',
)

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
    'Sample size where the player population receives the configured stable personalization weight.',
    { min: 1, step: 1 },
  ),
  numberInput(
    'sample.maturePopulationSize',
    'Mature population size',
    'Sample maturity',
    'Population size where player-specific evidence receives mature weight and refresh cadence can slow down.',
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
    'Carry mishit prior %',
    'Carry starter priors',
    'Shared cold-start carry-loss percentage used to form the global prior.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'carry.mishitLossPriorYards',
    'Carry mishit prior yards',
    'Carry starter priors',
    'Shared cold-start absolute carry-loss component. It fades as player evidence matures; it is not a permanent floor.',
    { min: 0, step: 1 },
  ),
  numberInput(
    'carry.severeLossPct',
    'Carry severe prior %',
    'Carry starter priors',
    'Shared cold-start severe carry-loss percentage used to form the global prior.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'carry.severeLossPriorYards',
    'Carry severe prior yards',
    'Carry starter priors',
    'Shared cold-start severe absolute carry-loss component. It is not a permanent player floor.',
    { min: 0, step: 1 },
  ),

  numberInput(
    'direction.mishitAbsolutePriorYards',
    'Directional mishit prior',
    'Direction starter priors',
    'Shared cold-start absolute offline component. It fades as the golfer earns a stable personal distribution.',
    { min: 0, step: 1 },
  ),
  numberInput(
    'direction.mishitPctOfCarryCenter',
    'Directional mishit prior % of carry',
    'Direction starter priors',
    'Carry-scaled component of the cold-start directional prior.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'direction.severeAbsolutePriorYards',
    'Directional severe prior',
    'Direction starter priors',
    'Shared cold-start severe absolute offline component.',
    { min: 0, step: 1 },
  ),
  numberInput(
    'direction.severePctOfCarryCenter',
    'Directional severe prior % of carry',
    'Direction starter priors',
    'Carry-scaled component of the cold-start severe directional prior.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'direction.mishitDeviationPriorYards',
    'Directional mishit deviation prior',
    'Direction starter priors',
    'Shared cold-start deviation-from-center prior. It is blended away as player evidence matures.',
    { min: 0, step: 1 },
  ),
  numberInput(
    'direction.severeDeviationPriorYards',
    'Directional severe deviation prior',
    'Direction starter priors',
    'Shared cold-start severe deviation-from-center prior.',
    { min: 0, step: 1 },
  ),

  numberInput(
    'strike.ballSpeedMishitLossPct',
    'Ball-speed mishit prior %',
    'Strike starter priors',
    'Shared cold-start ball-speed loss percentage.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'strike.ballSpeedSevereLossPct',
    'Ball-speed severe prior %',
    'Strike starter priors',
    'Shared cold-start severe ball-speed loss percentage.',
    { min: 0, max: 1, step: 0.01 },
  ),
  numberInput(
    'strike.smashFactorMishitLoss',
    'Smash mishit prior',
    'Strike starter priors',
    'Shared cold-start absolute smash-factor loss prior.',
    { min: 0, step: 0.01 },
  ),
  numberInput(
    'strike.smashFactorSevereLoss',
    'Smash severe prior',
    'Strike starter priors',
    'Shared cold-start severe absolute smash-factor loss prior.',
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
    'Use player personalization',
    'Personalization maturity',
    'Allows the shared cold-start prior to transition toward the player population boundary.',
  ),
  numberInput(
    'personalization.maturityWeight.playerWeightAtProvisional',
    'Player weight at provisional',
    'Personalization maturity',
    'Weight given to player variability when the population first reaches provisional sample size.',
    { min: 0, max: 1, step: 0.05 },
  ),
  numberInput(
    'personalization.maturityWeight.playerWeightAtStable',
    'Player weight at stable',
    'Personalization maturity',
    'Weight given to player variability at stable sample size.',
    { min: 0, max: 1, step: 0.05 },
  ),
  numberInput(
    'personalization.maturityWeight.playerWeightAtMature',
    'Player weight at mature',
    'Personalization maturity',
    'Weight given to player variability at mature population size.',
    { min: 0, max: 1, step: 0.05 },
  ),
  numberInput(
    'personalization.maturityWeight.playerWeightAtMaxReference',
    'Player weight at full reference window',
    'Personalization maturity',
    'Maximum automatic player-population weight once the reference window is full.',
    { min: 0, max: 1, step: 0.05 },
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
      'Personalization variability',
      'Player MAD units used to derive the personal mishit boundary before maturity blending.',
      { min: 0, step: 0.1 },
    ),
    numberInput(
      `personalization.${key}.severe`,
      `${label} severe MAD multiplier`,
      'Personalization variability',
      'Player MAD units used to derive the personal severe boundary before maturity blending.',
      { min: 0, step: 0.1 },
    ),
  ]),

  sanityInput(
    'personalization.sanityMinimums.carry.mishitLossYards',
    'Carry mishit sanity minimum',
    'Numerical lower guard only; not a cold-start prior or a golfer-performance target.',
    { min: 0, step: 1 },
  ),
  sanityInput(
    'personalization.sanityMinimums.carry.severeLossYards',
    'Carry severe sanity minimum',
    'Numerical lower guard only; not a permanent carry floor.',
    { min: 0, step: 1 },
  ),
  sanityInput(
    'personalization.sanityMinimums.direction.mishitAbsoluteYards',
    'Directional mishit sanity minimum',
    'Prevents zero/tiny dispersion samples from collapsing the absolute directional boundary to zero.',
    { min: 0, step: 1 },
  ),
  sanityInput(
    'personalization.sanityMinimums.direction.severeAbsoluteYards',
    'Directional severe sanity minimum',
    'Numerical lower guard for severe absolute direction only.',
    { min: 0, step: 1 },
  ),
  sanityInput(
    'personalization.sanityMinimums.direction.mishitDeviationYards',
    'Directional deviation sanity minimum',
    'Numerical lower guard for deviation from the player directional center.',
    { min: 0, step: 1 },
  ),
  sanityInput(
    'personalization.sanityMinimums.direction.severeDeviationYards',
    'Directional severe deviation sanity minimum',
    'Numerical lower guard for severe deviation from the player center.',
    { min: 0, step: 1 },
  ),
  sanityInput(
    'personalization.sanityMinimums.ballSpeed.mishitLossMph',
    'Ball-speed mishit sanity minimum',
    'Numerical lower guard only; not a player-performance prior.',
    { min: 0, step: 0.5 },
  ),
  sanityInput(
    'personalization.sanityMinimums.ballSpeed.severeLossMph',
    'Ball-speed severe sanity minimum',
    'Numerical lower guard for severe ball-speed loss.',
    { min: 0, step: 0.5 },
  ),
  sanityInput(
    'personalization.sanityMinimums.smashFactor.mishitLoss',
    'Smash mishit sanity minimum',
    'Numerical lower guard only; not a player-performance prior.',
    { min: 0, step: 0.005 },
  ),
  sanityInput(
    'personalization.sanityMinimums.smashFactor.severeLoss',
    'Smash severe sanity minimum',
    'Numerical lower guard for severe smash-factor loss.',
    { min: 0, step: 0.005 },
  ),
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
  description: 'Optional player/population-specific boundary stored outside shared classifier defaults. May tighten or widen the automatic maturity-blended boundary.',
  min: 0,
  step: 0.1,
}))
