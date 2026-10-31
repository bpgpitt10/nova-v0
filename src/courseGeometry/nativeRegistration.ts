import type { CoursePointYds } from './types'

/**
 * GSPro world -> Looper hole-local yards, using a published per-course
 * registration (public/course-geometry/<slug>/native-registration-v1.json).
 *
 * GSPro x/z are true-north ground metres (verified on FarmLinks by matching
 * 867 GKD heights to USGS LiDAR: median 4.5 cm; east/west halves agree within
 * 0.14 m). Conversion, mirrored from tools/course_model/build_native_registration.py:
 *
 *   GSPro x/z -> lat/lon   local tangent plane at the course reference point
 *   lat/lon  -> hole yards the course builder's own equirectangular frame
 *                          (anchor = hole's selected tee, axes by hole heading)
 *
 * Using the builder's frame keeps native points exactly aligned with the
 * package's polygons. Distances for recommendations should still come from
 * GSPro coordinates directly, which are exact metres.
 */

export type NativeHoleFrame = Readonly<{
  anchorLatLon: readonly [number, number]
  headingDegreesTrue: number
  origin?: string | null
}>

export type NativeRegistration = Readonly<{
  schemaVersion: 'looper-native-registration-v1'
  courseId: string
  gsproCourseKey: string
  layoutFingerprint: string
  /** Pins + green centres of the scene; any layout of the scene that matches
   * may use this registration. Older files lack it (main layout only). */
  sceneFingerprint: string | null
  grade: string
  reference: Readonly<{ latLon: readonly [number, number]; worldXZ: readonly [number, number] }>
  worldYToElevationOffsetM: number
  holes: Readonly<Record<string, NativeHoleFrame>>
}>

// Must match tools/build_osm_course_package.py
const BUILDER_EARTH_RADIUS_M = 6_371_008.8
const BUILDER_M_TO_YD = 1.0936133
// GRS80 ellipsoid for the GSPro -> lat/lon step
const ELLIPSOID_A = 6378137.0
const ELLIPSOID_F = 1 / 298.257222101
const ELLIPSOID_E2 = ELLIPSOID_F * (2 - ELLIPSOID_F)
const DEG = Math.PI / 180

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const pair = (value: unknown): readonly [number, number] | null =>
  Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1])
    ? [value[0], value[1]] : null

export const parseNativeRegistration = (value: unknown): NativeRegistration | null => {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== 'looper-native-registration-v1') return null
  if (typeof v.courseId !== 'string' || typeof v.gsproCourseKey !== 'string'
    || typeof v.layoutFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(v.layoutFingerprint)
    || typeof v.grade !== 'string' || !finite(v.worldYToElevationOffsetM)) return null
  const ref = v.reference as Record<string, unknown> | undefined
  const latLon = pair(ref?.latLon)
  const worldXZ = pair(ref?.worldXZ)
  if (!latLon || !worldXZ) return null
  const holes: Record<string, NativeHoleFrame> = {}
  if (!v.holes || typeof v.holes !== 'object') return null
  for (const [key, frameValue] of Object.entries(v.holes as Record<string, unknown>)) {
    const f = frameValue as Record<string, unknown> | null
    const anchor = pair(f?.anchorLatLon)
    if (!f || !anchor || !finite(f.headingDegreesTrue)) return null
    holes[key] = {
      anchorLatLon: anchor,
      headingDegreesTrue: f.headingDegreesTrue,
      origin: typeof f.origin === 'string' ? f.origin : null,
    }
  }
  return {
    schemaVersion: 'looper-native-registration-v1',
    courseId: v.courseId,
    gsproCourseKey: v.gsproCourseKey,
    layoutFingerprint: v.layoutFingerprint,
    sceneFingerprint: typeof v.sceneFingerprint === 'string' && /^[0-9a-f]{64}$/.test(v.sceneFingerprint)
      ? v.sceneFingerprint : null,
    grade: v.grade,
    reference: { latLon, worldXZ },
    worldYToElevationOffsetM: v.worldYToElevationOffsetM,
    holes,
  }
}

const radii = (latDeg: number) => {
  const s = Math.sin(latDeg * DEG)
  const w = Math.sqrt(1 - ELLIPSOID_E2 * s * s)
  return { meridian: ELLIPSOID_A * (1 - ELLIPSOID_E2) / (w * w * w), primeVertical: ELLIPSOID_A / w }
}

export const nativeWorldToLatLon = (
  registration: NativeRegistration,
  world: Readonly<{ x: number; z: number }>,
): readonly [number, number] => {
  const [lat0, lon0] = registration.reference.latLon
  const [x0, z0] = registration.reference.worldXZ
  const { meridian, primeVertical } = radii(lat0)
  return [
    lat0 + ((world.z - z0) / meridian) / DEG,
    lon0 + ((world.x - x0) / (primeVertical * Math.cos(lat0 * DEG))) / DEG,
  ]
}

export const latLonToHoleLocalYds = (
  frame: NativeHoleFrame,
  lat: number,
  lon: number,
): CoursePointYds => {
  const [lat0, lon0] = frame.anchorLatLon
  const north = BUILDER_EARTH_RADIUS_M * (lat - lat0) * DEG
  const east = BUILDER_EARTH_RADIUS_M * (lon - lon0) * DEG * Math.cos(lat0 * DEG)
  const h = frame.headingDegreesTrue * DEG
  const forward = [Math.sin(h), Math.cos(h)] as const
  const right = [forward[1], -forward[0]] as const
  return [
    (east * right[0] + north * right[1]) * BUILDER_M_TO_YD,
    (east * forward[0] + north * forward[1]) * BUILDER_M_TO_YD,
  ]
}

export const nativeWorldToHoleLocalYds = (
  registration: NativeRegistration,
  holeNumber: number,
  world: Readonly<{ x: number; z: number }> | null | undefined,
): CoursePointYds | null => {
  if (!world || !finite(world.x) || !finite(world.z)) return null
  const frame = registration.holes[String(holeNumber)]
  if (!frame) return null
  const [lat, lon] = nativeWorldToLatLon(registration, world)
  const local = latLonToHoleLocalYds(frame, lat, lon)
  return local.every(finite) ? local : null
}

/** Inverse of latLonToHoleLocalYds (the builder's frame is linear). */
export const holeLocalYdsToLatLon = (frame: NativeHoleFrame, local: CoursePointYds): readonly [number, number] => {
  const [lat0, lon0] = frame.anchorLatLon
  const h = frame.headingDegreesTrue * DEG
  const forward = [Math.sin(h), Math.cos(h)] as const
  const right = [forward[1], -forward[0]] as const
  const r = local[0] / BUILDER_M_TO_YD
  const f = local[1] / BUILDER_M_TO_YD
  const east = r * right[0] + f * forward[0]
  const north = r * right[1] + f * forward[1]
  return [
    lat0 + north / BUILDER_EARTH_RADIUS_M / DEG,
    lon0 + east / (BUILDER_EARTH_RADIUS_M * Math.cos(lat0 * DEG)) / DEG,
  ]
}

/** Inverse of nativeWorldToLatLon. */
export const nativeLatLonToWorld = (
  registration: NativeRegistration,
  lat: number,
  lon: number,
): Readonly<{ x: number; z: number }> => {
  const [lat0, lon0] = registration.reference.latLon
  const [x0, z0] = registration.reference.worldXZ
  const { meridian, primeVertical } = radii(lat0)
  return {
    x: x0 + (lon - lon0) * DEG * primeVertical * Math.cos(lat0 * DEG),
    z: z0 + (lat - lat0) * DEG * meridian,
  }
}

/** Looper hole-local yards -> GSPro world metres (for Auto Aim targets). */
export const nativeHoleLocalYdsToWorld = (
  registration: NativeRegistration,
  holeNumber: number,
  local: CoursePointYds | null | undefined,
): Readonly<{ x: number; z: number }> | null => {
  if (!local || !finite(local[0]) || !finite(local[1])) return null
  const frame = registration.holes[String(holeNumber)]
  if (!frame) return null
  const [lat, lon] = holeLocalYdsToLatLon(frame, local)
  const world = nativeLatLonToWorld(registration, lat, lon)
  return finite(world.x) && finite(world.z) ? world : null
}
