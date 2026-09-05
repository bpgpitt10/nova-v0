export type BaselineStatus = 'insufficient' | 'provisional' | 'stable'

export type MishitClass = 'unclassified' | 'normal' | 'mishit' | 'severe_mishit'

export type MishitReasonCode =
  | 'insufficient_reference'
  | 'major_carry_loss'
  | 'severe_carry_loss'
  | 'extreme_offline'
  | 'severe_offline'
  | 'ball_speed_loss'
  | 'severe_ball_speed_loss'
  | 'smash_loss'
  | 'severe_smash_loss'
  | 'compound_failure'

export type MishitMetric =
  | 'carry'
  | 'offline'
  | 'ballSpeed'
  | 'smashFactor'
  | 'population'

export type MishitShot = {
  id: string
  capturedAt?: string
  carry?: number
  total?: number
  offline?: number
  ballSpeed?: number
  clubSpeed?: number
  smashFactor?: number
  launch?: number
  spin?: number
}

export type MishitReason = {
  code: MishitReasonCode
  metric: MishitMetric
  observed?: number
  reference?: number
  deviation?: number
  deviationPct?: number
  threshold?: number
  severity: 'info' | 'mishit' | 'severe'
}

export type RobustMetricBaseline = {
  center?: number
  mad?: number
  sampleSize: number
}

export type MishitBaseline = {
  version: number
  status: BaselineStatus
  sampleSize: number
  referenceShotCount: number
  carry: RobustMetricBaseline
  offline: RobustMetricBaseline
  ballSpeed: RobustMetricBaseline
  smashFactor: RobustMetricBaseline
}

export type MishitClassification = {
  shotId: string
  classification: MishitClass
  planningEligible: boolean
  confidence: number
  baselineVersion: number
  baselineStatus: BaselineStatus
  reasons: MishitReason[]
}

export type MishitRefreshAction =
  | 'initial_full_analysis'
  | 'new_shots_only'
  | 'baseline_rebuilt_new_only'
  | 'baseline_rebuilt_full_reclass'
  | 'no_change'

export type MishitRefreshMetadata = {
  action: MishitRefreshAction
  newShotCount: number
  removedShotCount: number
  pendingNewShotIds: string[]
  baselineChangedMaterially: boolean
}

export type MishitAnalysis = {
  baseline: MishitBaseline
  classifications: MishitClassification[]
  refresh: MishitRefreshMetadata
}

export type MishitConfig = {
  sample: {
    provisionalSampleSize: number
    stableSampleSize: number
    maturePopulationSize: number
    maxReferenceShots: number
  }
  refresh: {
    earlyEveryNewShots: number
    matureEveryNewShots: number
    fullReclassUntilSampleSize: number
    baselineChange: {
      carryCenterPct: number
      offlineCenterYards: number
      ballSpeedCenterPct: number
      smashFactorAbsolute: number
    }
  }
  baselineRefinement: {
    enabled: boolean
    maxPasses: number
  }
  carry: {
    mishitLossPct: number
    mishitLossFloorYards: number
    severeLossPct: number
    severeLossFloorYards: number
  }
  direction: {
    mishitAbsoluteFloorYards: number
    mishitPctOfCarryCenter: number
    severeAbsoluteFloorYards: number
    severePctOfCarryCenter: number
    mishitDeviationFromCenterYards: number
    severeDeviationFromCenterYards: number
  }
  strike: {
    ballSpeedMishitLossPct: number
    ballSpeedSevereLossPct: number
    smashFactorMishitLoss: number
    smashFactorSevereLoss: number
  }
  compound: {
    mishitSignalCount: number
    severeSignalCount: number
  }
}

export type RefreshMishitAnalysisArgs = {
  shots: MishitShot[]
  previous?: MishitAnalysis
  config?: MishitConfig
  forceFullReclass?: boolean
}
