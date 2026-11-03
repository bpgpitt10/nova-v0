import type { CoursePointYds } from '../courseGeometry/types'

/** A few yards past the pin still sits on GSPro's minimap. */
const PAST_PIN_YDS = 5

/**
 * The aim point Looper shows (yellow) and clicks in GSPro: on the chosen aim
 * line, at the depth where the ball is expected to come down (carry). The
 * recommendation's own aim point sits at the target's depth (the pin, or a
 * 220-yd lay-up spot), which is the same line but a meaningless distance.
 * GSPro takes only the direction, so this changes what is drawn and where the
 * click lands on the minimap, not the shot. Never more than a few yards past
 * the pin, so the click stays on GSPro's minimap.
 */
export const aimClickPoint = (
  ball: CoursePointYds,
  aimPoint: CoursePointYds,
  carryLanding: CoursePointYds | null | undefined,
  pin: CoursePointYds | null | undefined,
): CoursePointYds => {
  const dx = aimPoint[0] - ball[0]
  const dy = aimPoint[1] - ball[1]
  const length = Math.hypot(dx, dy)
  if (!carryLanding || !(length > 0)) return aimPoint
  const ux = dx / length
  const uy = dy / length
  const along = (carryLanding[0] - ball[0]) * ux + (carryLanding[1] - ball[1]) * uy
  if (!Number.isFinite(along) || along <= 1) return aimPoint
  const pinDistance = pin ? Math.hypot(pin[0] - ball[0], pin[1] - ball[1]) : null
  const depth = pinDistance != null && Number.isFinite(pinDistance)
    ? Math.min(along, pinDistance + PAST_PIN_YDS)
    : along
  return [ball[0] + ux * depth, ball[1] + uy * depth]
}
