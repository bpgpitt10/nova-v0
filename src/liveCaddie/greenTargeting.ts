import { classifyPoint, pointInPolygon } from '../courseGeometry/geometry'
import {
  courseGreenSectorAtPoint as greenSectorAtPoint,
  sampleCourseGreenElevation,
  type CourseGreenDetail,
} from '../courseGeometry/courseGreenDetail'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
} from '../courseGeometry/types'

export type GreenTargetingGuidance = {
  target: CoursePointYds
  applied: boolean
  source: 'course-green-lidar-1yd'
  pinSector: string | null
  pinElevationFt: number | null
  localSlopePercent: number | null
  downhillLocalUnit: CoursePointYds | null
  downhillLabel: string | null
  edgeClearanceYds: number | null
  shiftRightYds: number
  shiftForwardYds: number
  shiftYds: number
  reason: string
}

export type GreenLocalSlope = {
  slopePercent: number
  downhill: CoursePointYds
}

export type GreenRolloutResolution = {
  landing: CoursePointYds
  applied: boolean
  slopePercent: number | null
  downhillLocalUnit: CoursePointYds | null
  blendWeight: number
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

const normalize = (value: CoursePointYds): CoursePointYds | null => {
  const length = Math.hypot(value[0], value[1])
  return length > 1e-8 ? [value[0] / length, value[1] / length] : null
}

const closestPointOnSegment = (
  point: CoursePointYds,
  start: CoursePointYds,
  end: CoursePointYds,
): CoursePointYds => {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 1e-9) return start
  const t = clamp(
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared,
    0,
    1,
  )
  return [start[0] + dx * t, start[1] + dy * t]
}

const polygonCentroid = (polygon: CoursePolygonYds): CoursePointYds => {
  if (polygon.length === 0) return [0, 0]
  const sum = polygon.reduce(
    (accumulator, point) => [accumulator[0] + point[0], accumulator[1] + point[1]] as CoursePointYds,
    [0, 0] as CoursePointYds,
  )
  return [sum[0] / polygon.length, sum[1] / polygon.length]
}

const nearestBoundary = (
  polygon: CoursePolygonYds,
  point: CoursePointYds,
) => {
  let nearestPoint: CoursePointYds | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index]
    const end = polygon[(index + 1) % polygon.length]
    const candidate = closestPointOnSegment(point, start, end)
    const distance = Math.hypot(candidate[0] - point[0], candidate[1] - point[1])
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestPoint = candidate
    }
  }
  if (!nearestPoint || !Number.isFinite(nearestDistance)) return null

  let inward = normalize([
    point[0] - nearestPoint[0],
    point[1] - nearestPoint[1],
  ])
  if (!inward) {
    const centroid = polygonCentroid(polygon)
    inward = normalize([centroid[0] - point[0], centroid[1] - point[1]])
  }

  return {
    distanceYds: nearestDistance,
    inward,
  }
}

const MAX_TACTICAL_SECTOR_SLOPE_PERCENT = 12

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

export const sampleCourseGreenSlopeAtPoint = (
  detail: CourseGreenDetail,
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

const directionLabel = (direction: CoursePointYds | null) => {
  if (!direction) return null
  const horizontal = Math.abs(direction[0]) >= 0.35
    ? direction[0] > 0 ? 'right' : 'left'
    : null
  const vertical = Math.abs(direction[1]) >= 0.35
    ? direction[1] > 0 ? 'back' : 'front'
    : null
  if (vertical && horizontal) return `${vertical}-${horizontal}`
  return vertical ?? horizontal ?? 'flat'
}

const containingGreenPolygon = (
  hole: CourseHoleGeometry,
  pin: CoursePointYds,
): CoursePolygonYds | null => {
  for (const surface of hole.surfaces) {
    if (surface.kind !== 'green') continue
    for (const polygon of surface.polygons) {
      if (pointInPolygon(pin, polygon)) return polygon
    }
  }
  return null
}

const safeShiftedTarget = (
  polygon: CoursePolygonYds,
  detail: CourseGreenDetail,
  pin: CoursePointYds,
  shift: CoursePointYds,
): CoursePointYds => {
  for (const scale of [1, 0.75, 0.5, 0.25]) {
    const candidate: CoursePointYds = [
      pin[0] + shift[0] * scale,
      pin[1] + shift[1] * scale,
    ]
    if (
      pointInPolygon(candidate, polygon)
      && sampleCourseGreenElevation(detail, candidate) != null
    ) return candidate
  }
  return pin
}

/**
 * Preserve the player's observed rollout DISTANCE, but let measured green slope
 * redirect some of that rollout after a green touchdown. This deliberately does
 * not invent extra yards of run. Flat greens and non-green carry landings are
 * unchanged; steeper greens can bend the resting distribution toward the actual
 * downhill side and, where geometry warrants it, off the green.
 */
export const redirectCourseGreenRollout = ({
  hole,
  detail,
  carryLanding,
  baselineLanding,
}: {
  hole: CourseHoleGeometry
  detail: CourseGreenDetail
  carryLanding: CoursePointYds
  baselineLanding: CoursePointYds
}): GreenRolloutResolution => {
  const base: GreenRolloutResolution = {
    landing: baselineLanding,
    applied: false,
    slopePercent: null,
    downhillLocalUnit: null,
    blendWeight: 0,
  }
  if (classifyPoint(hole, carryLanding).kind !== 'green') return base

  const rolloutVector: CoursePointYds = [
    baselineLanding[0] - carryLanding[0],
    baselineLanding[1] - carryLanding[1],
  ]
  const rolloutYds = Math.hypot(rolloutVector[0], rolloutVector[1])
  if (rolloutYds < 0.25) return base

  const slope = sampleCourseGreenSlopeAtPoint(detail, carryLanding)
  if (!slope || slope.slopePercent <= 1.25) {
    return {
      ...base,
      slopePercent: slope?.slopePercent ?? null,
      downhillLocalUnit: slope?.downhill ?? null,
    }
  }

  const rolloutDirection = normalize(rolloutVector)
  if (!rolloutDirection) return base
  const blendWeight = clamp((slope.slopePercent - 1.25) / 4.5, 0, 0.65)
  const blendedDirection = normalize([
    rolloutDirection[0] * (1 - blendWeight) + slope.downhill[0] * blendWeight,
    rolloutDirection[1] * (1 - blendWeight) + slope.downhill[1] * blendWeight,
  ])
  if (!blendedDirection || blendWeight < 0.01) return base

  return {
    landing: [
      carryLanding[0] + blendedDirection[0] * rolloutYds,
      carryLanding[1] + blendedDirection[1] * rolloutYds,
    ],
    applied: true,
    slopePercent: slope.slopePercent,
    downhillLocalUnit: slope.downhill,
    blendWeight,
  }
}

/**
 * Conservative approach-level green guidance.
 *
 * The 1-yard LiDAR is used to understand the broad landing/roll shape near an
 * exact GSPro pin. It deliberately does not model putting break. The target is
 * nudged slightly uphill and/or away from a nearby green edge, with a hard 5 yd
 * cap and an on-green guard.
 */
export const buildCourseGreenApproachTarget = ({
  hole,
  ball,
  pin,
  detail,
  exactPin,
}: {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  pin: CoursePointYds
  detail: CourseGreenDetail
  exactPin: boolean
}): GreenTargetingGuidance => {
  const pinElevationFt = sampleCourseGreenElevation(detail, pin)
  const sector = greenSectorAtPoint(detail, pin)
  const polygon = containingGreenPolygon(hole, pin)
  const slope = sampleCourseGreenSlopeAtPoint(detail, pin)
  const downhillLabel = directionLabel(slope?.downhill ?? null)
  const edge = polygon ? nearestBoundary(polygon, pin) : null

  const base: GreenTargetingGuidance = {
    target: pin,
    applied: false,
    source: 'course-green-lidar-1yd',
    pinSector: sector?.id ?? null,
    pinElevationFt,
    localSlopePercent: slope?.slopePercent ?? null,
    downhillLocalUnit: slope?.downhill ?? null,
    downhillLabel,
    edgeClearanceYds: edge?.distanceYds ?? null,
    shiftRightYds: 0,
    shiftForwardYds: 0,
    shiftYds: 0,
    reason: exactPin
      ? '1 yd LiDAR green context available; no target shift warranted.'
      : '1 yd LiDAR green context available, but target shift waits for an exact GSPro pin.',
  }

  const distanceToPin = Math.hypot(pin[0] - ball[0], pin[1] - ball[1])
  if (!exactPin || !polygon || pinElevationFt == null || distanceToPin > 260) return base

  const slopePercent = slope?.slopePercent ?? 0
  const slopeShiftYds = slope?.downhill
    ? clamp((slopePercent - 1.5) * 0.45, 0, 3)
    : 0
  const uphill: CoursePointYds | null = slope?.downhill
    ? [-slope.downhill[0], -slope.downhill[1]]
    : null

  const desiredEdgeClearanceYds = 7
  const edgeShiftYds = edge?.inward
    ? clamp((desiredEdgeClearanceYds - edge.distanceYds) * 0.55, 0, 3.5)
    : 0

  let shiftRightYds = (uphill?.[0] ?? 0) * slopeShiftYds
    + (edge?.inward?.[0] ?? 0) * edgeShiftYds
  let shiftForwardYds = (uphill?.[1] ?? 0) * slopeShiftYds
    + (edge?.inward?.[1] ?? 0) * edgeShiftYds
  const rawShiftYds = Math.hypot(shiftRightYds, shiftForwardYds)
  if (rawShiftYds > 5) {
    const scale = 5 / rawShiftYds
    shiftRightYds *= scale
    shiftForwardYds *= scale
  }

  if (Math.hypot(shiftRightYds, shiftForwardYds) < 0.35) return base

  const target = safeShiftedTarget(
    polygon,
    detail,
    pin,
    [shiftRightYds, shiftForwardYds],
  )
  const appliedRight = target[0] - pin[0]
  const appliedForward = target[1] - pin[1]
  const appliedShift = Math.hypot(appliedRight, appliedForward)
  if (appliedShift < 0.35) return base

  const influences = [
    slopeShiftYds >= 0.35 ? 'uphill' : null,
    edgeShiftYds >= 0.35 ? 'inward' : null,
  ].filter(Boolean).join(' + ')
  const sectorLabel = sector ? `${sector.row}-${sector.column} pin` : 'pin'
  const slopeLabel = slope && downhillLabel
    ? `green falls ${downhillLabel} (${slope.slopePercent.toFixed(1)}%)`
    : 'local green slope unavailable'

  return {
    ...base,
    target,
    applied: true,
    shiftRightYds: appliedRight,
    shiftForwardYds: appliedForward,
    shiftYds: appliedShift,
    reason: `${sectorLabel} · ${slopeLabel} · ${appliedShift.toFixed(1)} yd ${influences || 'safer'} target`,
  }
}
