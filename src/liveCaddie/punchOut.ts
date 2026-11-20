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
