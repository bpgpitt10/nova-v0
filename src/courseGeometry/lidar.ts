import { greywolfHole01Geometry } from './greywolfHole01'
import type {
  CourseContourLine,
  CourseHoleGeometry,
  CoursePointYds,
  CourseTerrainGrid,
} from './types'

export type TerrainEstimate =
  | {
      elevationFt: number
      source: 'lidar-dem'
      confidence: 'high'
      gridSpacingYds: number
      note: string
    }
  | {
      elevationFt: number
      source: 'lidar-contour-proxy'
      confidence: 'medium'
      nearestContourDistanceYds: number
      note: string
    }

const pointSegmentDistance = (
  point: CoursePointYds,
  a: CoursePointYds,
  b: CoursePointYds,
) => {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const wx = point[0] - a[0]
  const wy = point[1] - a[1]
  const lengthSquared = vx * vx + vy * vy
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSquared)) : 0
  const dx = point[0] - (a[0] + t * vx)
  const dy = point[1] - (a[1] + t * vy)
  return Math.hypot(dx, dy)
}

const distanceToContour = (point: CoursePointYds, contour: CourseContourLine) => {
  let best = Number.POSITIVE_INFINITY
  for (let index = 1; index < contour.points.length; index += 1) {
    best = Math.min(
      best,
      pointSegmentDistance(point, contour.points[index - 1], contour.points[index]),
    )
  }
  return best
}

const encodedElevation = (
  terrain: CourseTerrainGrid,
  row: number,
  column: number,
): number | null => {
  const encoded = terrain.values[row * terrain.width + column]
  if (encoded == null || encoded === terrain.nodata) return null
  return terrain.elevationOffsetFt + encoded / 10
}

const estimateFromGrid = (
  terrain: CourseTerrainGrid,
  point: CoursePointYds,
): TerrainEstimate | null => {
  if (
    terrain.width < 2 ||
    terrain.height < 2 ||
    terrain.runtimeSpacingYds <= 0 ||
    terrain.values.length !== terrain.width * terrain.height
  ) {
    return null
  }

  const gridX = (point[0] - terrain.minX) / terrain.runtimeSpacingYds
  const gridY = (point[1] - terrain.minY) / terrain.runtimeSpacingYds
  if (
    gridX < 0 ||
    gridY < 0 ||
    gridX > terrain.width - 1 ||
    gridY > terrain.height - 1
  ) {
    return null
  }

  const column0 = Math.min(Math.floor(gridX), terrain.width - 2)
  const row0 = Math.min(Math.floor(gridY), terrain.height - 2)
  const dx = gridX - column0
  const dy = gridY - row0

  const z00 = encodedElevation(terrain, row0, column0)
  const z10 = encodedElevation(terrain, row0, column0 + 1)
  const z01 = encodedElevation(terrain, row0 + 1, column0)
  const z11 = encodedElevation(terrain, row0 + 1, column0 + 1)
  if (z00 == null || z10 == null || z01 == null || z11 == null) return null

  const top = z00 * (1 - dx) + z10 * dx
  const bottom = z01 * (1 - dx) + z11 * dx
  return {
    elevationFt: top * (1 - dy) + bottom * dy,
    source: 'lidar-dem',
    confidence: 'high',
    gridSpacingYds: terrain.runtimeSpacingYds,
    note: `Bilinear sample from browser terrain grid derived from the ${terrain.sourceResolutionMeters} m BC bare-earth LiDAR DEM.`,
  }
}

const estimateFromContours = (
  contours: readonly CourseContourLine[],
  point: CoursePointYds,
): TerrainEstimate | null => {
  const nearest = contours
    .map((contour) => ({ contour, distance: distanceToContour(point, contour) }))
    .filter((item) => Number.isFinite(item.distance))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)

  if (nearest.length === 0) return null

  const first = nearest[0]
  if (first.distance <= 0.25) {
    return {
      elevationFt: first.contour.elevationFt,
      source: 'lidar-contour-proxy',
      confidence: 'medium',
      nearestContourDistanceYds: first.distance,
      note: 'Point lies effectively on a LiDAR-derived contour.',
    }
  }

  let weightedElevation = 0
  let totalWeight = 0
  nearest.forEach(({ contour, distance }) => {
    const weight = 1 / Math.max(distance * distance, 0.25)
    weightedElevation += contour.elevationFt * weight
    totalWeight += weight
  })

  return {
    elevationFt: weightedElevation / totalWeight,
    source: 'lidar-contour-proxy',
    confidence: 'medium',
    nearestContourDistanceYds: first.distance,
    note: 'Inverse-distance estimate from LiDAR-derived contours used because a direct DEM grid sample was unavailable.',
  }
}

/**
 * Greywolf terrain sampler used by the live caddie. Direct DEM-derived runtime
 * terrain is authoritative. Contours remain a fail-soft fallback and a visual
 * layer; they are no longer the preferred elevation source.
 */
export const estimateGreywolfTerrain = (
  hole: CourseHoleGeometry,
  point: CoursePointYds,
): TerrainEstimate | null => {
  if (hole.terrain) {
    const direct = estimateFromGrid(hole.terrain, point)
    if (direct) return direct
  }
  return estimateFromContours(hole.contours ?? [], point)
}

/**
 * Temporary compatibility wrapper for older Hole 1 proof call sites. New code
 * should call estimateGreywolfTerrain(hole, point) against the loaded geometry.
 */
export const estimateGreywolfHole01Terrain = (
  point: CoursePointYds,
): TerrainEstimate | null => estimateGreywolfTerrain(greywolfHole01Geometry, point)
