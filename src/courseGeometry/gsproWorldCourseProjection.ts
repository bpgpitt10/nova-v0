import type { CoursePointYds } from './types'

export type GsproWorldXZ = Readonly<{ x: number; z: number }>
const METERS_TO_YARDS = 1.0936132983377078
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Shared GSPro world displacement -> OSM hole-local right/forward yards.
 *
 * GSPro x/z are meters. The COURSE heading is independent package evidence
 * derived from georeferenced OSM tee→green, not a GSPro yardage/waypoint OCR.
 * A rotation bias is a separately supported per-course calibration; default
 * 0° is provisional pending physical validation, never global certification.
 * A single starting point is insufficient for absolute georegistration.
 */
export const gsproWorldDeltaToHoleLocal = (
  from: GsproWorldXZ,
  to: GsproWorldXZ,
  headingDegreesTrue: number,
  worldRotationDeg = 0,
): CoursePointYds | null => {
  if (![from?.x, from?.z, to?.x, to?.z, headingDegreesTrue, worldRotationDeg].every(finite)
    || Math.abs(worldRotationDeg) > 20) return null
  const dx = (to.x - from.x) * METERS_TO_YARDS
  const dz = (to.z - from.z) * METERS_TO_YARDS
  const correction = worldRotationDeg * Math.PI / 180
  const east = Math.cos(correction) * dx - Math.sin(correction) * dz
  const north = Math.sin(correction) * dx + Math.cos(correction) * dz
  const hole = headingDegreesTrue * Math.PI / 180
  const right = east * Math.cos(hole) - north * Math.sin(hole)
  const forward = east * Math.sin(hole) + north * Math.cos(hole)
  return Number.isFinite(right) && Number.isFinite(forward)
    ? [right, forward] : null
}

export const projectGsproWorldPointToHole = (
  observedTeeLocalYds: CoursePointYds,
  teeWorld: GsproWorldXZ,
  currentWorld: GsproWorldXZ,
  headingDegreesTrue: number,
  worldRotationDeg = 0,
): CoursePointYds | null => {
  if (!Array.isArray(observedTeeLocalYds)
    || observedTeeLocalYds.length !== 2
    || !observedTeeLocalYds.every(finite)) return null
  const delta = gsproWorldDeltaToHoleLocal(teeWorld, currentWorld, headingDegreesTrue, worldRotationDeg)
  return delta ? [observedTeeLocalYds[0] + delta[0], observedTeeLocalYds[1] + delta[1]] : null
}

/**
 * An independent guard on provisional map registration: GSPro's remaining
 * straight distance is a different measurement from the world shot delta.
 * The imported green CENTROID is not today's exact flag, so allow substantial
 * pin/tee-source discrepancy. A grossly incorrect handedness or hole frame
 * must never drive a precise recommendation.
 */
export const provisionalWorldPositionMatchesPinDistance = (
  ball: CoursePointYds | null,
  greenCentroid: CoursePointYds | null,
  gsproRemainingStraightYds: number | null,
  toleranceYds = 55,
): boolean => {
  if (!ball || !greenCentroid || !ball.every(finite)
    || !greenCentroid.every(finite)
    || !finite(gsproRemainingStraightYds) || gsproRemainingStraightYds < 0
    || !finite(toleranceYds) || toleranceYds <= 0) return false
  return Math.abs(
    Math.hypot(greenCentroid[0] - ball[0], greenCentroid[1] - ball[1])
    - gsproRemainingStraightYds
  ) <= toleranceYds
}
