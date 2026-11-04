import type { CourseCatalogEntry } from './courseCatalog'
import {
  effectiveGreenCenter,
  type NativeCourseLayout,
  type NativeHole,
  type NativeXYZ,
} from './nativeGkd'
import { circleRing } from './nativeGreenAnchor'
import {
  nativeWorldToHoleLocalYds,
  nativeWorldToLatLon,
  type NativeHoleFrame,
  type NativeRegistration,
} from './nativeRegistration'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurface,
  CourseSurfaceKind,
  CourseTeeCandidate,
  CourseTerrainGrid,
  GeometryAvailability,
} from './types'

/**
 * GSPro-only courses: every installed GSPro course plays in Live Caddie at
 * once, from the player's own course file, with no map loaded.
 *
 * GSPro's course file (GKD) already says what each hole is: every tee, the
 * designer's aim points, the green centre, the pin slots, GSPro's own penalty
 * areas and OB, and the height of every one of those points. Looper used to
 * insist that OpenStreetMap say it instead (18 hole lines, greens, LiDAR), and
 * 34 of 43 courses in one library failed (claude/course-preflight-2026-11-04.md).
 *
 * Here the hole frame comes straight from GSPro's world: no map, no fit.
 * GSPro x/z are true-north ground metres (FarmLinks: 867 heights matched to
 * LiDAR at 4.5 cm), so a registration with no turn and no scale, and hole
 * frames anchored in GSPro metres (anchorWorldXZ), place every GSPro position
 * exactly. The lat/lon in the registration is only a carrier.
 *
 * What a GSPro-only hole has: tees (all of them, as tee candidates), the green
 * (a disc around GSPro's green centre sized by its pins), GSPro's penalty
 * areas and OB (added later by nativeHazards, as for any course), and a coarse
 * terrain from GSPro's own heights (tees, aim points, greens, pins, penalty
 * area edges). What it lacks: fairway, rough, bunkers, trees and fine slopes;
 * a loaded map adds those.
 *
 * The course file stays on the PC: everything here is built in the browser.
 */

export const GSPRO_ONLY_ID_PREFIX = 'gspro:'
export const GSPRO_ONLY_GRADE = 'GSPro file'

export const isGsproOnlyCourseId = (id: string | null | undefined): boolean =>
  typeof id === 'string' && id.startsWith(GSPRO_ONLY_ID_PREFIX)

export const gsproOnlyCourseId = (courseKey: string) => `${GSPRO_ONLY_ID_PREFIX}${courseKey}`

export const gsproOnlyCourseKey = (id: string | null | undefined): string | null =>
  isGsproOnlyCourseId(id) ? (id as string).slice(GSPRO_ONLY_ID_PREFIX.length) : null

const keyAsName = (key: string) => key.replace(/_gsp$/i, '').replace(/[_-]+/g, ' ').trim()

export type GsproInstalledCourse = Readonly<{
  courseKey: string
  courseName: string
  location?: string | null
  altitude?: number | null
}>

export const gsproOnlyCatalogEntry = (course: GsproInstalledCourse): CourseCatalogEntry => {
  const name = course.courseName.trim() || keyAsName(course.courseKey)
  return {
    id: gsproOnlyCourseId(course.courseKey),
    name,
    location: (course.location ?? '').replace(/^[\s,]+|[\s,]+$/g, ''),
    slug: `gspro-${course.courseKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    gsproAliases: [...new Set([course.courseKey, name].filter(Boolean))],
    status: 'validation',
    packageStatus: 'ready',
    packageVersion: 'gspro-course-file',
    packageCacheStatus: 'unknown',
    osmCacheStatus: 'unknown',
    lidarCacheStatus: 'unknown',
    source: 'gspro-only',
    altitudeFt: typeof course.altitude === 'number' && Number.isFinite(course.altitude) ? course.altitude : null,
  }
}

// ---------------------------------------------------------------- registration

/**
 * Where the carrier lat/lon sits when the course file names no location.
 * The hole frames use a sphere while GSPro -> lat/lon uses the ellipsoid; at
 * 35° their north and east scales are off by ±0.2% (under half a yard at
 * 200 yd), the smallest worst case of any latitude.
 */
const CARRIER_LAT_LON: readonly [number, number] = [35, 0]
const M_TO_FT = 3.28084

const backTee = (hole: NativeHole) =>
  Object.values(hole.tees).reduce<NativeHole['tees'][string] | null>(
    (best, tee) => (!best || tee.distanceM > best.distanceM ? tee : best), null)

const median = (values: readonly number[]) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Heights GSPro puts on the ground for sure: tees, green centres, pins. */
const corePoints = (layout: NativeCourseLayout): NativeXYZ[] => layout.holes.flatMap((hole) => [
  ...Object.values(hole.tees),
  ...hole.pins,
  ...(effectiveGreenCenter(hole) ? [effectiveGreenCenter(hole)!.point] : []),
])

/** True bearing (degrees) from a to b in GSPro's world (x east, z north). */
const bearing = (a: NativeXYZ, b: NativeXYZ) => {
  const deg = (Math.atan2(b.x - a.x, b.z - a.z) * 180) / Math.PI
  return (deg + 360) % 360
}

export const gsproOnlyRegistration = (input: Readonly<{
  courseId: string
  courseKey: string
  layout: NativeCourseLayout
  layoutFingerprint: string
  sceneFingerprint: string | null
  /** The course's altitude (GSPro's, feet), for air density; sea level if unknown. */
  altitudeFt?: number | null
}>): NativeRegistration => {
  const { layout } = input
  const greens = layout.holes
    .map((hole) => effectiveGreenCenter(hole)?.point ?? null)
    .filter((p): p is NativeXYZ => p !== null)
  const anchorPoints = greens.length ? greens : corePoints(layout)
  const worldXZ: readonly [number, number] = anchorPoints.length
    ? [anchorPoints.reduce((s, p) => s + p.x, 0) / anchorPoints.length,
      anchorPoints.reduce((s, p) => s + p.z, 0) / anchorPoints.length]
    : [0, 0]
  const groundY = median(corePoints(layout).map((p) => p.y)) ?? 0
  const altitudeM = typeof input.altitudeFt === 'number' && Number.isFinite(input.altitudeFt)
    ? input.altitudeFt / M_TO_FT : 0
  const base: NativeRegistration = {
    schemaVersion: 'looper-native-registration-v1',
    courseId: input.courseId,
    gsproCourseKey: input.courseKey,
    layoutFingerprint: input.layoutFingerprint,
    sceneFingerprint: input.sceneFingerprint,
    grade: GSPRO_ONLY_GRADE,
    reference: { latLon: layout.courseLatLon ?? CARRIER_LAT_LON, worldXZ },
    // Elevation (m) = y + offset: GSPro's ground at the course's altitude.
    worldYToElevationOffsetM: altitudeM - groundY,
    holes: {},
  }
  const holes: Record<string, NativeHoleFrame> = {}
  for (const hole of layout.holes) {
    const tee = backTee(hole)
    const green = effectiveGreenCenter(hole)?.point ?? null
    if (!tee || !green) continue
    holes[String(hole.hole)] = {
      anchorLatLon: nativeWorldToLatLon(base, tee),
      // Exact GSPro metres: no lat/lon step (nativeRegistration).
      anchorWorldXZ: [tee.x, tee.z],
      headingDegreesTrue: bearing(tee, green),
      origin: `gspro-${tee.name.toLowerCase()}-tee`,
    }
  }
  return { ...base, holes }
}

/** Hole headings (true degrees, holes 1–18) of a GSPro-only registration, for wind. */
export const gsproOnlyHoleHeadings = (registration: NativeRegistration): (number | null)[] =>
  Array.from({ length: 18 }, (_, i) => registration.holes[String(i + 1)]?.headingDegreesTrue ?? null)

// ---------------------------------------------------------------- terrain

const TERRAIN_SPACING_YDS = 3
const TERRAIN_NEIGHBOURS = 8
const TERRAIN_NODATA = 65535
/** A height point this far above or below the nearest tee/pin/green is not on the ground. */
const HEIGHT_OUTLIER_M = 30

type HeightPoint = Readonly<{ x: number; y: number; ft: number }>

/**
 * GSPro's ground heights around a hole, in hole-local yards: tees, aim points,
 * green centres and pins of every hole, and penalty-area edges. Aim points and
 * penalty edges far above or below the nearest sure point are dropped (a
 * designer's polygon is not always drawn on the ground).
 */
export const gsproHeightPoints = (
  layouts: readonly NativeCourseLayout[],
  registration: NativeRegistration,
  holeNumber: number,
): HeightPoint[] => {
  const core: NativeXYZ[] = []
  const extra: NativeXYZ[] = []
  for (const layout of layouts) {
    core.push(...corePoints(layout))
    for (const hole of layout.holes) extra.push(...hole.aimPoints)
    for (const area of layout.penaltyAreas) extra.push(...area.points)
  }
  const nearestCoreY = (p: NativeXYZ) => {
    let best = Infinity
    let y = p.y
    for (const c of core) {
      const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2
      if (d < best) { best = d; y = c.y }
    }
    return y
  }
  const kept = [...core, ...extra.filter((p) => Math.abs(p.y - nearestCoreY(p)) <= HEIGHT_OUTLIER_M)]
  const seen = new Set<string>()
  const out: HeightPoint[] = []
  for (const p of kept) {
    const key = `${p.x.toFixed(1)}|${p.z.toFixed(1)}`
    if (seen.has(key)) continue
    seen.add(key)
    const local = nativeWorldToHoleLocalYds(registration, holeNumber, p)
    if (!local) continue
    out.push({ x: local[0], y: local[1], ft: (p.y + registration.worldYToElevationOffsetM) * M_TO_FT })
  }
  return out
}

/**
 * A coarse terrain grid from scattered GSPro heights: inverse-distance
 * weighting of the nearest few points, 3-yd cells. Exact at tees, aim points,
 * greens and pins; in between it is an estimate (no hill a point doesn't see).
 */
export const terrainFromHeights = (
  points: readonly HeightPoint[],
  bounds: Readonly<{ minX: number; maxX: number; minY: number; maxY: number }>,
  spacing = TERRAIN_SPACING_YDS,
): CourseTerrainGrid | null => {
  const margin = 150
  const near = points.filter((p) => p.x >= bounds.minX - margin && p.x <= bounds.maxX + margin
    && p.y >= bounds.minY - margin && p.y <= bounds.maxY + margin)
  if (near.length < 3) return null
  const width = Math.max(2, Math.ceil((bounds.maxX - bounds.minX) / spacing) + 1)
  const height = Math.max(2, Math.ceil((bounds.maxY - bounds.minY) / spacing) + 1)
  const minFt = Math.min(...near.map((p) => p.ft))
  const maxFt = Math.max(...near.map((p) => p.ft))
  if (!Number.isFinite(minFt) || (maxFt - minFt) * 10 >= TERRAIN_NODATA - 1) return null
  const offset = Math.floor(minFt) - 1
  const values = new Uint16Array(width * height)
  const k = Math.min(TERRAIN_NEIGHBOURS, near.length)
  // The k nearest points of each cell, kept sorted by insertion (k is small).
  const bestD = new Float64Array(k)
  const bestFt = new Float64Array(k)
  for (let row = 0; row < height; row += 1) {
    const y = bounds.minY + row * spacing
    for (let col = 0; col < width; col += 1) {
      const x = bounds.minX + col * spacing
      let filled = 0
      for (let i = 0; i < near.length; i += 1) {
        const d = (near[i].x - x) ** 2 + (near[i].y - y) ** 2
        if (filled === k && d >= bestD[k - 1]) continue
        let j = filled < k ? filled++ : k - 1
        while (j > 0 && bestD[j - 1] > d) {
          bestD[j] = bestD[j - 1]
          bestFt[j] = bestFt[j - 1]
          j -= 1
        }
        bestD[j] = d
        bestFt[j] = near[i].ft
      }
      let ft: number
      if (bestD[0] < 0.25) {
        ft = bestFt[0]
      } else {
        let w = 0
        let sum = 0
        for (let j = 0; j < filled; j += 1) {
          const weight = 1 / bestD[j]
          w += weight
          sum += weight * bestFt[j]
        }
        ft = sum / w
      }
      values[row * width + col] = Math.max(0, Math.min(TERRAIN_NODATA - 1, Math.round((ft - offset) * 10)))
    }
  }
  return {
    source: 'gspro-heights',
    sourceResolutionMeters: spacing / 1.0936133,
    runtimeSpacingYds: spacing,
    interpolation: 'bilinear',
    minX: bounds.minX,
    minY: bounds.minY,
    width,
    height,
    elevationOffsetFt: offset,
    nodata: TERRAIN_NODATA,
    values,
    note: `Coarse terrain from ${near.length} GSPro course-file heights (tees, aim points, greens, pins, penalty edges).`,
  }
}

// ---------------------------------------------------------------- hole geometry

const GREEN_RADIUS_MIN_YDS = 11
const GREEN_RADIUS_MAX_YDS = 20
const GREEN_RADIUS_NO_PINS_YDS = 14
const GREEN_PIN_MARGIN_YDS = 5
const TEE_HALF_YDS: readonly [number, number] = [5, 4]

const box = (c: CoursePointYds, [hx, hy]: readonly [number, number]): CoursePointYds[] => [
  [c[0] - hx, c[1] - hy], [c[0] + hx, c[1] - hy], [c[0] + hx, c[1] + hy], [c[0] - hx, c[1] + hy],
]

const AVAILABILITY: Readonly<Record<CourseSurfaceKind, GeometryAvailability>> = {
  tee: 'available',
  fairway: 'unavailable',
  rough: 'unavailable',
  'deep-rough': 'unavailable',
  green: 'partial',
  bunker: 'unavailable',
  water: 'available',
  penalty: 'available',
}

export const GSPRO_ONLY_NOTE =
  "GSPro course file only: tees, pins, the green, GSPro's own water and OB, and heights from GSPro. "
  + 'No fairway, bunker or tree map; load the course for those.'

export const buildGsproOnlyHoleGeometry = (input: Readonly<{
  entry: Pick<CourseCatalogEntry, 'id' | 'name' | 'location'>
  /** The layout being played (main GKD or a GKDalt). */
  layout: NativeCourseLayout
  /** Every layout of the scene (heights for the terrain). */
  layouts?: readonly NativeCourseLayout[]
  registration: NativeRegistration
  holeNumber: number
  /** An alternate layout's name: its tees also answer to "White (Farmlinks Kids)". */
  altLayoutName?: string | null
}>): CourseHoleGeometry => {
  const { entry, layout, registration, holeNumber } = input
  const hole = layout.holes.find((h) => h.hole === holeNumber) ?? null
  if (!hole) throw new Error(`${entry.name} has no hole ${holeNumber} in GSPro's course file.`)
  const local = (p: NativeXYZ) => nativeWorldToHoleLocalYds(registration, holeNumber, p)
  const green = effectiveGreenCenter(hole)?.point ?? null
  const greenLocal = green ? local(green) : null
  const tees = Object.values(hole.tees)
    .map((tee) => ({ tee, point: local(tee) }))
    .filter((t): t is { tee: typeof t.tee; point: CoursePointYds } => t.point !== null)
  if (!greenLocal || !tees.length) {
    throw new Error(`${entry.name} hole ${holeNumber}: GSPro's course file has no tee or green for it.`)
  }
  const back = tees.reduce((best, t) => (t.tee.distanceM > best.tee.distanceM ? t : best))
  const pins = hole.pins.map(local).filter((p): p is CoursePointYds => p !== null)
  const maxPin = pins.reduce((m, p) => Math.max(m, Math.hypot(p[0] - greenLocal[0], p[1] - greenLocal[1])), 0)
  const greenRadius = pins.length
    ? Math.min(GREEN_RADIUS_MAX_YDS, Math.max(GREEN_RADIUS_MIN_YDS, maxPin + GREEN_PIN_MARGIN_YDS))
    : GREEN_RADIUS_NO_PINS_YDS
  const aims = hole.aimPoints.map(local).filter((p): p is CoursePointYds => p !== null)

  const surfaces: CourseSurface[] = [
    {
      id: `gspro-green-${holeNumber}`,
      kind: 'green',
      polygons: [circleRing(greenLocal, greenRadius)],
      provenance: {
        source: 'gspro',
        confidence: 'medium',
        note: `Disc around GSPro's green centre, ${greenRadius.toFixed(0)} yd, sized by ${pins.length} pin slots`,
      },
    },
    {
      id: `gspro-tees-${holeNumber}`,
      kind: 'tee',
      polygons: tees.map((t) => box(t.point, TEE_HALF_YDS)),
      provenance: { source: 'gspro', confidence: 'medium', note: "Small pads at GSPro's tees" },
    },
  ]

  const teeCandidates: CourseTeeCandidate[] = tees.map((t) => ({
    teeSet: t.tee.name,
    teeAliases: input.altLayoutName ? [t.tee.name, `${t.tee.name} (${input.altLayoutName})`] : [t.tee.name],
    name: t.tee.name,
    label: `${t.tee.name} (GSPro tee)`,
    coursePoint: t.point,
    teeToGreenCentroidYards: Math.hypot(greenLocal[0] - t.point[0], greenLocal[1] - t.point[1]),
    ...(t === back ? { selectedAnchor: true } : {}),
  }))

  const xs = [...tees.map((t) => t.point[0]), ...aims.map((p) => p[0]), greenLocal[0], ...pins.map((p) => p[0])]
  const ys = [...tees.map((t) => t.point[1]), ...aims.map((p) => p[1]), greenLocal[1], ...pins.map((p) => p[1])]
  const bounds = {
    minX: Math.floor(Math.min(...xs) - 70),
    maxX: Math.ceil(Math.max(...xs) + 70),
    minY: Math.floor(Math.min(...ys) - 25),
    maxY: Math.ceil(Math.max(...ys) + 45),
  }
  const terrain = terrainFromHeights(
    gsproHeightPoints(input.layouts?.length ? input.layouts : [layout], registration, holeNumber),
    bounds,
  )

  return {
    schemaVersion: 'looper-course-geometry-v1',
    courseId: entry.id,
    courseName: entry.name,
    ...(entry.location ? { location: entry.location } : {}),
    holeNumber,
    ...(hole.par != null ? { par: hole.par } : {}),
    statedYardageYds: Math.round(back.tee.distanceM * 1.0936133),
    coordinateSystem: { units: 'yards', origin: 'selected-tee', xAxis: 'right', yAxis: 'forward' },
    bounds,
    viewBounds: bounds,
    markers: { tee: back.point, pin: pins[0] ?? greenLocal },
    teeCandidates,
    surfaces,
    ...(terrain ? { terrain } : {}),
    availability: AVAILABILITY,
    registration: {
      status: 'verified',
      method: 'other',
      sourceCoordinateSystem: 'gspro-world-metres',
      targetCoordinateSystem: 'looper-hole-local-yards',
      note: "Placed straight from GSPro's course file (no map fit).",
    },
    provenance: {
      geometrySource: 'gspro-course-file',
      sourceElementIdsComplete: false,
      note: GSPRO_ONLY_NOTE,
    },
  }
}
