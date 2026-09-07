export type MishitPlayerCalibrationSource =
  | 'manual'
  | 'human_review'
  | 'imported'

export type MishitPlayerCalibrationStatus = 'provisional' | 'stable'

export type MishitPlayerCalibrationOverrides = {
  carry?: {
    mishitLossYards?: number
    severeLossYards?: number
  }
  direction?: {
    mishitAbsoluteYards?: number
    severeAbsoluteYards?: number
    mishitDeviationYards?: number
    severeDeviationYards?: number
  }
  ballSpeed?: {
    mishitLossMph?: number
    severeLossMph?: number
  }
  smashFactor?: {
    mishitLoss?: number
    severeLoss?: number
  }
}

/**
 * Optional per-player/per-population boundary overrides.
 *
 * These values are deliberately separate from global classifier policy. A
 * future Looper Inputs page can edit/store these without modifying classifier
 * code or the shared defaults used for other golfers.
 */
export type MishitPlayerCalibration = {
  version: number
  populationKey?: string
  source: MishitPlayerCalibrationSource
  status: MishitPlayerCalibrationStatus
  sampleSize?: number
  overrides?: MishitPlayerCalibrationOverrides
  notes?: string[]
}

export type MishitEffectiveThresholdDetail = {
  globalBase: number
  playerVariation?: number
  playerOverride?: number
  effective: number
}

export type MishitEffectiveThresholds = {
  personalizationApplied: boolean
  calibrationVersion?: number
  carry: {
    mishitLossYards: MishitEffectiveThresholdDetail
    severeLossYards: MishitEffectiveThresholdDetail
  }
  direction: {
    mishitAbsoluteYards: MishitEffectiveThresholdDetail
    severeAbsoluteYards: MishitEffectiveThresholdDetail
    mishitDeviationYards: MishitEffectiveThresholdDetail
    severeDeviationYards: MishitEffectiveThresholdDetail
  }
  ballSpeed: {
    mishitLossMph: MishitEffectiveThresholdDetail
    severeLossMph: MishitEffectiveThresholdDetail
  }
  smashFactor: {
    mishitLoss: MishitEffectiveThresholdDetail
    severeLoss: MishitEffectiveThresholdDetail
  }
}

export type MishitInputDefinition = {
  path: string
  label: string
  group: string
  scope: 'global_policy' | 'player_override'
  kind: 'number' | 'boolean'
  description: string
  min?: number
  max?: number
  step?: number
}
