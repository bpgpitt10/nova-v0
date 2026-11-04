import { estimateGreywolfTerrain as estimateCourseTerrain } from '../courseGeometry/lidar'
import { classifyTacticalLandingPoint } from '../courseGeometry/tacticalClassification'
import type { CourseHoleGeometry, CoursePointYds, CourseSurfaceClassification } from '../courseGeometry/types'
import type { LandingTransform } from './aimOutcomeSampling'

/**
 * Roll by where the ball lands (spec: claude/spec-long-shot-engine.md, piece 5).
 *
 * Until now every shot was credited with the player's full range rollout
 * (Driver ~18 yd) whatever it landed on: rough, the face of a hill, woods.
 * Now each sample's roll is the stock roll scaled by
 *   surface at the touchdown point (fairway/tee/green 1.0, rough 0.35,
 *   bunker and woods 0.1, water/penalty 0, unmapped 0.35), and
 *   slope along the roll direction, g (rise/run, + uphill):
 *   clamp(1 − 4g, 0.1, 1.6): a 10% upslope keeps 60%, 10% downhill adds 40%.
 * Roll direction stays the flight line (cross-slope deflection later).
 * Samples landing on the green keep the existing green transform.
 */

export const ROLL_SURFACE_FACTOR: Readonly<Record<CourseSurfaceClassification, number>> = {
  fairway: 1,
  tee: 1,
  green: 1,
  rough: 0.35,
  'deep-rough': 0.1,
  bunker: 0.1,
  water: 0,
  penalty: 0,
  unknown: 0.35,
}

const SLOPE_GAIN = 4
const SLOPE_MIN = 0.1
const SLOPE_MAX = 1.6
/** Half-length of the slope baseline along the roll direction. */
const SLOPE_HALF_YDS = 3

export const rollSlopeFactor = (grade: number) =>
  Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, 1 - SLOPE_GAIN * grade))

// Terrain lookups at 1-yd resolution, per hole (the sampler asks for the
// same neighbourhood thousands of times per recommendation).
const terrainCache = new WeakMap<CourseHoleGeometry, Map<number, number | null>>()

const terrainFt = (hole: CourseHoleGeometry, x: number, y: number): number | null => {
  let cache = terrainCache.get(hole)
  if (!cache) {
    cache = new Map()
    terrainCache.set(hole, cache)
  }
  const qx = Math.round(x), qy = Math.round(y)
  const key = (qx + 4096) * 8192 + (qy + 4096)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const value = estimateCourseTerrain(hole, [qx, qy])?.elevationFt ?? null
  cache.set(key, value)
  return value
}

/** Grade (rise over run, + uphill) along `dir` at `p`; null without terrain. */
export const gradeAlong = (hole: CourseHoleGeometry, p: CoursePointYds, dir: CoursePointYds): number | null => {
  if (!hole.terrain && !hole.contours?.length) return null
  const ahead = terrainFt(hole, p[0] + dir[0] * SLOPE_HALF_YDS, p[1] + dir[1] * SLOPE_HALF_YDS)
  const behind = terrainFt(hole, p[0] - dir[0] * SLOPE_HALF_YDS, p[1] - dir[1] * SLOPE_HALF_YDS)
  if (ahead == null || behind == null) return null
  return (ahead - behind) / (2 * SLOPE_HALF_YDS * 3)
}

export type RollBreakdown = Readonly<{ surface: CourseSurfaceClassification; surfaceFactor: number; grade: number | null; slopeFactor: number }>

// Touchdown surface at 1-yd resolution, per hole (same reason as the terrain cache).
const surfaceCache = new WeakMap<CourseHoleGeometry, Map<number, CourseSurfaceClassification>>()

const surfaceAt = (hole: CourseHoleGeometry, p: CoursePointYds): CourseSurfaceClassification => {
  let cache = surfaceCache.get(hole)
  if (!cache) {
    cache = new Map()
    surfaceCache.set(hole, cache)
  }
  const qx = Math.round(p[0]), qy = Math.round(p[1])
  const key = (qx + 4096) * 8192 + (qy + 4096)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const kind = classifyTacticalLandingPoint(hole, [qx, qy]).kind
  cache.set(key, kind)
  return kind
}

export const rollFactorAt = (hole: CourseHoleGeometry, carryLanding: CoursePointYds, dir: CoursePointYds): RollBreakdown => {
  const surface = surfaceAt(hole, carryLanding)
  const surfaceFactor = ROLL_SURFACE_FACTOR[surface] ?? 0.35
  const grade = surfaceFactor > 0 ? gradeAlong(hole, carryLanding, dir) : null
  const slopeFactor = grade == null ? 1 : rollSlopeFactor(grade)
  return { surface, surfaceFactor, grade, slopeFactor }
}

/**
 * Wrap a landing transform (the green rollout) so the stock roll is first
 * scaled by surface and slope at the touchdown point.
 */
export const makeRollLandingTransform = (
  hole: CourseHoleGeometry,
  inner?: LandingTransform,
): LandingTransform => (carryLanding, baselineLanding) => {
  const rx = baselineLanding[0] - carryLanding[0]
  const ry = baselineLanding[1] - carryLanding[1]
  const stockRoll = Math.hypot(rx, ry)
  if (stockRoll < 1e-6) return inner ? inner(carryLanding, baselineLanding) : baselineLanding
  const dir: CoursePointYds = [rx / stockRoll, ry / stockRoll]
  const { surfaceFactor, slopeFactor } = rollFactorAt(hole, carryLanding, dir)
  const roll = stockRoll * surfaceFactor * slopeFactor
  const scaled: CoursePointYds = [carryLanding[0] + dir[0] * roll, carryLanding[1] + dir[1] * roll]
  return inner ? inner(carryLanding, scaled) : scaled
}
