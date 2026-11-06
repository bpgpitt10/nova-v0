import { courseUsesGsproHoles, getRuntimeHoleHeadingDegreesTrue } from '../courseGeometry/courseCatalog'
import { getRouteHoleHeadingDegreesTrue } from '../courseGeometry/generatedRouteHoleHeadings'

const normalizeDegrees = (value: number) => ((value % 360) + 360) % 360

export const loadCourseHoleHeadingDegreesTrue = async (
  courseId: string,
  holeNumber: number,
): Promise<number | null> => {
  const packagedHeading = getRouteHoleHeadingDegreesTrue(courseId, holeNumber)
    ?? getRuntimeHoleHeadingDegreesTrue(courseId, holeNumber)
  if (packagedHeading != null) return packagedHeading
  // GSPro-only or map-area course: the headings come from GSPro's course file, which may
  // still be loading (hole 1 asked too early and got no wind, 11/4 Pinehurst 2).
  if (courseUsesGsproHoles(courseId)) {
    const { loadNativeCourseContext } = await import('../courseGeometry/nativeCourseRuntime')
    const { context } = await loadNativeCourseContext(courseId, null).catch(() => ({ context: null }))
    const heading = context?.registration.holes[String(Math.max(1, Math.min(18, Math.round(holeNumber))))]?.headingDegreesTrue
    return typeof heading === 'number' && Number.isFinite(heading) ? heading : null
  }
  return null
}

export const localShotBearingDegrees = (
  ball: readonly [number, number],
  target: readonly [number, number],
) => {
  const right = target[0] - ball[0]
  const forward = target[1] - ball[1]
  if (Math.hypot(right, forward) <= Number.EPSILON) return 0
  return normalizeDegrees(Math.atan2(right, forward) * 180 / Math.PI)
}

export const shotCompassBearingDegrees = (
  holeHeadingDegreesTrue: number | null,
  localBearingDegrees: number,
) => holeHeadingDegreesTrue == null
  ? null
  : normalizeDegrees(holeHeadingDegreesTrue + localBearingDegrees)
