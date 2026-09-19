import { getRouteHoleHeadingDegreesTrue } from './generatedRouteHoleHeadings'
import type { CoursePointYds } from './types'

const METERS_TO_YARDS = 1.0936132983377078
const WORLD_ROTATION_DEG = 0.5319220319046369

type GsproWorldPoint = { x: number; z: number }

const worldDeltaToEastNorthYards = (dx: number, dz: number) => {
  const radians = WORLD_ROTATION_DEG * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    east: METERS_TO_YARDS * (cos * dx - sin * dz),
    north: METERS_TO_YARDS * (sin * dx + cos * dz),
  }
}

/**
 * Convert GSPro world X/Z into the canonical selected-tee hole-local frame for
 * route-packaged courses. The global GSPro->east/north rotation is the same
 * transform proven against Greywolf; per-hole true headings are generated from
 * the cached OSM validation manifests at build time.
 */
export const gsproWorldPointToRouteCourseLocal = (
  courseId: string,
  holeNumber: number,
  point: GsproWorldPoint,
  teeWorld: GsproWorldPoint,
): CoursePointYds | null => {
  const headingDeg = getRouteHoleHeadingDegreesTrue(courseId, holeNumber)
  if (headingDeg == null) return null

  const delta = worldDeltaToEastNorthYards(point.x - teeWorld.x, point.z - teeWorld.z)
  const headingRad = headingDeg * Math.PI / 180
  const forwardEast = Math.sin(headingRad)
  const forwardNorth = Math.cos(headingRad)
  const rightEast = forwardNorth
  const rightNorth = -forwardEast

  return [
    delta.east * rightEast + delta.north * rightNorth,
    delta.east * forwardEast + delta.north * forwardNorth,
  ]
}
