import type {
  CourseContourLine,
  CourseHoleGeometry,
  CoursePointYds,
} from './types'

export type TerrainEstimate = {
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

/**
 * Estimate local elevation from the LiDAR-derived contour lines supplied by a
 * CourseHoleGeometry package. The sampler is deliberately hole-agnostic: once a
 * hole has real contours, Live Caddie receives elevation without any new UI or
 * aim-model wiring.
 *
 * This remains a contour proxy rather than raw DEM sampling. Direct DEM sampling
 * can replace this implementation later while preserving the TerrainEstimate
 * contract used by the caddie model.
 */
export const estimateGreywolfTerrain = (
  hole: CourseHoleGeometry,
  point: CoursePointYds,
): TerrainEstimate | null => {
  const contours = hole.contours ?? []
  if (contours.length === 0) return null

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
