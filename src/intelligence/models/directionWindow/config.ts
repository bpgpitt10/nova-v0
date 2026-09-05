export type DirectionWindowConfig = {
  targetWidthPct: number
  planningMissThresholdPctOfTargetWidth: number
  inWindowThresholdPctOfTargetWidth: number
  zeroScoreThresholdPctOfTargetWidth: number
  twoWayPenaltyMultiplier: number
  twoWayPenaltyCap: number
}

export const directionWindowLegacyV1Config: DirectionWindowConfig = {
  targetWidthPct: 0.15,
  planningMissThresholdPctOfTargetWidth: 0.5,
  inWindowThresholdPctOfTargetWidth: 0.5,
  zeroScoreThresholdPctOfTargetWidth: 1.5,
  twoWayPenaltyMultiplier: 40,
  twoWayPenaltyCap: 16,
}
