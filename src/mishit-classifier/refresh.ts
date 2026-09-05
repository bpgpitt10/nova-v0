import { buildMishitBaseline, selectReferenceShots } from './baseline'
import { classifyShot, classifyShots } from './classify'
import { DEFAULT_MISHIT_CONFIG } from './config'
import { relativeChange, uniqueStrings } from './stats'
import type {
  MishitAnalysis,
  MishitBaseline,
  MishitClassification,
  MishitConfig,
  MishitShot,
  RefreshMishitAnalysisArgs,
} from './types'

const classificationMap = (classifications: MishitClassification[]) =>
  new Map(classifications.map((classification) => [classification.shotId, classification]))

const baselineChangedMaterially = (
  before: MishitBaseline,
  after: MishitBaseline,
  config: MishitConfig,
) => {
  const carryChange = relativeChange(before.carry.center, after.carry.center)
  if (
    typeof carryChange === 'number' &&
    carryChange >= config.refresh.baselineChange.carryCenterPct
  ) {
    return true
  }

  if (
    typeof before.offline.center === 'number' &&
    typeof after.offline.center === 'number' &&
    Math.abs(after.offline.center - before.offline.center) >=
      config.refresh.baselineChange.offlineCenterYards
  ) {
    return true
  }

  const ballSpeedChange = relativeChange(before.ballSpeed.center, after.ballSpeed.center)
  if (
    typeof ballSpeedChange === 'number' &&
    ballSpeedChange >= config.refresh.baselineChange.ballSpeedCenterPct
  ) {
    return true
  }

  if (
    typeof before.smashFactor.center === 'number' &&
    typeof after.smashFactor.center === 'number' &&
    Math.abs(after.smashFactor.center - before.smashFactor.center) >=
      config.refresh.baselineChange.smashFactorAbsolute
  ) {
    return true
  }

  return false
}

const buildRefinedBaseline = (
  shots: MishitShot[],
  config: MishitConfig,
  version: number,
) => {
  let baseline = buildMishitBaseline(shots, config, version)
  if (!config.baselineRefinement.enabled || baseline.status === 'insufficient') {
    return baseline
  }

  let referenceShots = selectReferenceShots(shots, config.sample.maxReferenceShots)
  const passes = Math.max(1, config.baselineRefinement.maxPasses)

  for (let pass = 1; pass < passes; pass += 1) {
    const classifications = classifyShots(referenceShots, baseline, config)
    const severeIds = new Set(
      classifications
        .filter((classification) => classification.classification === 'severe_mishit')
        .map((classification) => classification.shotId),
    )

    if (severeIds.size === 0) {
      break
    }

    const refinedShots = referenceShots.filter((shot) => !severeIds.has(shot.id))
    if (refinedShots.length < config.sample.provisionalSampleSize) {
      break
    }

    referenceShots = refinedShots
    baseline = buildMishitBaseline(referenceShots, config, version)
  }

  return baseline
}

const stageTransitionRequiresRefresh = (
  previous: MishitBaseline,
  shotCount: number,
  config: MishitConfig,
) => {
  if (
    previous.status === 'insufficient' &&
    shotCount >= config.sample.provisionalSampleSize
  ) {
    return true
  }
  if (
    previous.status === 'provisional' &&
    shotCount >= config.sample.stableSampleSize
  ) {
    return true
  }
  return false
}

const refreshCadence = (
  previous: MishitAnalysis,
  config: MishitConfig,
) =>
  previous.baseline.status === 'stable' &&
  previous.baseline.sampleSize >= config.sample.maturePopulationSize
    ? config.refresh.matureEveryNewShots
    : config.refresh.earlyEveryNewShots

const classifyNewOnly = (
  shots: MishitShot[],
  previous: MishitAnalysis,
  baseline: MishitBaseline,
  config: MishitConfig,
) => {
  const currentIds = new Set(shots.map((shot) => shot.id))
  const prior = classificationMap(previous.classifications)
  const next: MishitClassification[] = []

  shots.forEach((shot) => {
    const existing = prior.get(shot.id)
    next.push(existing ?? classifyShot(shot, baseline, config))
  })

  return next.filter((classification) => currentIds.has(classification.shotId))
}

export const analyzeShotPopulation = (
  shots: MishitShot[],
  config: MishitConfig = DEFAULT_MISHIT_CONFIG,
): MishitAnalysis => {
  const baseline = buildRefinedBaseline(shots, config, 1)
  return {
    baseline,
    classifications: classifyShots(shots, baseline, config),
    refresh: {
      action: 'initial_full_analysis',
      newShotCount: shots.length,
      removedShotCount: 0,
      pendingNewShotIds: [],
      baselineChangedMaterially: false,
    },
  }
}

export const refreshMishitAnalysis = ({
  shots,
  previous,
  config = DEFAULT_MISHIT_CONFIG,
  forceFullReclass = false,
}: RefreshMishitAnalysisArgs): MishitAnalysis => {
  if (!previous) {
    return analyzeShotPopulation(shots, config)
  }

  const currentIds = new Set(shots.map((shot) => shot.id))
  const previousIds = new Set(previous.classifications.map((classification) => classification.shotId))
  const newShotIds = shots.filter((shot) => !previousIds.has(shot.id)).map((shot) => shot.id)
  const removedShotCount = previous.classifications.filter(
    (classification) => !currentIds.has(classification.shotId),
  ).length
  const pendingNewShotIds = uniqueStrings([
    ...previous.refresh.pendingNewShotIds,
    ...newShotIds,
  ]).filter((id) => currentIds.has(id))

  if (
    !forceFullReclass &&
    newShotIds.length === 0 &&
    removedShotCount === 0
  ) {
    return {
      ...previous,
      refresh: {
        action: 'no_change',
        newShotCount: 0,
        removedShotCount: 0,
        pendingNewShotIds,
        baselineChangedMaterially: false,
      },
    }
  }

  const cadence = refreshCadence(previous, config)
  const shouldRebuildBaseline =
    forceFullReclass ||
    removedShotCount > 0 ||
    pendingNewShotIds.length >= cadence ||
    stageTransitionRequiresRefresh(previous.baseline, shots.length, config)

  if (!shouldRebuildBaseline) {
    return {
      baseline: previous.baseline,
      classifications: classifyNewOnly(shots, previous, previous.baseline, config),
      refresh: {
        action: 'new_shots_only',
        newShotCount: newShotIds.length,
        removedShotCount,
        pendingNewShotIds,
        baselineChangedMaterially: false,
      },
    }
  }

  const nextBaseline = buildRefinedBaseline(
    shots,
    config,
    previous.baseline.version + 1,
  )
  const materiallyChanged = baselineChangedMaterially(previous.baseline, nextBaseline, config)
  const earlyPopulation =
    nextBaseline.sampleSize < config.refresh.fullReclassUntilSampleSize
  const statusChanged = nextBaseline.status !== previous.baseline.status
  const shouldFullReclass =
    forceFullReclass ||
    removedShotCount > 0 ||
    earlyPopulation ||
    statusChanged ||
    materiallyChanged

  return {
    baseline: nextBaseline,
    classifications: shouldFullReclass
      ? classifyShots(shots, nextBaseline, config)
      : classifyNewOnly(shots, previous, nextBaseline, config),
    refresh: {
      action: shouldFullReclass
        ? 'baseline_rebuilt_full_reclass'
        : 'baseline_rebuilt_new_only',
      newShotCount: newShotIds.length,
      removedShotCount,
      pendingNewShotIds: [],
      baselineChangedMaterially: materiallyChanged,
    },
  }
}
