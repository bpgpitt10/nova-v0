import {
  SURFACE_CLASSIFICATION_PRECEDENCE,
  TACTICAL_SURFACE_SEMANTICS,
} from './semantics'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurfaceClassification,
  CourseSurfaceKind,
} from './types'

const EPSILON = 1e-9

type PolygonBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

const polygonBoundsCache = new WeakMap<CoursePolygonYds, PolygonBounds>()

const polygonBounds = (polygon: CoursePolygonYds): PolygonBounds => {
  const cached = polygonBoundsCache.get(polygon)
  if (cached) return cached

  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const [x, y] of polygon) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }

  const bounds = { minX, maxX, minY, maxY }
  polygonBoundsCache.set(polygon, bounds)
  return bounds
}

export type SurfaceClassificationResult = {
  kind: CourseSurfaceClassification
  surfaceId: string | null
  confidence: 'high' | 'medium' | 'low' | 'unknown'
}

export type CrossSectionInterval = {
  min: number
  max: number
  width: number
  center: number
}

export type TacticalStation = {
  forwardYds: number
  fairwayCorridor: {
    leftEdgeYds: number
    rightEdgeYds: number
    widthYds: number
    centerRightYds: number
  } | null
  landingDepthYds: number | null
  nearestTroubleYds: number | null
  nearestPenaltyYds: number | null
  nearestBunkerYds: number | null
  leftTroubleYds: number | null
  rightTroubleYds: number | null
  safeSide: 'left' | 'center' | 'right' | 'unknown'
}

export type LandingEllipseCoverage = {
  center: CoursePointYds
  lateralRadiusYds: number
  longitudinalRadiusYds: number
  sampleCount: number
  /** Geometric sample coverage only; this is not a shot probability model. */
  surfaceCoverage: Partial<Record<CourseSurfaceClassification, number>>
  preferredCoverage: number
  troubleCoverage: number
  penaltyCoverage: number
  unknownCoverage: number
}

export type CourseGeometryValidation = {
  ok: boolean
  issues: string[]
  surfaceCount: number
  polygonCount: number
}

function isFinitePoint(point: CoursePointYds) {
  return Number.isFinite(point[0]) && Number.isFinite(point[1])
}

function closestPointOnSegment(
  point: CoursePointYds,
  start: CoursePointYds,
  end: CoursePointYds,
): CoursePointYds {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= EPSILON) return start

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared,
    ),
  )
  return [start[0] + t * dx, start[1] + t * dy]
}

function distanceBetween(a: CoursePointYds, b: CoursePointYds) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function pointOnSegment(
  point: CoursePointYds,
  start: CoursePointYds,
  end: CoursePointYds,
) {
  const closest = closestPointOnSegment(point, start, end)
  return distanceBetween(point, closest) <= 1e-7
}

export function pointInPolygon(point: CoursePointYds, polygon: CoursePolygonYds) {
  if (polygon.length < 3) return false

  const bounds = polygonBounds(polygon)
  if (
    point[0] < bounds.minX - EPSILON ||
    point[0] > bounds.maxX + EPSILON ||
    point[1] < bounds.minY - EPSILON ||
    point[1] > bounds.maxY + EPSILON
  ) {
    return false
  }

  // Hot path (2,048 samples x aim lines x clubs): no allocation per edge.
  // On-edge test is the same 1e-7 yd tolerance as pointOnSegment, done with
  // a cross product first so ordinary edges cost a few multiplications.
  const px = point[0]
  const py = point[1]
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]
    const b = polygon[i]
    const ax = a[0]
    const ay = a[1]
    const bx = b[0]
    const by = b[1]
    const dx = bx - ax
    const dy = by - ay
    const cross = dx * (py - ay) - dy * (px - ax)
    if (Math.abs(cross) <= ON_EDGE_YDS * Math.hypot(dx, dy) + ON_EDGE_YDS * ON_EDGE_YDS
      && pointOnSegment(point, a, b)) return true

    if ((ay > py) !== (by > py) && px < (dx * (py - ay)) / dy + ax) inside = !inside
  }

  return inside
}

const ON_EDGE_YDS = 1e-7

// GSPro's own penalty areas and OB (nativeHazards.ts) are keyhole polygons
// spanning the whole hole frame, so the bounding-box reject never fires and
// every landing walked every edge (review, 11/4: seconds per recommendation).
// They're looked up in a 0.5-yd even-odd raster built once per polygon.
const GSPRO_RASTER_YDS = 0.5
const GSPRO_RASTER_MAX_CELLS = 6_000_000
type PolygonRaster = { minX: number; minY: number; width: number; height: number; cells: Uint8Array }
const gsproRasters = new WeakMap<CoursePolygonYds, PolygonRaster | null>()

const buildPolygonRaster = (polygon: CoursePolygonYds): PolygonRaster | null => {
  const b = polygonBounds(polygon)
  const width = Math.max(1, Math.ceil((b.maxX - b.minX) / GSPRO_RASTER_YDS) + 1)
  const height = Math.max(1, Math.ceil((b.maxY - b.minY) / GSPRO_RASTER_YDS) + 1)
  if (width * height > GSPRO_RASTER_MAX_CELLS) return null
  const cells = new Uint8Array(width * height)
  const crossings: number[] = []
  for (let row = 0; row < height; row += 1) {
    const y = b.minY + row * GSPRO_RASTER_YDS
    crossings.length = 0
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [ax, ay] = polygon[j]
      const [bx, by] = polygon[i]
      if ((ay > y) !== (by > y)) crossings.push(ax + ((y - ay) * (bx - ax)) / (by - ay))
    }
    crossings.sort((p, q) => p - q)
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((crossings[k] - b.minX) / GSPRO_RASTER_YDS))
      const c1 = Math.min(width - 1, Math.floor((crossings[k + 1] - b.minX) / GSPRO_RASTER_YDS))
      const offset = row * width
      for (let c = c0; c <= c1; c += 1) cells[offset + c] = 1
    }
  }
  return { minX: b.minX, minY: b.minY, width, height, cells }
}

const insideGsproPolygon = (point: CoursePointYds, polygon: CoursePolygonYds) => {
  let raster = gsproRasters.get(polygon)
  if (raster === undefined) {
    raster = buildPolygonRaster(polygon)
    gsproRasters.set(polygon, raster)
  }
  if (!raster) return pointInPolygon(point, polygon)
  const col = Math.round((point[0] - raster.minX) / GSPRO_RASTER_YDS)
  const row = Math.round((point[1] - raster.minY) / GSPRO_RASTER_YDS)
  if (col < 0 || row < 0 || col >= raster.width || row >= raster.height) return false
  return raster.cells[row * raster.width + col] === 1
}

export function classifyPoint(
  hole: CourseHoleGeometry,
  point: CoursePointYds,
): SurfaceClassificationResult {
  for (const kind of SURFACE_CLASSIFICATION_PRECEDENCE) {
    for (const surface of hole.surfaces) {
      if (surface.kind !== kind) continue
      const inside = surface.provenance?.source === 'gspro'
        ? surface.polygons.some((polygon) => insideGsproPolygon(point, polygon))
        : surface.polygons.some((polygon) => pointInPolygon(point, polygon))
      if (inside) {
        return {
          kind,
          surfaceId: surface.id,
          confidence: surface.provenance.confidence,
        }
      }
    }
  }

  return { kind: 'unknown', surfaceId: null, confidence: 'unknown' }
}

function mergeIntervals(intervals: CrossSectionInterval[]) {
  if (intervals.length === 0) return []

  const sorted = [...intervals].sort((a, b) => a.min - b.min)
  const merged: CrossSectionInterval[] = []

  for (const interval of sorted) {
    const previous = merged[merged.length - 1]
    if (!previous || interval.min > previous.max + 1e-7) {
      merged.push({ ...interval })
      continue
    }

    previous.max = Math.max(previous.max, interval.max)
    previous.width = previous.max - previous.min
    previous.center = (previous.min + previous.max) / 2
  }

  return merged
}

function horizontalIntervalsForPolygon(polygon: CoursePolygonYds, y: number) {
  const intersections: number[] = []
  if (polygon.length < 3) return []

  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]

    if ((a[1] > y) === (b[1] > y)) continue
    const x = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
    intersections.push(x)
  }

  intersections.sort((a, b) => a - b)
  const intervals: CrossSectionInterval[] = []
  for (let i = 0; i + 1 < intersections.length; i += 2) {
    const min = intersections[i]
    const max = intersections[i + 1]
    intervals.push({ min, max, width: max - min, center: (min + max) / 2 })
  }
  return intervals
}

function verticalIntervalsForPolygon(polygon: CoursePolygonYds, x: number) {
  const intersections: number[] = []
  if (polygon.length < 3) return []

  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]

    if ((a[0] > x) === (b[0] > x)) continue
    const y = a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0])
    intersections.push(y)
  }

  intersections.sort((a, b) => a - b)
  const intervals: CrossSectionInterval[] = []
  for (let i = 0; i + 1 < intersections.length; i += 2) {
    const min = intersections[i]
    const max = intersections[i + 1]
    intervals.push({ min, max, width: max - min, center: (min + max) / 2 })
  }
  return intervals
}

export function surfaceIntervalsAtForwardY(
  hole: CourseHoleGeometry,
  forwardYds: number,
  kinds: readonly CourseSurfaceKind[],
) {
  const requested = new Set(kinds)
  const intervals = hole.surfaces.flatMap((surface) => {
    if (!requested.has(surface.kind)) return []
    return surface.polygons.flatMap((polygon) => horizontalIntervalsForPolygon(polygon, forwardYds))
  })
  return mergeIntervals(intervals)
}

export function surfaceIntervalsAtRightX(
  hole: CourseHoleGeometry,
  rightYds: number,
  kinds: readonly CourseSurfaceKind[],
) {
  const requested = new Set(kinds)
  const intervals = hole.surfaces.flatMap((surface) => {
    if (!requested.has(surface.kind)) return []
    return surface.polygons.flatMap((polygon) => verticalIntervalsForPolygon(polygon, rightYds))
  })
  return mergeIntervals(intervals)
}

function intervalDistance(value: number, interval: CrossSectionInterval) {
  if (value < interval.min) return interval.min - value
  if (value > interval.max) return value - interval.max
  return 0
}

function chooseRelevantInterval(intervals: CrossSectionInterval[], reference: number) {
  if (intervals.length === 0) return null
  return [...intervals].sort((a, b) => {
    const distanceDelta = intervalDistance(reference, a) - intervalDistance(reference, b)
    if (Math.abs(distanceDelta) > EPSILON) return distanceDelta
    return b.width - a.width
  })[0]
}

export function fairwayCorridorAtForwardY(
  hole: CourseHoleGeometry,
  forwardYds: number,
  referenceRightYds = 0,
) {
  const interval = chooseRelevantInterval(
    surfaceIntervalsAtForwardY(hole, forwardYds, ['fairway']),
    referenceRightYds,
  )
  if (!interval) return null

  return {
    leftEdgeYds: interval.min,
    rightEdgeYds: interval.max,
    widthYds: interval.width,
    centerRightYds: interval.center,
  }
}

export function fairwayDepthAtPoint(
  hole: CourseHoleGeometry,
  point: CoursePointYds,
) {
  const interval = chooseRelevantInterval(
    surfaceIntervalsAtRightX(hole, point[0], ['fairway']),
    point[1],
  )
  return interval?.width ?? null
}

function pointToPolygonBoundaryDistance(point: CoursePointYds, polygon: CoursePolygonYds) {
  if (polygon.length === 0) return Number.POSITIVE_INFINITY
  let minimum = Number.POSITIVE_INFINITY

  for (let i = 0; i < polygon.length; i += 1) {
    const start = polygon[i]
    const end = polygon[(i + 1) % polygon.length]
    minimum = Math.min(minimum, distanceBetween(point, closestPointOnSegment(point, start, end)))
  }

  return minimum
}

export function nearestSurfaceDistance(
  hole: CourseHoleGeometry,
  point: CoursePointYds,
  kinds: readonly CourseSurfaceKind[],
) {
  const requested = new Set(kinds)
  let minimum = Number.POSITIVE_INFINITY
  let found = false

  for (const surface of hole.surfaces) {
    if (!requested.has(surface.kind)) continue
    for (const polygon of surface.polygons) {
      found = true
      if (pointInPolygon(point, polygon)) return 0
      minimum = Math.min(minimum, pointToPolygonBoundaryDistance(point, polygon))
    }
  }

  return found && Number.isFinite(minimum) ? minimum : null
}

function nearestTroubleBySide(
  hole: CourseHoleGeometry,
  point: CoursePointYds,
  forwardBandYds: number,
) {
  let left = Number.POSITIVE_INFINITY
  let right = Number.POSITIVE_INFINITY

  for (const surface of hole.surfaces) {
    if (!TACTICAL_SURFACE_SEMANTICS[surface.kind].countsAsTrouble) continue

    for (const polygon of surface.polygons) {
      for (let i = 0; i < polygon.length; i += 1) {
        const start = polygon[i]
        const end = polygon[(i + 1) % polygon.length]
        const edgeMinY = Math.min(start[1], end[1])
        const edgeMaxY = Math.max(start[1], end[1])
        if (edgeMaxY < point[1] - forwardBandYds || edgeMinY > point[1] + forwardBandYds) continue

        const closest = closestPointOnSegment(point, start, end)
        const distance = distanceBetween(point, closest)
        if (closest[0] < point[0] - EPSILON) left = Math.min(left, distance)
        else if (closest[0] > point[0] + EPSILON) right = Math.min(right, distance)
        else {
          left = Math.min(left, distance)
          right = Math.min(right, distance)
        }
      }
    }
  }

  return {
    leftYds: Number.isFinite(left) ? left : null,
    rightYds: Number.isFinite(right) ? right : null,
  }
}

function safeSideFromTrouble(left: number | null, right: number | null) {
  if (left == null && right == null) return 'unknown' as const
  if (left == null) return 'left' as const
  if (right == null) return 'right' as const

  const meaningfulDifferenceYds = 3
  if (left + meaningfulDifferenceYds < right) return 'right' as const
  if (right + meaningfulDifferenceYds < left) return 'left' as const
  return 'center' as const
}

export function analyzeTacticalStation(
  hole: CourseHoleGeometry,
  forwardYds: number,
  referenceRightYds = 0,
  forwardTroubleBandYds = 35,
): TacticalStation {
  const corridor = fairwayCorridorAtForwardY(hole, forwardYds, referenceRightYds)
  const centerRightYds = corridor?.centerRightYds ?? referenceRightYds
  const point: CoursePointYds = [centerRightYds, forwardYds]

  const troubleKinds = hole.surfaces
    .filter((surface) => TACTICAL_SURFACE_SEMANTICS[surface.kind].countsAsTrouble)
    .map((surface) => surface.kind)
  const troubleBySide = nearestTroubleBySide(hole, point, forwardTroubleBandYds)

  return {
    forwardYds,
    fairwayCorridor: corridor,
    landingDepthYds: fairwayDepthAtPoint(hole, point),
    nearestTroubleYds: nearestSurfaceDistance(hole, point, troubleKinds),
    nearestPenaltyYds: nearestSurfaceDistance(hole, point, ['water', 'penalty']),
    nearestBunkerYds: nearestSurfaceDistance(hole, point, ['bunker']),
    leftTroubleYds: troubleBySide.leftYds,
    rightTroubleYds: troubleBySide.rightYds,
    safeSide: safeSideFromTrouble(troubleBySide.leftYds, troubleBySide.rightYds),
  }
}

export function sampleLandingEllipse(
  hole: CourseHoleGeometry,
  center: CoursePointYds,
  lateralRadiusYds: number,
  longitudinalRadiusYds: number,
  sampleStepYds = 2,
): LandingEllipseCoverage {
  if (lateralRadiusYds <= 0 || longitudinalRadiusYds <= 0 || sampleStepYds <= 0) {
    throw new Error('Landing ellipse radii and sample step must be positive.')
  }

  const counts = new Map<CourseSurfaceClassification, number>()
  let sampleCount = 0

  for (let dy = -longitudinalRadiusYds; dy <= longitudinalRadiusYds + EPSILON; dy += sampleStepYds) {
    for (let dx = -lateralRadiusYds; dx <= lateralRadiusYds + EPSILON; dx += sampleStepYds) {
      const normalized =
        (dx * dx) / (lateralRadiusYds * lateralRadiusYds) +
        (dy * dy) / (longitudinalRadiusYds * longitudinalRadiusYds)
      if (normalized > 1 + EPSILON) continue

      const classification = classifyPoint(hole, [center[0] + dx, center[1] + dy]).kind
      counts.set(classification, (counts.get(classification) ?? 0) + 1)
      sampleCount += 1
    }
  }

  const surfaceCoverage: Partial<Record<CourseSurfaceClassification, number>> = {}
  let preferredCoverage = 0
  let troubleCoverage = 0
  let penaltyCoverage = 0

  for (const [kind, count] of counts.entries()) {
    const fraction = sampleCount > 0 ? count / sampleCount : 0
    surfaceCoverage[kind] = fraction
    const semantics = TACTICAL_SURFACE_SEMANTICS[kind]
    if (semantics.preferred) preferredCoverage += fraction
    if (semantics.countsAsTrouble) troubleCoverage += fraction
    if (semantics.countsAsPenalty) penaltyCoverage += fraction
  }

  return {
    center,
    lateralRadiusYds,
    longitudinalRadiusYds,
    sampleCount,
    surfaceCoverage,
    preferredCoverage,
    troubleCoverage,
    penaltyCoverage,
    unknownCoverage: surfaceCoverage.unknown ?? 0,
  }
}

export function validateCourseGeometry(hole: CourseHoleGeometry): CourseGeometryValidation {
  const issues: string[] = []
  let polygonCount = 0

  if (!isFinitePoint(hole.markers.tee)) issues.push('Tee marker is not finite.')
  if (hole.markers.pin && !isFinitePoint(hole.markers.pin)) issues.push('Pin marker is not finite.')

  for (const surface of hole.surfaces) {
    if (surface.polygons.length === 0 && hole.availability[surface.kind] === 'available') {
      issues.push(`${surface.id} is marked available but contains no polygons.`)
    }

    for (const polygon of surface.polygons) {
      polygonCount += 1
      if (polygon.length < 3) issues.push(`${surface.id} contains a polygon with fewer than 3 points.`)
      if (polygon.some((point) => !isFinitePoint(point))) {
        issues.push(`${surface.id} contains a non-finite coordinate.`)
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    surfaceCount: hole.surfaces.length,
    polygonCount,
  }
}
