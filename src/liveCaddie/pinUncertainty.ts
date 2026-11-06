import type { CourseHoleGeometry, CoursePointYds } from '../courseGeometry/types'

/**
 * How much an *estimated* pin can move an Auto Aim click.
 *
 * Auto Aim builds the minimap's scale and rotation from two anchors, the ball
 * and the pin, then places the target against them. A wrong pin is a wrong
 * ruler, and the error at the click grows with how far the target is along
 * that ruler: on a 150-yd par 3 a pin 10 yd off puts the click 10 yd off
 * (Kiawah 3, 11/4: 178 for 188); off a 400-yd par-4 tee the same pin error
 * turns the frame 1.4° and moves a 250-yd click about 6 yd, less than one aim
 * step plus a driver's dispersion. So the question before the first shot is
 * not "is the pin exact?" but "can the pin's uncertainty move this click
 * enough to matter?" (Brian, 11/6.)
 */

export type PinUncertainty = Readonly<{
  /** Across the ball→pin line: where on the green the pin might be. */
  acrossYds: number
  /** Along the line: GSPro's distance is exact, the read of it is not quite. */
  alongYds: number
  source: 'pin-slots' | 'green' | 'default'
}>

const ALONG_YDS = 2
const GREEN_MIN_YDS = 6
const GREEN_MAX_YDS = 25
const DEFAULT_ACROSS_YDS = 15

const unit = (from: CoursePointYds, to: CoursePointYds): CoursePointYds | null => {
  const d = Math.hypot(to[0] - from[0], to[1] - from[1])
  return d > 1e-6 ? [(to[0] - from[0]) / d, (to[1] - from[1]) / d] : null
}

/**
 * The uncertainty of an estimated pin. With the course file's pin slots in
 * hand the pin is one of them, so the spread of the slots around the estimate
 * bounds it; otherwise the green's width across the line does.
 */
export const estimatedPinUncertainty = ({ hole, ball, pin, pinSlotsLocal, distanceKnown = true }: Readonly<{
  hole: Pick<CourseHoleGeometry, 'surfaces'> | null
  ball: CoursePointYds
  pin: CoursePointYds
  pinSlotsLocal?: readonly CoursePointYds[] | null
  /** False when GSPro's distance wasn't read and the pin is only the map's cached pin. */
  distanceKnown?: boolean
}>): PinUncertainty => {
  const forward = unit(ball, pin)
  if (!forward) return { acrossYds: DEFAULT_ACROSS_YDS, alongYds: DEFAULT_ACROSS_YDS, source: 'default' }
  const right: CoursePointYds = [forward[1], -forward[0]]
  const across = (p: CoursePointYds) => Math.abs((p[0] - pin[0]) * right[0] + (p[1] - pin[1]) * right[1])
  const along = (p: CoursePointYds) => Math.abs((p[0] - pin[0]) * forward[0] + (p[1] - pin[1]) * forward[1])
  if (pinSlotsLocal && pinSlotsLocal.length >= 2) {
    const spread = Math.max(...pinSlotsLocal.map(across))
    const depth = Math.max(...pinSlotsLocal.map(along))
    return { acrossYds: Math.max(1, spread), alongYds: distanceKnown ? ALONG_YDS : Math.max(ALONG_YDS, depth), source: 'pin-slots' }
  }
  const green = hole?.surfaces.find((surface) => surface.kind === 'green')
  if (green) {
    let maxAcross = 0
    let maxAlong = 0
    for (const ring of green.polygons) {
      for (const p of ring) {
        maxAcross = Math.max(maxAcross, across(p))
        maxAlong = Math.max(maxAlong, along(p))
      }
    }
    if (maxAcross > 0) {
      const clamp = (v: number) => Math.min(GREEN_MAX_YDS, Math.max(GREEN_MIN_YDS, v))
      return { acrossYds: clamp(maxAcross), alongYds: distanceKnown ? ALONG_YDS : clamp(maxAlong), source: 'green' }
    }
  }
  return { acrossYds: DEFAULT_ACROSS_YDS, alongYds: distanceKnown ? ALONG_YDS : DEFAULT_ACROSS_YDS, source: 'default' }
}

/**
 * How far the click could land from where Looper meant, given the pin's
 * uncertainty: the across part turns the frame, the along part scales it, and
 * both act in proportion to target distance over pin distance.
 */
export const aimClickErrorYds = ({ ball, pin, target, uncertainty }: Readonly<{
  ball: CoursePointYds
  pin: CoursePointYds
  target: CoursePointYds
  uncertainty: PinUncertainty
}>): number => {
  const pinDistance = Math.hypot(pin[0] - ball[0], pin[1] - ball[1])
  const targetDistance = Math.hypot(target[0] - ball[0], target[1] - ball[1])
  if (pinDistance < 1) return Number.POSITIVE_INFINITY
  const ratio = targetDistance / pinDistance
  return Math.hypot(ratio * uncertainty.acrossYds, ratio * uncertainty.alongYds)
}

export const AIM_ERROR_FLOOR_YDS = 4
export const AIM_ERROR_SIGMA_FRACTION = 0.5

/** Auto Aim may click with an estimated pin when its possible error is small against the club's dispersion. */
export const aimErrorToleranceYds = (lateralSigmaYds: number | null | undefined): number =>
  Math.max(AIM_ERROR_FLOOR_YDS, (Number.isFinite(lateralSigmaYds ?? NaN) ? (lateralSigmaYds as number) : 0) * AIM_ERROR_SIGMA_FRACTION)

export type EstimatedPinAim = Readonly<{
  errorYds: number
  toleranceYds: number
  allowed: boolean
  uncertainty: PinUncertainty
}>

export const estimatedPinAim = ({ hole, ball, pin, target, pinSlotsLocal, distanceKnown = true, lateralSigmaYds }: Readonly<{
  hole: Pick<CourseHoleGeometry, 'surfaces'> | null
  ball: CoursePointYds
  pin: CoursePointYds
  target: CoursePointYds
  pinSlotsLocal?: readonly CoursePointYds[] | null
  distanceKnown?: boolean
  lateralSigmaYds: number | null | undefined
}>): EstimatedPinAim => {
  const uncertainty = estimatedPinUncertainty({ hole, ball, pin, pinSlotsLocal, distanceKnown })
  const errorYds = aimClickErrorYds({ ball, pin, target, uncertainty })
  const toleranceYds = aimErrorToleranceYds(lateralSigmaYds)
  return { errorYds, toleranceYds, allowed: errorYds <= toleranceYds, uncertainty }
}
