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
 * The club's descent, for finding where the ball really comes down (piece 4).
 * `refElevationFt` is the ground elevation the carry model assumed at the
 * landing (ball elevation + the modeled landing delta): the ball is at that
 * height when it has flown its carry.
 */
export type DescentFlight = Readonly<{ ball: CoursePointYds; descentDeg: number; refElevationFt: number }>

/** How far back from the carry point the descent is checked against the ground. */
const DESCENT_WALK_YDS = 30
const DESCENT_STEP_YDS = 2
/** A touchdown on ground rising more steeply than this along the flight is "into the slope". */
const INTO_SLOPE_GRADE = 0.15
const INTO_SLOPE_ROLL = 0.1

export type Touchdown = Readonly<{ point: CoursePointYds; shortenedYds: number; intoSlope: boolean }>

/**
 * Where the descending ball meets the terrain (spec piece 4). Walking back
 * from the carry point toward the ball, the ball is at refElevation +
 * d·tan(descent) feet above sea level d yards before carry; the earliest
 * point in the flight (largest d, up to 30 yd) where the ground is at or
 * above it is the touchdown. A ball flying into the face of a hill comes
 * down short of its carry. Without terrain or a descent angle: the carry point.
 */
export const descentTouchdown = (
  hole: CourseHoleGeometry,
  carryLanding: CoursePointYds,
  flight: DescentFlight | null | undefined,
): Touchdown => {
  const none = { point: carryLanding, shortenedYds: 0, intoSlope: false }
  if (!flight || !(flight.descentDeg > 0) || !Number.isFinite(flight.refElevationFt)) return none
  if (!hole.terrain && !hole.contours?.length) return none
  const bx = flight.ball[0] - carryLanding[0]
  const by = flight.ball[1] - carryLanding[1]
  const length = Math.hypot(bx, by)
  if (length < 1) return none
  const back: CoursePointYds = [bx / length, by / length]
  const rise = Math.tan((flight.descentDeg * Math.PI) / 180) * 3 // ft of height per yd back
  let contact = -1
  const maxBack = Math.min(DESCENT_WALK_YDS, length - 1)
  for (let d = 0; d <= maxBack; d += DESCENT_STEP_YDS) {
    const t = terrainFt(hole, carryLanding[0] + back[0] * d, carryLanding[1] + back[1] * d)
    if (t == null) continue
    if (t >= flight.refElevationFt + d * rise) contact = d
  }
  if (contact < 0) return none
  // Refine within the last step: the ball crosses the ground between contact and contact + step.
  let d = contact
  for (let k = contact + 0.5; k < contact + DESCENT_STEP_YDS && k <= maxBack; k += 0.5) {
    const t = terrainFt(hole, carryLanding[0] + back[0] * k, carryLanding[1] + back[1] * k)
    if (t != null && t >= flight.refElevationFt + k * rise) d = k
  }
  const point: CoursePointYds = [carryLanding[0] + back[0] * d, carryLanding[1] + back[1] * d]
  const forward: CoursePointYds = [-back[0], -back[1]]
  const grade = gradeAlong(hole, point, forward)
  return { point, shortenedYds: d, intoSlope: grade != null && grade > INTO_SLOPE_GRADE }
}

/**
 * Wrap a landing transform (the green rollout): the ball first comes down
 * where its descent meets the terrain (when a flight is given), then its stock
 * roll is scaled by the surface and slope there.
 */
export const makeRollLandingTransform = (
  hole: CourseHoleGeometry,
  inner?: LandingTransform,
  flight?: DescentFlight | null,
): LandingTransform => (carryLanding, baselineLanding) => {
  const rx = baselineLanding[0] - carryLanding[0]
  const ry = baselineLanding[1] - carryLanding[1]
  const stockRoll = Math.hypot(rx, ry)
  const touchdown = descentTouchdown(hole, carryLanding, flight)
  const start = touchdown.point
  if (stockRoll < 1e-6) {
    const rest: CoursePointYds = [start[0], start[1]]
    return inner ? inner(start, rest) : rest
  }
  const dir: CoursePointYds = [rx / stockRoll, ry / stockRoll]
  const { surfaceFactor, slopeFactor } = rollFactorAt(hole, start, dir)
  const roll = stockRoll * surfaceFactor * (touchdown.intoSlope ? INTO_SLOPE_ROLL : slopeFactor)
  const scaled: CoursePointYds = [start[0] + dir[0] * roll, start[1] + dir[1] * roll]
  return inner ? inner(start, scaled) : scaled
}
