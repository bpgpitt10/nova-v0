#!/usr/bin/env python3
from pathlib import Path

path = Path('src/liveCaddie/greenTargeting.ts')
text = path.read_text(encoding='utf-8')
start = text.index('export const sampleGreywolfGreenSlopeAtPoint = (')
end = text.index('\nconst directionLabel =', start)
replacement = r'''const MAX_TACTICAL_SECTOR_SLOPE_PERCENT = 12

const summarySlope = (
  slopePercent: number | null | undefined,
  downhillLocalUnit: readonly [number, number] | null | undefined,
): GreenLocalSlope | null => {
  if (typeof slopePercent !== 'number' || !Number.isFinite(slopePercent)) return null
  if (!downhillLocalUnit) return null
  const downhill = normalize([downhillLocalUnit[0], downhillLocalUnit[1]])
  if (!downhill) return null
  return { slopePercent, downhill }
}

export const sampleGreywolfGreenSlopeAtPoint = (
  detail: GreywolfGreenDetail,
  point: CoursePointYds,
): GreenLocalSlope | null => {
  // The raw 1 yd DEM remains authoritative for elevation, but the all-18 audit
  // showed that local derivatives can capture banks/edge artifacts that are far
  // steeper than a playable putting surface. Strategy only needs broad green
  // structure, so use the fitted 3x3 sector plane first. If a sector itself is
  // implausibly steep (>12%), fall back to the whole-green plane rather than
  // turning a local LiDAR cliff into a five-yard tactical instruction.
  const sector = greenSectorAtPoint(detail, point)
  const sectorSlope = summarySlope(
    sector?.planeSlopePercent,
    sector?.downhillLocalUnit ?? null,
  )
  if (
    sectorSlope
    && sectorSlope.slopePercent >= 0
    && sectorSlope.slopePercent <= MAX_TACTICAL_SECTOR_SLOPE_PERCENT
  ) return sectorSlope

  return summarySlope(
    detail.greenSummary.planeSlopePercent,
    detail.greenSummary.downhillLocalUnit,
  )
}
'''
path.write_text(text[:start] + replacement + text[end:], encoding='utf-8')
