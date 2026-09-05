import type {
  MishitBaseline,
  MishitClassification,
  MishitConfig,
  MishitReason,
  MishitShot,
} from './types'
import { clamp01 } from './stats'

const carryReasons = (
  shot: MishitShot,
  baseline: MishitBaseline,
  config: MishitConfig,
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

  if (
    lossPct >= config.carry.severeLossPct &&
    loss >= config.carry.severeLossFloorYards
  ) {
    return [{
      code: 'severe_carry_loss',
      metric: 'carry',
      observed: shot.carry,
      reference,
      deviation: -loss,
      deviationPct: -lossPct,
      threshold: Math.max(
        config.carry.severeLossFloorYards,
        reference * config.carry.severeLossPct,
      ),
      severity: 'severe',
    }]
  }

  if (
    lossPct >= config.carry.mishitLossPct &&
    loss >= config.carry.mishitLossFloorYards
  ) {
    return [{
      code: 'major_carry_loss',
      metric: 'carry',
      observed: shot.carry,
      reference,
      deviation: -loss,
      deviationPct: -lossPct,
      threshold: Math.max(
        config.carry.mishitLossFloorYards,
        reference * config.carry.mishitLossPct,
      ),
      severity: 'mishit',
    }]
  }

  return []
}

const offlineReasons = (
  shot: MishitShot,
  baseline: MishitBaseline,
  config: MishitConfig,
): MishitReason[] => {
  if (typeof shot.offline !== 'number') {
    return []
  }

  const carryCenter = baseline.carry.center
  const offlineCenter = baseline.offline.center ?? 0
  const absoluteOffline = Math.abs(shot.offline)
  const deviationFromCenter = Math.abs(shot.offline - offlineCenter)

  const severeAbsoluteThreshold = Math.max(
    config.direction.severeAbsoluteFloorYards,
    typeof carryCenter === 'number'
      ? carryCenter * config.direction.severePctOfCarryCenter
      : 0,
  )
  const mishitAbsoluteThreshold = Math.max(
    config.direction.mishitAbsoluteFloorYards,
    typeof carryCenter === 'number'
      ? carryCenter * config.direction.mishitPctOfCarryCenter
      : 0,
  )

  if (
    absoluteOffline >= severeAbsoluteThreshold ||
    deviationFromCenter >= config.direction.severeDeviationFromCenterYards
  ) {
    return [{
      code: 'severe_offline',
      metric: 'offline',
      observed: shot.offline,
      reference: offlineCenter,
      deviation: shot.offline - offlineCenter,
      threshold: Math.min(
        severeAbsoluteThreshold,
        config.direction.severeDeviationFromCenterYards,
      ),
      severity: 'severe',
    }]
  }

  if (
    absoluteOffline >= mishitAbsoluteThreshold ||
    deviationFromCenter >= config.direction.mishitDeviationFromCenterYards
  ) {
    return [{
      code: 'extreme_offline',
      metric: 'offline',
      observed: shot.offline,
      reference: offlineCenter,
      deviation: shot.offline - offlineCenter,
      threshold: Math.min(
        mishitAbsoluteThreshold,
        config.direction.mishitDeviationFromCenterYards,
      ),
      severity: 'mishit',
    }]
  }

  return []
}

const ballSpeedReasons = (
  shot: MishitShot,
  baseline: MishitBaseline,
  config: MishitConfig,
): MishitReason[] => {
  const reference = baseline.ballSpeed.center
  if (typeof shot.ballSpeed !== 'number' || typeof reference !== 'number' || reference <= 0) {
    return []
  }

  const lossPct = (reference - shot.ballSpeed) / reference
  if (lossPct >= config.strike.ballSpeedSevereLossPct) {
    return [{
      code: 'severe_ball_speed_loss',
      metric: 'ballSpeed',
      observed: shot.ballSpeed,
      reference,
      deviation: shot.ballSpeed - reference,
      deviationPct: -lossPct,
      threshold: reference * config.strike.ballSpeedSevereLossPct,
      severity: 'severe',
    }]
  }
  if (lossPct >= config.strike.ballSpeedMishitLossPct) {
    return [{
      code: 'ball_speed_loss',
      metric: 'ballSpeed',
      observed: shot.ballSpeed,
      reference,
      deviation: shot.ballSpeed - reference,
      deviationPct: -lossPct,
      threshold: reference * config.strike.ballSpeedMishitLossPct,
      severity: 'mishit',
    }]
  }
  return []
}

const smashReasons = (
  shot: MishitShot,
  baseline: MishitBaseline,
  config: MishitConfig,
): MishitReason[] => {
  const reference = baseline.smashFactor.center
  if (typeof shot.smashFactor !== 'number' || typeof reference !== 'number') {
    return []
  }

  const loss = reference - shot.smashFactor
  if (loss >= config.strike.smashFactorSevereLoss) {
    return [{
      code: 'severe_smash_loss',
      metric: 'smashFactor',
      observed: shot.smashFactor,
      reference,
      deviation: -loss,
      threshold: config.strike.smashFactorSevereLoss,
      severity: 'severe',
    }]
  }
  if (loss >= config.strike.smashFactorMishitLoss) {
    return [{
      code: 'smash_loss',
      metric: 'smashFactor',
      observed: shot.smashFactor,
      reference,
      deviation: -loss,
      threshold: config.strike.smashFactorMishitLoss,
      severity: 'mishit',
    }]
  }
  return []
}

export const classifyShot = (
  shot: MishitShot,
  baseline: MishitBaseline,
  config: MishitConfig,
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
    ...carryReasons(shot, baseline, config),
    ...offlineReasons(shot, baseline, config),
    ...ballSpeedReasons(shot, baseline, config),
    ...smashReasons(shot, baseline, config),
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
) => shots.map((shot) => classifyShot(shot, baseline, config))
