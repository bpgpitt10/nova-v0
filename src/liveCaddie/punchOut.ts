import { classifyPoint } from '../courseGeometry/geometry'
import { woodsNear } from '../courseGeometry/tacticalClassification'
import type { CourseHoleGeometry, CoursePointYds } from '../courseGeometry/types'
import { flightBlockedAt } from './aimOutcomeSampling'

/**
 * Punch-out mode (Brian, 20 Nov). From inside the trees Looper can't see the
 * gaps well enough to pick one, and Auto Aim would click a line through the
 * branches. So: say so, leave the aim to the player, and point them back to
 * safety.
 *
 * In the trees means off the short grass and either
 * - under mapped canopy (LiDAR trees or mapped woods), or
 * - boxed in: every line within PUNCH_FAN_DEG of the target meets trees in the
 *   first 36 yd (the launch check every recommendation already uses).
 */
const PUNCH_FAN_DEG = 40
const PUNCH_FAN_STEP_DEG = 5
const PROBE_YDS = 150

export const PUNCH_OUT_TITLE = 'Punch out.'
export const PUNCH_OUT_LINE = "You're in the trees: get it back to the fairway, don't be a hero."
/** A punch stays under the branches: low club, short swing, and no further than this (Brian, 21 Nov). */
export const PUNCH_OUT_MAX_YDS = 150
/** Low-launching clubs for a punch, best first. */
const PUNCH_CLUBS = ['5i', '4i', '6i', '3H', '4H', '7i', '5H', '3i'] as const

/** The club to punch with from this bag: a low iron, never a wedge or a wood. */
export const punchOutClub = (bag: readonly string[]): string | null =>
  PUNCH_CLUBS.find((club) => bag.includes(club)) ?? null

export type PunchOutEscape = Readonly<{
  /** Yards to the nearest fairway. */
  yds: number
  /** Where it is, facing the pin. */
  side: 'left' | 'right' | 'ahead' | 'behind' | 'ahead-left' | 'ahead-right'
  point: CoursePointYds
}>

/** The nearest fairway to the ball and where it lies, facing the pin. Null when the hole has no fairway mapped. */
export const nearestFairway = (
  hole: CourseHoleGeometry | null,
  ball: CoursePointYds | null,
  pin: CoursePointYds | null,
): PunchOutEscape | null => {
  if (!hole || !ball) return null
  let best: { d: number; point: CoursePointYds } | null = null
  for (const surface of hole.surfaces) {
    if (surface.kind !== 'fairway') continue
    for (const ring of surface.polygons) {
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        const abx = b[0] - a[0]
        const aby = b[1] - a[1]
        const len2 = abx * abx + aby * aby
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((ball[0] - a[0]) * abx + (ball[1] - a[1]) * aby) / len2)) : 0
        const point: CoursePointYds = [a[0] + abx * t, a[1] + aby * t]
        const d = Math.hypot(point[0] - ball[0], point[1] - ball[1])
        if (!best || d < best.d) best = { d, point }
      }
    }
  }
  if (!best) return null
  let side: PunchOutEscape['side'] = 'ahead'
  if (pin && best.d > 0.5) {
    const fx = pin[0] - ball[0]
    const fy = pin[1] - ball[1]
    const tx = best.point[0] - ball[0]
    const ty = best.point[1] - ball[1]
    // Facing the pin, right is (fy, -fx).
    const angle = (Math.atan2(tx * fy - ty * fx, tx * fx + ty * fy) * 180) / Math.PI   // + right
    const lr = angle > 0 ? 'right' : 'left'
    side = Math.abs(angle) < 20 ? 'ahead' : Math.abs(angle) < 65 ? `ahead-${lr}` : Math.abs(angle) <= 125 ? lr : 'behind'
  }
  return { yds: best.d, side, point: best.point }
}

export const PUNCH_OUT_AIM_NOTE = "Aim by hand: you're in the trees, so pick the safest gap back to the fairway yourself."

export const ballInTrees = (
  hole: CourseHoleGeometry | null,
  ball: CoursePointYds | null,
  target: CoursePointYds | null,
): boolean => {
  if (!hole || !ball) return false
  const surface = classifyPoint(hole, ball).kind
  if (surface === 'fairway' || surface === 'green' || surface === 'tee') return false
  if (woodsNear(hole, ball)) return true
  if (!target) return false
  const base = Math.atan2(target[0] - ball[0], target[1] - ball[1])
  for (let deg = -PUNCH_FAN_DEG; deg <= PUNCH_FAN_DEG; deg += PUNCH_FAN_STEP_DEG) {
    const angle = base + (deg * Math.PI) / 180
    const end: CoursePointYds = [ball[0] + Math.sin(angle) * PROBE_YDS, ball[1] + Math.cos(angle) * PROBE_YDS]
    if (flightBlockedAt(hole, ball, end, null, null)?.tag !== 'trees-early') return false
  }
  return true
}
