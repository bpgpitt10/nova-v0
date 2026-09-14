import { greywolfHole01RenderFixture } from '../dev/greywolfHole01RenderFixture'
import type { CoursePointYds } from './types'

export type TerrainEstimate = {
  elevationFt: number
  source: 'lidar-contour-proxy'
  confidence: 'medium'
  nearestContourDistanceYds: number
  note: string
}

type Contour = {
  elevationFt: number
  points: readonly (readonly [number, number])[]
}

const pointSegmentDistance = (
  point: CoursePointYds,
  a: readonly [number, number],
  b: readonly [number, number],
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

const distanceToContour = (point: CoursePointYds, contour: Contour) => {
  let best = Number.POSITIVE_INFINITY
  for (let index = 1; index < contour.points.length; index += 1) {
    best = Math.min(
      best,
      pointSegmentDistance(point, contour.points[index - 1], contour.points[index]),
    )
  }
  return best
}

/**
 * Review/prototype terrain sampler for Greywolf Hole 1.
 *
 * This intentionally does NOT pretend the rendered 10-ft contours are the raw DEM.
 * It estimates local elevation from the three nearest LiDAR-derived contour lines so
 * Aim Lab can prove candidate-specific terrain flow now. Runtime production should
 * replace this with direct DEM sampling while keeping the same TerrainEstimate contract.
 */
export const estimateGreywolfHole01Terrain = (
  point: CoursePointYds,
): TerrainEstimate | null => {
  const contours = greywolfHole01RenderFixture.layers.contours as readonly Contour[]
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
      note: 'Point lies effectively on a LiDAR-derived contour. Production target is direct DEM sampling.',
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
    note: 'Inverse-distance estimate from LiDAR-derived contours; review aid only until direct DEM sampling is wired.',
  }
}
