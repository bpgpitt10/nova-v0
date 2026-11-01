import type { SurfaceClassificationResult } from '../courseGeometry/geometry'
import { classifyTacticalLandingPoint } from '../courseGeometry/tacticalClassification'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurfaceKind,
} from '../courseGeometry/types'

/**
 * Where a modeled shot actually finishes, hazard-wise.
 *
 * The samplers build a touchdown (carry) point and then a rest point by adding
 * the player's stock rollout. Classifying only the rest point lets a ball that
 * carries INTO water "roll out" onto the bank, and a ball that lands in a
 * bunker roll back out of it. Neither happens in GSPro.
 *
 *   1. Touchdown in water / penalty / bunker → the ball finishes there.
 *   2. Otherwise, walk the rollout from touchdown to rest. If it enters a
 *      water / penalty / bunker polygon, the ball stops just inside that edge.
 *   3. Otherwise, the rest point is classified as before (incl. woods context).
 *
 * Rollout length and direction are unchanged here; only hazard capture is added.
 */

export type CarryAwareLandingRule = 'rest' | 'carry-in-hazard' | 'rolled-into-hazard'

export type CarryAwareLanding = {
  landing: CoursePointYds
  classification: SurfaceClassificationResult
  rule: CarryAwareLandingRule
}

type CaptureKind = Extract<CourseSurfaceKind, 'water' | 'penalty' | 'bunker'>

const CAPTURE_KINDS: readonly CaptureKind[] = ['water', 'penalty', 'bunker']
const isCaptureKind = (kind: string): kind is CaptureKind =>
  (CAPTURE_KINDS as readonly string[]).includes(kind)

/** How far past the entry edge a rolled-in ball is placed (it rolls in, it doesn't balance on the lip). */
const ENTRY_INSET_YDS = 0.75
const MIN_ROLLOUT_YDS = 0.05

type IndexedHazard = {
  kind: CaptureKind
  polygon: CoursePolygonYds
  minX: number
  maxX: number
  minY: number
  maxY: number
}

const hazardIndexCache = new WeakMap<CourseHoleGeometry, IndexedHazard[]>()

const hazardIndex = (hole: CourseHoleGeometry): IndexedHazard[] => {
  const cached = hazardIndexCache.get(hole)
  if (cached) return cached
  const index: IndexedHazard[] = []
  for (const surface of hole.surfaces) {
    if (!isCaptureKind(surface.kind)) continue
    for (const polygon of surface.polygons) {
      if (polygon.length < 3) continue
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const [x, y] of polygon) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      index.push({ kind: surface.kind, polygon, minX, maxX, minY, maxY })
    }
  }
  hazardIndexCache.set(hole, index)
  return index
}

/**
 * Smallest parameter t ∈ (0, 1] at which segment a→b crosses an edge of any
 * capture polygon. The start point is known to be outside every capture
 * polygon, so the first crossing is an entry.
 */
const firstHazardEntryT = (
  hole: CourseHoleGeometry,
  a: CoursePointYds,
  b: CoursePointYds,
): number | null => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const segMinX = Math.min(a[0], b[0])
  const segMaxX = Math.max(a[0], b[0])
  const segMinY = Math.min(a[1], b[1])
  const segMaxY = Math.max(a[1], b[1])
  let best: number | null = null

  for (const hazard of hazardIndex(hole)) {
    if (hazard.maxX < segMinX || hazard.minX > segMaxX || hazard.maxY < segMinY || hazard.minY > segMaxY) continue
    const { polygon } = hazard
    for (let index = 0; index < polygon.length; index += 1) {
      const p = polygon[index]
      const q = polygon[(index + 1) % polygon.length]
      const ex = q[0] - p[0]
      const ey = q[1] - p[1]
      const denominator = dx * ey - dy * ex
      if (Math.abs(denominator) < 1e-12) continue
      const wx = p[0] - a[0]
      const wy = p[1] - a[1]
      const t = (wx * ey - wy * ex) / denominator
      const u = (wx * dy - wy * dx) / denominator
      if (t <= 1e-9 || t > 1 || u < 0 || u > 1) continue
      if (best === null || t < best) best = t
    }
  }
  return best
}

/** How far outside the entry edge the relief point sits. */
const RELIEF_BACKOFF_YDS = 1

/**
 * Where a ball that finished in water / a penalty area takes relief: the point
 * where it LAST crossed into the hazard along its line from the ball, backed
 * off a yard. Valuing the next shot from the splash point instead made a pond
 * in front of a green look cheap (the splash is nearly on the green).
 * Returns null when no crossing is found (e.g. the ball started inside).
 */
export const penaltyReliefPoint = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  landing: CoursePointYds,
): CoursePointYds | null => {
  const dx = landing[0] - ball[0]
  const dy = landing[1] - ball[1]
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return null
  const segMinX = Math.min(ball[0], landing[0])
  const segMaxX = Math.max(ball[0], landing[0])
  const segMinY = Math.min(ball[1], landing[1])
  const segMaxY = Math.max(ball[1], landing[1])
  let last: number | null = null
  for (const hazard of hazardIndex(hole)) {
    if (hazard.kind === 'bunker') continue
    if (hazard.maxX < segMinX || hazard.minX > segMaxX || hazard.maxY < segMinY || hazard.minY > segMaxY) continue
    const { polygon } = hazard
    for (let index = 0; index < polygon.length; index += 1) {
      const p = polygon[index]
      const q = polygon[(index + 1) % polygon.length]
      const ex = q[0] - p[0]
      const ey = q[1] - p[1]
      const denominator = dx * ey - dy * ex
      if (Math.abs(denominator) < 1e-12) continue
      const wx = p[0] - ball[0]
      const wy = p[1] - ball[1]
      const t = (wx * ey - wy * ex) / denominator
      const u = (wx * dy - wy * dx) / denominator
      if (t <= 0 || t >= 1 || u < 0 || u > 1) continue
      if (last === null || t > last) last = t
    }
  }
  if (last === null) return null
  const t = Math.max(0, last - RELIEF_BACKOFF_YDS / length)
  return [ball[0] + dx * t, ball[1] + dy * t]
}

export const resolveCarryAwareLanding = (
  hole: CourseHoleGeometry,
  carryLanding: CoursePointYds,
  restLanding: CoursePointYds,
): CarryAwareLanding => {
  const atTouchdown = classifyTacticalLandingPoint(hole, carryLanding)
  if (isCaptureKind(atTouchdown.kind)) {
    return { landing: carryLanding, classification: atTouchdown, rule: 'carry-in-hazard' }
  }

  const rolloutYds = Math.hypot(restLanding[0] - carryLanding[0], restLanding[1] - carryLanding[1])
  if (rolloutYds > MIN_ROLLOUT_YDS) {
    const entryT = firstHazardEntryT(hole, carryLanding, restLanding)
    if (entryT !== null) {
      const t = Math.min(1, entryT + ENTRY_INSET_YDS / rolloutYds)
      const stop: CoursePointYds = [
        carryLanding[0] + (restLanding[0] - carryLanding[0]) * t,
        carryLanding[1] + (restLanding[1] - carryLanding[1]) * t,
      ]
      const atStop = classifyTacticalLandingPoint(hole, stop)
      if (isCaptureKind(atStop.kind)) {
        return { landing: stop, classification: atStop, rule: 'rolled-into-hazard' }
      }
      // A sliver crossing (entered and left within the inset) falls through to the rest point.
    }
  }

  return {
    landing: restLanding,
    classification: classifyTacticalLandingPoint(hole, restLanding),
    rule: 'rest',
  }
}
