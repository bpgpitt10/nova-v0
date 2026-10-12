import type { CourseHoleGeometry, CoursePointYds } from './types'

/**
 * First-use fallback ONLY when no selected tee is matched or locked.
 *
 * No pixel x/% -> map x conversion: the GSPro minimap is recentered and may be
 * rotated; raw lateral screen position is NOT a geospatial measurement.
 * Instead, a measured GSPro *straight* ball-to-pin distance can constrain the
 * likely tee along the existing map-tee-anchor-to-green-centroid bearing.
 * The base can be the OSM route start OR the nearest mapped tee after
 * normalization: neither proves the user's selected tee. This is unverified.
 */
export type ProvisionalTeeEstimate =
  | Readonly<{
      status: 'provisional'
      point: CoursePointYds
      source: 'osm-route-start' | 'existing-map-tee-anchor' | 'ball-pin-distance-constrained'
      uncertaintyRadiusYds: number
      distanceInputYds: number | null
      adjustmentYds: number
      note: string
      usableForExactHazardCarry: false
      authorizesNativeAim: false
      locksTeeCalibration: false
    }>
  | Readonly<{
      status: 'blocked'
      point: null
      reason: string
      usableForExactHazardCarry: false
      authorizesNativeAim: false
      locksTeeCalibration: false
    }>

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const pointOk = (p: CoursePointYds | undefined): p is CoursePointYds =>
  Array.isArray(p) && p.length === 2 && p.every(finite)
const block = (reason: string): ProvisionalTeeEstimate => ({
  status: 'blocked', point: null, reason,
  usableForExactHazardCarry: false, authorizesNativeAim: false, locksTeeCalibration: false,
})

// These bounds are provisional product research gates, not validated errors.
// Unknown tee placement is broad; even a length-constrained estimate remains
// laterally uncertain. Never represent 0..1 screen framing as geographic side.
export const MAX_ROUTE_TEE_DISTANCE_YDS = 45
export const ROUTE_ONLY_UNCERTAINTY_YDS = 50
export const DISTANCE_CONSTRAINED_UNCERTAINTY_YDS = 25

export const estimateProvisionalTee = (
  geometry: CourseHoleGeometry,
  measuredStraightBallPinYds?: number | null,
): ProvisionalTeeEstimate => {
  const sourceOrigin = geometry.coordinateSystem.origin
  if (sourceOrigin === 'selected-tee' && geometry.registration.status === 'verified') {
    return block('This hole already has a verified selected-tee coordinate origin.')
  }
  if (sourceOrigin !== 'osm-hole-route-start' && sourceOrigin !== 'selected-tee') {
    return block('Unknown course coordinate origin.')
  }
  const anchorDescription = sourceOrigin === 'selected-tee'
    ? 'Existing approximate mapped tee anchor'
    : 'OSM hole route start'
  const tee = geometry.markers.tee, pin = geometry.markers.pin
  if (!pointOk(tee) || !pointOk(pin)) {
    return block('No route-start and green-centroid anchor.')
  }
  if (geometry.registration.status === 'unavailable') {
    return block('Imported hole geospatial registration is unavailable.')
  }
  const dx = pin[0] - tee[0], dy = pin[1] - tee[1]
  const baseline = Math.hypot(dx, dy)
  if (baseline < 45 || baseline > 750 || !finite(baseline)) {
    return block('Hole route-start to green-centroid axis is not credible.')
  }
  if (measuredStraightBallPinYds == null) {
    return {
      status: 'provisional', point: tee, source: sourceOrigin === 'selected-tee' ? 'existing-map-tee-anchor' : 'osm-route-start',
      uncertaintyRadiusYds: ROUTE_ONLY_UNCERTAINTY_YDS,
      distanceInputYds: null, adjustmentYds: 0,
      note: anchorDescription + ' only. The selected tee may be farther away than the planning guard band; precise carries, elevation and hazards are unverified.',
      usableForExactHazardCarry: false, authorizesNativeAim: false, locksTeeCalibration: false,
    }
  }
  if (!finite(measuredStraightBallPinYds)
    || measuredStraightBallPinYds < 45 || measuredStraightBallPinYds > 750) {
    return block('GSPro straight ball-to-pin distance is invalid.')
  }
  // OSM green marker is polygon CENTROID, GSPro distance is to today's PIN.
  // A modest disagreement can reflect pin/tee offsets; large differences
  // typically signal dogleg route/tee/green mismatch or stale observations.
  const shift = baseline - measuredStraightBallPinYds
  if (Math.abs(shift) > MAX_ROUTE_TEE_DISTANCE_YDS) {
    return block('GSPro straight distance and mapped tee/green axis disagree by more than 45 yards; cannot safely guess this tee.')
  }
  const axisX = dx / baseline, axisY = dy / baseline
  return {
    status: 'provisional',
    point: [
      tee[0] + axisX * shift,
      tee[1] + axisY * shift,
    ],
    source: 'ball-pin-distance-constrained',
    uncertaintyRadiusYds: DISTANCE_CONSTRAINED_UNCERTAINTY_YDS,
    distanceInputYds: measuredStraightBallPinYds,
    adjustmentYds: shift,
    note: 'Projected GSPro ball-to-pin ruler onto the ' + anchorDescription + ' to green-centroid bearing. Lateral tee position is NOT established by minimap screen X. Approximate tee only.',
    usableForExactHazardCarry: false, authorizesNativeAim: false, locksTeeCalibration: false,
  }
}

/** Untrusted minimap pixels -> distance ONLY; never geographical position. */
export const readTeeBallPinDistanceYds = (params: Readonly<{
  ballPixel?: { x: number; y: number } | null
  pinPixel?: { x: number; y: number } | null
  yardsPerPixel?: number | null
  waypointCount?: number | null
  scaleStatus?: string | null
  markerStatus?: string | null
}>): number | null => {
  const { ballPixel, pinPixel, yardsPerPixel } = params
  if (params.markerStatus !== 'markers_found'
    || !ballPixel || !pinPixel
    || ![ballPixel.x, ballPixel.y, pinPixel.x, pinPixel.y].every(finite)
    || !finite(yardsPerPixel) || yardsPerPixel <= 0
    || (params.scaleStatus !== 'provisional_gray_waypoint'
      && params.scaleStatus !== 'tee_verified_waypoint'
      && params.scaleStatus !== 'provisional_par3')
    || (params.scaleStatus !== 'provisional_par3' && (!finite(params.waypointCount) || params.waypointCount < 2))
  ) return null
  const distance = Math.hypot(ballPixel.x - pinPixel.x, ballPixel.y - pinPixel.y) * yardsPerPixel
  return finite(distance) && distance >= 45 && distance <= 750 ? distance : null
}
