export type PatternStabilityConfig = {
  recentWindowTargetShots: number
  recentWindowMinShots: number
  priorBaselineMinShots: number
  totalUsableMinShots: number
  minDistinctSessions: number
  carryDriftTolerancePct: number
  carryDriftToleranceFloorYards: number
  directionTargetWidthPct: number
  offlineToleranceTargetWidthMultiplier: number
  carryDriftWeight: number
  offlineDriftWeight: number
  fullEvidenceShotsPerWindow: number
  evidenceAnchorScore: number
}

/**
 * Exact active constants used by the web-gspro-clean Pattern Stability calculation.
 * This object intentionally freezes current behavior for parity testing.
 */
export const patternStabilityLegacyV1Config: PatternStabilityConfig = {
  recentWindowTargetShots: 12,
  recentWindowMinShots: 5,
  priorBaselineMinShots: 5,
  totalUsableMinShots: 15,
  minDistinctSessions: 2,
  carryDriftTolerancePct: 0.08,
  carryDriftToleranceFloorYards: 8,
  directionTargetWidthPct: 0.15,
  offlineToleranceTargetWidthMultiplier: 0.5,
  carryDriftWeight: 0.5,
  offlineDriftWeight: 0.5,
  fullEvidenceShotsPerWindow: 10,
  evidenceAnchorScore: 50,
}
