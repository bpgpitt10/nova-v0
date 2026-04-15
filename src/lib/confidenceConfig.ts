import type { Club } from './bagConfig'

export type ConfidenceConfig = {
  historicalWindowDays: number
  historicalTimeDecayLambda: number
  historicalSessionTargetShotCount: number
  displayCarryOutlierThresholdPct: number
  displayCarryOutlierThresholdFloorYards: number
  componentWeights: {
    distanceWindow: number
    directionWindow: number
    flightQuality: number
    patternStability: number
    dataConfidence: number
  }
  recency: {
    // Session-based exponential decay where index 0 is newest.
    sessionDecayStrength: number
    // Weight floor keeps historical signal from dropping to zero.
    minSessionWeightFloor: number
  }
  directionWindow: {
    targetWidthPct: number
    planningMissThresholdPctOfTargetWidth: number
    twoWayPenaltyMultiplier: number
    twoWayPenaltyCap: number
    targetWidthByClub: Partial<Record<Club, number>>
    maxOfflineMultiplier: number
    twoWayMissPenalty: number
    sideSwitchThresholdYards: number
  }
  distanceWindow: {
    inWindowThresholdPct: number
    inWindowThresholdFloorYards: number
    zeroScoreThresholdPct: number
    zeroScoreThresholdFloorYards: number
    anchorTolerancePct: number
    anchorToleranceFloorYards: number
    stdDevTargetPct: number
    stdDevTargetFloorYards: number
    anchorToleranceYards: number
    consistencyTargetStdDevYards: number
    rankWeights: Record<string, number>
  }
  flightQuality: {
    ballSpeedRange: [number, number]
    verticalLaunchRange: [number, number]
    horizontalLaunchAbsMax: number
    totalSpinRange: [number, number]
    spinAxisAbsMax: number
    missingFieldPenaltyPerField: number
  }
  patternStability: {
    carryDriftTolerancePct: number
    carryDriftToleranceFloorYards: number
    carryStdDevTarget: number
    offlineStdDevTarget: number
    driftTargetYards: number
    sessionSupportBonusPerSession: number
    maxSessionSupportBonus: number
  }
  dataConfidence: {
    targetIncludedShots: number
    targetSessions: number
    missingRequiredFieldPenalty: number
  }
  caddieCalls: Array<{
    minScore: number
    label: 'Attack' | 'Play' | 'Manage' | 'Careful' | 'Liability'
  }>
  insufficientData: {
    minIncludedShots: number
  }
}

export const confidenceConfig: ConfidenceConfig = {
  historicalWindowDays: 180,
  historicalTimeDecayLambda: 0.02,
  historicalSessionTargetShotCount: 12,
  displayCarryOutlierThresholdPct: 0.12,
  displayCarryOutlierThresholdFloorYards: 18,
  componentWeights: {
    distanceWindow: 0.28,
    directionWindow: 0.24,
    flightQuality: 0.16,
    patternStability: 0.18,
    dataConfidence: 0.14,
  },
  recency: {
    sessionDecayStrength: 0.34,
    minSessionWeightFloor: 0.25,
  },
  directionWindow: {
    targetWidthPct: 0.15,
    planningMissThresholdPctOfTargetWidth: 0.5,
    twoWayPenaltyMultiplier: 40,
    twoWayPenaltyCap: 16,
    targetWidthByClub: {
      Driver: 32,
      '3W': 28,
      '3H': 24,
      '5i': 21,
      '6i': 20,
      '7i': 18,
      '8i': 17,
      '9i': 16,
      PW: 14,
      GW: 13,
      SW: 12,
      LW: 11,
    },
    maxOfflineMultiplier: 2.5,
    twoWayMissPenalty: 12,
    sideSwitchThresholdYards: 5,
  },
  distanceWindow: {
    inWindowThresholdPct: 0.08,
    inWindowThresholdFloorYards: 8,
    zeroScoreThresholdPct: 0.16,
    zeroScoreThresholdFloorYards: 16,
    anchorTolerancePct: 0.08,
    anchorToleranceFloorYards: 8,
    stdDevTargetPct: 0.05,
    stdDevTargetFloorYards: 5,
    anchorToleranceYards: 12,
    consistencyTargetStdDevYards: 8,
    rankWeights: {
      'S+': 1.35,
      S: 1.22,
      A: 1.1,
      B: 1,
      C: 0.9,
      D: 0.78,
      E: 0.66,
      1: 1.1,
      2: 1,
      3: 0.9,
      4: 0.78,
      5: 0.66,
    },
  },
  flightQuality: {
    ballSpeedRange: [30, 85],
    verticalLaunchRange: [5, 35],
    horizontalLaunchAbsMax: 12,
    totalSpinRange: [1000, 12000],
    spinAxisAbsMax: 25,
    missingFieldPenaltyPerField: 6,
  },
  patternStability: {
    carryDriftTolerancePct: 0.08,
    carryDriftToleranceFloorYards: 8,
    carryStdDevTarget: 10,
    offlineStdDevTarget: 12,
    driftTargetYards: 10,
    sessionSupportBonusPerSession: 5,
    maxSessionSupportBonus: 20,
  },
  dataConfidence: {
    targetIncludedShots: 12,
    targetSessions: 3,
    missingRequiredFieldPenalty: 20,
  },
  caddieCalls: [
    { minScore: 85, label: 'Attack' },
    { minScore: 72, label: 'Play' },
    { minScore: 58, label: 'Manage' },
    { minScore: 40, label: 'Careful' },
    { minScore: 0, label: 'Liability' },
  ],
  insufficientData: {
    minIncludedShots: 4,
  },
}
