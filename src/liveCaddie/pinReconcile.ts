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

export const reconcilePinWithHud = ({
  snapshotPin, ball, hudYds, hudPin, toleranceYds = PIN_HUD_TOLERANCE_YDS,
}: Readonly<{
  snapshotPin: CoursePointYds | null
  ball: CoursePointYds | null
  hudYds: number | null
  hudPin: CoursePointYds | null
  toleranceYds?: number
}>): PinReconcileResult => {
  if (!ball || hudYds == null || !Number.isFinite(hudYds) || hudYds <= 0) {
    return { pin: snapshotPin, overridden: false, note: null }
  }
  const snapshotOff = snapshotPin ? dist(ball, snapshotPin) - hudYds : null
  if (snapshotPin && snapshotOff != null && Math.abs(snapshotOff) <= toleranceYds) {
    return { pin: snapshotPin, overridden: false, note: null }
  }
  const hudPinOk = hudPin && Math.abs(dist(ball, hudPin) - hudYds) <= toleranceYds + 3
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
