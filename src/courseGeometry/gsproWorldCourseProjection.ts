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
