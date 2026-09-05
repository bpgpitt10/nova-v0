export type DistanceWindowConfig = {
  inWindowThresholdPct: number
  inWindowThresholdFloorYards: number
  zeroScoreThresholdPct: number
  zeroScoreThresholdFloorYards: number
  windowScoreWeight: number
  spreadScoreWeight: number
  spreadElitePct: number
  spreadEliteFloorYards: number
  spreadGoodPct: number
  spreadGoodFloorYards: number
  spreadZeroPct: number
  spreadZeroFloorYards: number
  spreadLowerPercentile: number
  spreadUpperPercentile: number
  rankWeights: Readonly<Record<string, number>>
}

export const distanceWindowLegacyV1Config: DistanceWindowConfig = {
  inWindowThresholdPct: 0.015,
  inWindowThresholdFloorYards: 2,
  zeroScoreThresholdPct: 0.12,
  zeroScoreThresholdFloorYards: 24,
  windowScoreWeight: 0.25,
  spreadScoreWeight: 0.75,
  spreadElitePct: 0.015,
  spreadEliteFloorYards: 2,
  spreadGoodPct: 0.04,
  spreadGoodFloorYards: 8,
  spreadZeroPct: 0.12,
  spreadZeroFloorYards: 24,
  spreadLowerPercentile: 10,
  spreadUpperPercentile: 90,
  rankWeights: {
    'S+': 1.35,
    S: 1.22,
    A: 1.1,
    B: 1,
    C: 0.9,
    D: 0.78,
    E: 0.66,
    '1': 1.1,
    '2': 1,
    '3': 0.9,
    '4': 0.78,
    '5': 0.66,
  },
}
