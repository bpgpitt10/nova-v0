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

/** A group of holes the designer placed apart from the rest of the scene
 * (Kiawah, 11/4: holes 10–18 sit 2.8 km from where the map has them), with its
 * own placement. Holes not in a group use the registration's own placement. */
export type NativeRegistrationGroup = Readonly<{
  holes: readonly number[]
  reference: Readonly<{ latLon: readonly [number, number]; worldXZ: readonly [number, number] }>
  rotationDeg?: number
  scale?: number
  mirrored?: boolean
  worldYToElevationOffsetM: number
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
  /** How the GSPro scene is turned and scaled against true-north metres:
   * (east + i·north) = scale · e^(i·rotation) · (dx + i·dz). FarmLinks is 0° / 1;
   * Valhalla's designer built it upside down (180°), Royal New Kent about -12°.
   * Older files omit both (0° / 1). */
  rotationDeg?: number
  scale?: number
  /** Scene built mirror-image (x runs west): dx is negated before the turn. */
  mirrored?: boolean
  worldYToElevationOffsetM: number
  holes: Readonly<Record<string, NativeHoleFrame>>
  holeGroups?: readonly NativeRegistrationGroup[]
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
  const holeGroups: NativeRegistrationGroup[] = []
  if (Array.isArray(v.holeGroups)) {
    for (const groupValue of v.holeGroups as unknown[]) {
      const g = groupValue as Record<string, unknown> | null
      const gRef = g?.reference as Record<string, unknown> | undefined
      const gLatLon = pair(gRef?.latLon)
      const gWorld = pair(gRef?.worldXZ)
      const gHoles = Array.isArray(g?.holes) ? (g!.holes as unknown[]).filter((h): h is number => Number.isInteger(h)) : []
      if (!g || !gLatLon || !gWorld || !gHoles.length || !finite(g.worldYToElevationOffsetM)) return null
      holeGroups.push({
        holes: gHoles,
        reference: { latLon: gLatLon, worldXZ: gWorld },
        ...(finite(g.rotationDeg) && Math.abs(g.rotationDeg) > 1e-9 ? { rotationDeg: g.rotationDeg } : {}),
        ...(finite(g.scale) && g.scale > 0.5 && g.scale < 2 && Math.abs(g.scale - 1) > 1e-12 ? { scale: g.scale } : {}),
        ...(g.mirrored === true ? { mirrored: true } : {}),
        worldYToElevationOffsetM: g.worldYToElevationOffsetM,
      })
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
    ...(finite(v.rotationDeg) && Math.abs(v.rotationDeg) > 1e-9 ? { rotationDeg: v.rotationDeg } : {}),
    ...(finite(v.scale) && v.scale > 0.5 && v.scale < 2 && Math.abs(v.scale - 1) > 1e-12 ? { scale: v.scale } : {}),
    ...(v.mirrored === true ? { mirrored: true } : {}),
    worldYToElevationOffsetM: v.worldYToElevationOffsetM,
    holes,
    ...(holeGroups.length ? { holeGroups } : {}),
  }
}

/** The placement a hole uses: its group's, or the registration's own. */
export const registrationForHole = (registration: NativeRegistration, holeNumber: number): NativeRegistration => {
  const group = registration.holeGroups?.find((g) => g.holes.includes(holeNumber))
  if (!group) return registration
  const { rotationDeg: _r, scale: _s, mirrored: _m, holeGroups: _g, ...rest } = registration
  return {
    ...rest,
    reference: group.reference,
    worldYToElevationOffsetM: group.worldYToElevationOffsetM,
    ...(group.rotationDeg != null ? { rotationDeg: group.rotationDeg } : {}),
    ...(group.scale != null ? { scale: group.scale } : {}),
    ...(group.mirrored ? { mirrored: true } : {}),
  }
}

const radii = (latDeg: number) => {
  const s = Math.sin(latDeg * DEG)
  const w = Math.sqrt(1 - ELLIPSOID_E2 * s * s)
  return { meridian: ELLIPSOID_A * (1 - ELLIPSOID_E2) / (w * w * w), primeVertical: ELLIPSOID_A / w }
}

/** (east, north) metres of lat/lon from a reference point, on the same
 * ellipsoid the GSPro <-> lat/lon step uses. */
export const groundOffsetMeters = (
  lat0: number, lon0: number, lat: number, lon: number,
): readonly [number, number] => {
  const { meridian, primeVertical } = radii(lat0)
  return [(lon - lon0) * DEG * primeVertical * Math.cos(lat0 * DEG), (lat - lat0) * DEG * meridian]
}

export const nativeWorldToLatLon = (
  registration: NativeRegistration,
  world: Readonly<{ x: number; z: number }>,
): readonly [number, number] => {
  const [lat0, lon0] = registration.reference.latLon
  const [x0, z0] = registration.reference.worldXZ
  const { meridian, primeVertical } = radii(lat0)
  const [east, north] = sceneToGround(registration, world.x - x0, world.z - z0)
  return [
    lat0 + (north / meridian) / DEG,
    lon0 + (east / (primeVertical * Math.cos(lat0 * DEG))) / DEG,
  ]
}

/** GSPro scene offset (dx, dz) -> ground (east, north) metres. */
const sceneToGround = (registration: NativeRegistration, dx: number, dz: number): readonly [number, number] => {
  const theta = (registration.rotationDeg ?? 0) * DEG
  const k = registration.scale ?? 1
  const mx = registration.mirrored ? -dx : dx
  if (theta === 0 && k === 1) return [mx, dz]
  const c = Math.cos(theta) * k
  const s = Math.sin(theta) * k
  return [c * mx - s * dz, s * mx + c * dz]
}

/** Inverse of sceneToGround. */
const groundToScene = (registration: NativeRegistration, east: number, north: number): readonly [number, number] => {
  const theta = (registration.rotationDeg ?? 0) * DEG
  const k = registration.scale ?? 1
  const sign = registration.mirrored ? -1 : 1
  if (theta === 0 && k === 1) return [sign * east, north]
  const c = Math.cos(theta) / k
  const s = Math.sin(theta) / k
  return [sign * (c * east + s * north), -s * east + c * north]
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
  const [lat, lon] = nativeWorldToLatLon(registrationForHole(registration, holeNumber), world)
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
  const [dx, dz] = groundToScene(registration,
    (lon - lon0) * DEG * primeVertical * Math.cos(lat0 * DEG),
    (lat - lat0) * DEG * meridian)
  return { x: x0 + dx, z: z0 + dz }
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
  const world = nativeLatLonToWorld(registrationForHole(registration, holeNumber), lat, lon)
  return finite(world.x) && finite(world.z) ? world : null
}
