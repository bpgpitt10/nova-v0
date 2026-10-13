/**
 * Research-only GSPro minimap marker triad -> imported OSM local geometry.
 *
 * Uses the EXISTING companion ball/pin/gray-waypoint observations and the
 * EXISTING imported course surfaces. Does not infer landmarks or reclassify
 * hazards. OSM route start != actual selected tee; OSM green centroid != pin.
 *
 * A 2-point axis is underconstrained: both mirror orientations are retained.
 * The waypoint is a GSPro default-aim point, NOT an independently measured
 * OSM landmark. Checking its OSM fairway proximity is a soft consistency
 * test, not a proof of physical tee/flag registration.
 */
import { nearestSurfaceDistance } from './geometry'
import type { CourseHoleGeometry, CoursePointYds } from './types'
import type { LooperCompanionLiveObservations } from '../adapters/looperCompanion'

type Vec = readonly [number, number]
type Projected = Readonly<{
  mapPoint: CoursePointYds
  fairwayDistanceYds: number | null
  handedness: 'screen-right-to-course-right' | 'mirrored'
}>
export type MarkerOnlyAlignment = Readonly<{
  status: 'blocked' | 'approximate-research-only'
  reason: string
  nativeMarkerStatus: string
  identityStatus: 'matching-pre-shot' | 'manual-hole-only' | 'unknown'
  yardsPerPixel: number | null
  waypointDistanceOcrYds: number | null
  waypointDistancePixelYds: number | null
  waypointRulerErrorPercent: number | null
  teeToGreenCentroidYds: number | null
  ballToGsproPinYds: number | null
  teePinLengthDifferenceYds: number | null
  waypointLateralFromTeePinYds: number | null
  alternatives: readonly Projected[]
  verifiedForPlay: false
  canPublishCourse: false
  authorizesNativeAim: false
}>
const finite = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x)
const len = (p: Vec) => Math.hypot(p[0], p[1])
const diff = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]]
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1]
const cross = (a: Vec, b: Vec) => a[0] * b[1] - a[1] * b[0]
const rnd = (n: number) => Math.round(n * 100) / 100
const failed = (reason: string, identityStatus: MarkerOnlyAlignment['identityStatus'] = 'unknown'): MarkerOnlyAlignment => ({
  status: 'blocked', reason, nativeMarkerStatus: 'unavailable', identityStatus,
  yardsPerPixel: null, waypointDistanceOcrYds: null, waypointDistancePixelYds: null,
  waypointRulerErrorPercent: null, teeToGreenCentroidYds: null,
  ballToGsproPinYds: null, teePinLengthDifferenceYds: null,
  waypointLateralFromTeePinYds: null, alternatives: [],
  verifiedForPlay: false, canPublishCourse: false, authorizesNativeAim: false,
})
const readPixel = (p: {x: number;y: number} | null | undefined): Vec | null =>
  p && finite(p.x) && finite(p.y) ? [p.x, p.y] : null
const validMap = (p: Vec | undefined): p is CoursePointYds =>
  !!p && p.length === 2 && p.every(finite)
const project = (
  tee: CoursePointYds,
  forwardUnit: Vec,
  nativeForwardUnit: Vec,
  waypointOffset: Vec,
  ypp: number,
  mirrored: boolean,
): CoursePointYds => {
  const forward = dot(waypointOffset, nativeForwardUnit) * ypp
  const lateral = cross(nativeForwardUnit, waypointOffset) * ypp * (mirrored ? -1 : 1)
  // Existing Looper local coordinate orientation: right X, forward Y.
  return [
    tee[0] + forward * forwardUnit[0] + lateral * forwardUnit[1],
    tee[1] + forward * forwardUnit[1] - lateral * forwardUnit[0],
  ]
}
export const evaluateMarkerOnlyCourseAlignment = (
  geometry: CourseHoleGeometry,
  native: LooperCompanionLiveObservations,
  opts: {
    selectedCourseKeyMatches: boolean
    visuallyConfirmedCourseAndHole: boolean
    nowMs?: number
  },
): MarkerOnlyAlignment => {
  if (!geometry || !native || native.status !== 'ready'
      || native.stateAuthority !== 'diagnostic-only'
      || native.capabilities?.autoAim !== false
      || native.gspro?.status !== 'connected'
      || native.gspro.window?.minimized !== false) {
    return failed('A valid, read-only, non-minimized GSPro companion frame is required.')
  }
  const observed = Date.parse(native.observedAt ?? '')
  const nowMs = opts.nowMs ?? Date.now()
  if (!finite(observed) || !finite(nowMs) || nowMs - observed > 60000 || observed - nowMs > 5000) {
    return failed('Native minimap observation is too old; refresh it.')
  }
  if (!opts.selectedCourseKeyMatches || !opts.visuallyConfirmedCourseAndHole) {
    return failed('Confirm the actual GSPro course and hole before comparing approximate maps.')
  }
  const shot = native.structured?.shot
  const identityStatus: MarkerOnlyAlignment['identityStatus'] =
    shot?.kind === 'pre_shot' && shot.status === 'ready'
      && shot.holeNumber === geometry.holeNumber && shot.shotNumber === 1
      ? 'matching-pre-shot' : 'manual-hole-only'
  const mini = native.minimap
  const ball = readPixel(mini?.ballPixel), pin = readPixel(mini?.pinPixel)
  if (mini?.status !== 'markers_found' || !ball || !pin) {
    return failed('Companion has not extracted both actual ball and pin pixels.', identityStatus)
  }
  const ypp = mini?.scale?.yardsPerPixel ?? mini?.registration?.currentScaleYardsPerPixel
  if (!finite(ypp) || ypp <= 0 || mini?.scale?.status === 'unavailable') {
    return failed('Existing native waypoint/par-3 ruler has not established pixel scale.', identityStatus)
  }
  const wps = (mini?.waypointRuler?.candidates ?? []).filter(c =>
    finite(c.yards) && c.yards >= 15 && c.yards <= 650 &&
    c.ocrVotes >= 4 && c.pixel && finite(c.pixel.x) && finite(c.pixel.y))
  const waypoint = wps.sort((a,b) => b.ocrVotes - a.ocrVotes || b.confidence - a.confidence)[0]
  if (!waypoint) {
    return failed('No reliable gray fairway waypoint and yardage. Do not use tee-to-pin scorecard yards on doglegs.', identityStatus)
  }
  const waypointPx: Vec = [waypoint.pixel.x, waypoint.pixel.y]
  const dWaypointPx = len(diff(waypointPx, ball))
  if (dWaypointPx <= 10) return failed('Gray waypoint is too close to the ball to serve as a ruler.', identityStatus)
  const waypointPixelYds = dWaypointPx * ypp
  const rulerError = Math.abs(waypointPixelYds - waypoint.yards) / waypoint.yards * 100
  if (rulerError > 8) return failed('Gray waypoint OCR yardage disagrees with existing native minimap scale by over 8%.', identityStatus)
  // OSM anchor + centroid are explicitly approximate, never trusted tee/pin.
  const tee = geometry.markers.tee, greenCenter = geometry.markers.pin
  if (!validMap(tee) || !validMap(greenCenter)) {
    return failed('Existing imported hole has no approximate route-start and green-centroid references.', identityStatus)
  }
  const osmAxis = diff(greenCenter, tee), nativeAxis = diff(pin, ball)
  const osmLength = len(osmAxis), nativeLength = len(nativeAxis)
  if (osmLength <= 25 || nativeLength <= 25) {
    return failed('Tee-to-pin axis is too short to compare coordinate systems.', identityStatus)
  }
  const nativeDir: Vec = [nativeAxis[0]/nativeLength, nativeAxis[1]/nativeLength]
  const osmDir: Vec = [osmAxis[0]/osmLength, osmAxis[1]/osmLength]
  const offset = diff(waypointPx, ball)
  const alternatives = ([false, true] as const).map(mirrored => {
    const mapPoint = project(tee, osmDir, nativeDir, offset, ypp, mirrored)
    const fairwayDistance = nearestSurfaceDistance(geometry, mapPoint, ['fairway'])
    return {
      mapPoint: [rnd(mapPoint[0]), rnd(mapPoint[1])] as CoursePointYds,
      fairwayDistanceYds: fairwayDistance == null ? null : rnd(fairwayDistance),
      handedness: mirrored ? 'mirrored' as const : 'screen-right-to-course-right' as const,
    }
  })
  return {
    status: 'approximate-research-only',
    reason: 'GSPro ball, gray default-aim waypoint and pin agree internally. Imported OSM route-start and green-centroid are approximate, so neither orientation nor course registration is verified.',
    nativeMarkerStatus: 'ball-waypoint-pin',
    identityStatus,
    yardsPerPixel: rnd(ypp),
    waypointDistanceOcrYds: waypoint.yards,
    waypointDistancePixelYds: rnd(waypointPixelYds),
    waypointRulerErrorPercent: rnd(rulerError),
    teeToGreenCentroidYds: rnd(osmLength),
    ballToGsproPinYds: rnd(nativeLength*ypp),
    teePinLengthDifferenceYds: rnd(osmLength - nativeLength*ypp),
    waypointLateralFromTeePinYds: rnd(Math.abs(cross(nativeDir,offset))*ypp),
    alternatives, verifiedForPlay: false, canPublishCourse: false, authorizesNativeAim: false,
  }
}
