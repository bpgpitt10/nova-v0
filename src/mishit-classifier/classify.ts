import { resolveMishitEffectiveThresholds } from './inputs/resolve'
import type { MishitPlayerCalibration } from './inputs/types'
import { clamp01 } from './stats'
import type {
  MishitBaseline,
  MishitClassification,
  MishitConfig,
  MishitReason,
  MishitShot,
} from './types'

const carryReasons = (
  shot: MishitShot,
  baseline: MishitBaseline,
  config: MishitConfig,
  calibration?: MishitPlayerCalibration,
): MishitReason[] => {
  const reference = baseline.carry.center
  if (typeof shot.carry !== 'number' || typeof reference !== 'number' || reference <= 0) {
    return []
  }

  const loss = reference - shot.carry
  const lossPct = loss / reference
  if (loss <= 0) {
    return []
  }

  const thresholds = resolveMishitEffectiveThresholds(baseline, config, calibration)

  if (loss >= thresholds.carry.severeLossYards.effective) {
    return [{
      code: 'severe_carry_loss',
      metric: 'carry',
      observed: shot.carry,
      reference,
      deviation: -loss,
      deviationPct: -lossPct,
      threshold: thresholds.carry.severeLossYards.effective,
      severity: 'severe',
    }]
  }

  if (loss >= thresholds.carry.mishitLossYards.effective) {
    return [{
      code: 'major_carry_loss',
      metric: 'carry',
      observed: shot.carry,
      reference,
      deviation: -loss,
      deviationPct: -lossPct,
      threshold: thresholds.carry.mishitLossYards.effective,
      severity: 'mishit',
    }]
  }

  return []
}

const offlineReasons = (
  shot: MishitShot,
  baseline: MishitBaseline,
  config: MishitConfig,
  calibration?: MishitPlayerCalibration,
): MishitReason[] => {
  if (typeof shot.offline !== 'number') {
    return []
  }

  const offlineCenter = baseline.offline.center ?? 0
  const absoluteOffline = Math.abs(shot.offline)
  const deviationFromCenter = Math.abs(shot.offline - offlineCenter)
  const thresholds = resolveMishitEffectiveThresholds(baseline, config, calibration)

  const severeAbsolute = thresholds.direction.severeAbsoluteYards.effective
  const severeDeviation = thresholds.direction.severeDeviationYards.effective
  const mishitAbsolute = thresholds.direction.mishitAbsoluteYards.effective
  const mishitDeviation = thresholds.direction.mishitDeviationYards.effective

  const severeAbsoluteTriggered = absoluteOffline >= severeAbsolute
  const severeDeviationTriggered = deviationFromCenter >= severeDeviation
  if (severeAbsoluteTriggered || severeDeviationTriggered) {
    return [{
      code: 'severe_offline',
      metric: 'offline',
      observed: shot.offline,
      reference: offlineCenter,
      deviation: shot.offline - offlineCenter,
      threshold: severeDeviationTriggered ? severeDeviation : severeAbsolute,
      severity: 'severe',
    }]
  }

  const mishitAbsoluteTriggered = absoluteOffline >= mishitAbsolute
  const mishitDeviationTriggered = deviationFromCenter >= mishitDeviation
  if (mishitAbsoluteTriggered || mishitDeviationTriggered) {
    return [{
      code: 'extreme_offline',
      metric: 'offline',
      observed: shot.offline,
      reference: offlineCenter,
      deviation: shot.offline - offlineCenter,
      threshold: mishitDeviationTriggered ? mishitDeviation : mishitAbsolute,
      severity: 'mishit',
    }]
  }

  return []
}

const ballSpeedReasons = (
  shot: MishitShot,
  baseline: MishitBaseline,
  config: MishitConfig,
  calibration?: MishitPlayerCalibration,
): MishitReason[] => {
  const reference = baseline.ballSpeed.center
  if (typeof shot.ballSpeed !== 'number' || typeof reference !== 'number' || reference <= 0) {
    return []
  }

  const loss = reference - shot.ballSpeed
  if (loss <= 0) {
    return []
  }
  const lossPct = loss / reference
  const thresholds = resolveMishitEffectiveThresholds(baseline, config, calibration)

  if (loss >= thresholds.ballSpeed.severeLossMph.effective) {
    return [{
      code: 'severe_ball_speed_loss',
      metric: 'ballSpeed',
      observed: shot.ballSpeed,
      reference,
      deviation: -loss,
      deviationPct: -lossPct,
      threshold: thresholds.ballSpeed.severeLossMph.effective,
      severity: 'severe',
    }]
  }
  if (loss >= thresholds.ballSpeed.mishitLossMph.effective) {
    return [{
      code: 'ball_speed_loss',
      metric: 'ballSpeed',
      observed: shot.ballSpeed,
      reference,
      deviation: -loss,
      deviationPct: -lossPct,
      threshold: thresholds.ballSpeed.mishitLossMph.effective,
      severity: 'mishit',
    }]
  }
  return []
}

const smashReasons = (
  shot: MishitShot,
  baseline: MishitBaseline,
  config: MishitConfig,
  calibration?: MishitPlayerCalibration,
): MishitReason[] => {
  const reference = baseline.smashFactor.center
  if (typeof shot.smashFactor !== 'number' || typeof reference !== 'number') {
    return []
  }

  const loss = reference - shot.smashFactor
  if (loss <= 0) {
    return []
  }
  const thresholds = resolveMishitEffectiveThresholds(baseline, config, calibration)

  if (loss >= thresholds.smashFactor.severeLoss.effective) {
    return [{
      code: 'severe_smash_loss',
      metric: 'smashFactor',
      observed: shot.smashFactor,
      reference,
      deviation: -loss,
      threshold: thresholds.smashFactor.severeLoss.effective,
      severity: 'severe',
    }]
  }
  if (loss >= thresholds.smashFactor.mishitLoss.effective) {
    return [{
      code: 'smash_loss',
      metric: 'smashFactor',
      observed: shot.smashFactor,
      reference,
      deviation: -loss,
      threshold: thresholds.smashFactor.mishitLoss.effective,
      severity: 'mishit',
    }]
  }
  return []
}

export const classifyShot = (
  shot: MishitShot,
  baseline: MishitBaseline,
  config: MishitConfig,
  calibration?: MishitPlayerCalibration,
): MishitClassification => {
  if (baseline.status === 'insufficient') {
    return {
      shotId: shot.id,
      classification: 'unclassified',
      planningEligible: true,
      confidence: 0,
      baselineVersion: baseline.version,
      baselineStatus: baseline.status,
      reasons: [{
        code: 'insufficient_reference',
        metric: 'population',
        observed: baseline.sampleSize,
        threshold: config.sample.provisionalSampleSize,
        severity: 'info',
      }],
    }
  }

  const reasons = [
    ...carryReasons(shot, baseline, config, calibration),
    ...offlineReasons(shot, baseline, config, calibration),
    ...ballSpeedReasons(shot, baseline, config, calibration),
    ...smashReasons(shot, baseline, config, calibration),
  ]

  const severeCount = reasons.filter((reason) => reason.severity === 'severe').length
  const mishitSignalCount = reasons.filter(
    (reason) => reason.severity === 'mishit' || reason.severity === 'severe',
  ).length

  const compoundSevere = mishitSignalCount >= config.compound.severeSignalCount
  const compoundMishit = mishitSignalCount >= config.compound.mishitSignalCount

  if ((compoundSevere || compoundMishit) && reasons.length > 0) {
    reasons.push({
      code: 'compound_failure',
      metric: 'population',
      observed: mishitSignalCount,
      threshold: compoundSevere
        ? config.compound.severeSignalCount
        : config.compound.mishitSignalCount,
      severity: compoundSevere ? 'severe' : 'mishit',
    })
  }

  const classification =
    severeCount > 0 || compoundSevere
      ? 'severe_mishit'
      : compoundMishit
        ? 'mishit'
        : reasons.some((reason) => reason.severity === 'mishit')
          ? 'mishit'
          : 'normal'

  const baselineConfidence = baseline.status === 'stable' ? 0.9 : 0.65
  const signalBoost = Math.min(0.1, mishitSignalCount * 0.03)

  return {
    shotId: shot.id,
    classification,
    planningEligible: classification === 'normal',
    confidence: clamp01(baselineConfidence + signalBoost),
    baselineVersion: baseline.version,
    baselineStatus: baseline.status,
    reasons,
  }
}

export const classifyShots = (
  shots: MishitShot[],
  baseline: MishitBaseline,
  config: MishitConfig,
  calibration?: MishitPlayerCalibration,
) => shots.map((shot) => classifyShot(shot, baseline, config, calibration))
