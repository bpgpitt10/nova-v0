import { GREYWOLF_COURSE_ID } from '../courseGeometry/courseCatalog'
import { getRouteHoleHeadingDegreesTrue } from '../courseGeometry/generatedRouteHoleHeadings'

type GreywolfAnchorArtifact = {
  anchors?: {
    selected_tee_latlon?: unknown
    target_green_latlon?: unknown
  }
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const latLonPair = (value: unknown): readonly [number, number] | null => {
  if (!Array.isArray(value) || value.length < 2) return null
  const lat = value[0]
  const lon = value[1]
  return finite(lat) && finite(lon) ? [lat, lon] : null
}

const normalizeDegrees = (value: number) => ((value % 360) + 360) % 360

const trueBearingDegrees = (
  from: readonly [number, number],
  to: readonly [number, number],
) => {
  const lat1 = from[0] * Math.PI / 180
  const lat2 = to[0] * Math.PI / 180
  const deltaLon = (to[1] - from[1]) * Math.PI / 180
  const east = Math.sin(deltaLon) * Math.cos(lat2)
  const north = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon)
  if (Math.hypot(east, north) <= Number.EPSILON) return null
  return normalizeDegrees(Math.atan2(east, north) * 180 / Math.PI)
}

const greywolfHeadingCache = new Map<number, Promise<number | null>>()

const loadGreywolfHeadingDegreesTrue = (holeNumber: number) => {
  const normalizedHole = Math.max(1, Math.min(18, Math.round(holeNumber)))
  const cached = greywolfHeadingCache.get(normalizedHole)
  if (cached) return cached

  const promise = fetch(
    `/course-geometry/greywolf/local-geometry/greywolf-hole-${String(normalizedHole).padStart(2, '0')}.json`,
    { cache: 'no-cache' },
  )
    .then(async (response) => {
      if (!response.ok) return null
      const payload = await response.json() as GreywolfAnchorArtifact
      const tee = latLonPair(payload.anchors?.selected_tee_latlon)
      const green = latLonPair(payload.anchors?.target_green_latlon)
      return tee && green ? trueBearingDegrees(tee, green) : null
    })
    .catch(() => null)

  greywolfHeadingCache.set(normalizedHole, promise)
  return promise
}

export const loadCourseHoleHeadingDegreesTrue = async (
  courseId: string,
  holeNumber: number,
): Promise<number | null> => {
  const packagedHeading = getRouteHoleHeadingDegreesTrue(courseId, holeNumber)
  if (packagedHeading != null) return packagedHeading
  if (courseId === GREYWOLF_COURSE_ID) return loadGreywolfHeadingDegreesTrue(holeNumber)
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
