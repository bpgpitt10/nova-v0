import type { CoursePointYds } from '../courseGeometry/types'

/**
 * Before Shot 1, GSPro's player box ("Shot 1  145.2 YDS") is the truth about
 * the pin in play. Royal New Kent 3 (11/3): the box said 145 while Looper's
 * pin (a slot from the round layout / an earlier shot) sat ~15 yd deeper, so
 * the engine picked an 8i carrying 158. When the two disagree, GSPro wins.
 */
export const PIN_HUD_TOLERANCE_YDS = 5
const HUD_MISREAD_YDS = 40

export type PinReconcileResult = Readonly<{
  /** The pin the engine should use, or null to estimate from GSPro's distance. */
  pin: CoursePointYds | null
  overridden: boolean
  note: string | null
}>

const dist = (a: CoursePointYds, b: CoursePointYds) => Math.hypot(a[0] - b[0], a[1] - b[1])

/**
 * GSPro's tee distance follows the hole's aim route on doglegs (tee ->
 * AimPoint1 -> AimPoint2 -> pin, skipping aim points not ahead of the ball),
 * elsewhere the straight line. A pin's disagreement with GSPro is the smaller
 * of the two (RNK 4: route 371 yd, straight ~342: the straight line alone
 * called a correct pin 29 yd off).
 */
const routeYds = (ball: CoursePointYds, aimPoints: readonly CoursePointYds[], pin: CoursePointYds) => {
  const straight = dist(ball, pin)
  const ahead = aimPoints.filter((p) => dist(p, pin) < straight)
  const points = [ball, ...ahead, pin]
  let total = 0
  for (let i = 1; i < points.length; i += 1) total += dist(points[i - 1], points[i])
  return total
}

const offFromHud = (ball: CoursePointYds, pin: CoursePointYds, hudYds: number, aimPoints: readonly CoursePointYds[]) => {
  const straight = dist(ball, pin) - hudYds
  if (!aimPoints.length) return straight
  const route = routeYds(ball, aimPoints, pin) - hudYds
  return Math.abs(route) < Math.abs(straight) ? route : straight
}

export const reconcilePinWithHud = ({
  snapshotPin, ball, hudYds, hudPin, aimPoints = [], hudLookupDone = true, toleranceYds = PIN_HUD_TOLERANCE_YDS,
}: Readonly<{
  snapshotPin: CoursePointYds | null
  ball: CoursePointYds | null
  hudYds: number | null
  hudPin: CoursePointYds | null
  /** The hole's designer aim points, hole-local yards (from the course file). */
  aimPoints?: readonly CoursePointYds[]
  /** False while the course-file pin lookup for this reading is still running: keep Looper's pin until it's done. */
  hudLookupDone?: boolean
  toleranceYds?: number
}>): PinReconcileResult => {
  if (!ball || hudYds == null || !Number.isFinite(hudYds) || hudYds <= 0) {
    return { pin: snapshotPin, overridden: false, note: null }
  }
  const snapshotOff = snapshotPin ? offFromHud(ball, snapshotPin, hudYds, aimPoints) : null
  if (snapshotPin && snapshotOff != null && Math.abs(snapshotOff) <= toleranceYds) {
    return { pin: snapshotPin, overridden: false, note: null }
  }
  // Without the aim route yet, a dogleg looks like a wrong pin: wait for the lookup.
  if (snapshotPin && !hudLookupDone) {
    return { pin: snapshotPin, overridden: false, note: null }
  }
  const hudPinOk = hudPin && Math.abs(offFromHud(ball, hudPin, hudYds, aimPoints)) <= toleranceYds + 3
  const offText = snapshotOff != null
    ? `Looper's pin was ${Math.abs(snapshotOff).toFixed(0)} yd ${snapshotOff > 0 ? 'deeper' : 'shorter'} than GSPro's ${Math.round(hudYds)} yd`
    : null
  if (hudPin && hudPinOk) {
    return {
      pin: [hudPin[0], hudPin[1]],
      overridden: snapshotPin != null,
      note: offText ? `${offText}; using the course-file pin at GSPro's distance` : null,
    }
  }
  if (snapshotPin && snapshotOff != null && Math.abs(snapshotOff) > HUD_MISREAD_YDS) {
    // Off by more than a green's depth with no pin at GSPro's distance: more
    // likely a misread player box than a wrong pin.
    return { pin: snapshotPin, overridden: false, note: `${offText}; GSPro's distance looks misread, keeping Looper's pin` }
  }
  if (snapshotPin) {
    return {
      pin: null,
      overridden: true,
      note: `${offText}; no course-file pin matches GSPro, so the pin is estimated at GSPro's distance`,
    }
  }
  return { pin: null, overridden: false, note: null }
}
