import type { CourseCatalogEntry } from './courseCatalog'
import { buildGsproOnlyHoleGeometry, gsproHeightPoints } from './gsproOnlyCourse'
import {
  effectiveGreenCenter,
  sha256Hex,
  type NativeCourseLayout,
  type NativeXYZ,
} from './nativeGkd'
import { unorderedGreenFit } from './nativeRegistrationAuto'
import {
  fitNativeRegistration,
  registrationFromGreens,
  terrainSamplerFromHoles,
} from './nativeRegistrationFit'
import {
  groundOffsetMeters,
  holeLocalYdsToLatLon,
  nativeLatLonToWorld,
  nativeWorldToHoleLocalYds,
  nativeWorldToLatLon,
  registrationForHole,
  type NativeHoleFrame,
  type NativeRegistration,
} from './nativeRegistration'
import {
  parseContextLayers,
  parseMapFeatures,
  parsePackageTerrain,
  parseSurfaces,
} from './routePackagedCourseLoader'
import type {
  CourseContextLayer,
  CourseHoleGeometry,
  CourseMapFeature,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurface,
  CourseSurfaceKind,
  CourseTerrainGrid,
  GeometryAvailability,
} from './types'

/**
 * Area courses: a course loaded as one map area (course-area-v1.json) instead
 * of hole by hole, because OpenStreetMap doesn't draw one numbered hole line
 * per hole (Frosty Valley: holes 10–18 missing; Bandon Dunes, Bethpage,
 * Detroit GC: several courses in one outline; Pinehurst No. 2: unnumbered).
 *
 * On the sim PC, GSPro's course file says what each hole is:
 *  1. Match GSPro's 18 greens to the map's greens ignoring numbers (the same
 *     fit the Load page uses to pick an outline), which also picks the right
 *     18 out of a resort, then refine the placement against the area's LiDAR
 *     terrain exactly as for hole packages (grade A/B).
 *  2. Each hole is the GSPro-only hole (its tees, pins, frame in GSPro metres)
 *     with the map's ground laid over it: this hole's fairway and green,
 *     bunkers, water, trees, paths, and the LiDAR terrain. A neighbouring
 *     hole's fairway counts as rough (in play, never a target).
 *
 * Terrain is 1 m LiDAR where published (USGS, NRCan, LINZ). Elsewhere it is
 * Copernicus GLO-30 (30 m, coarse): the placement then comes from the greens
 * alone, and the grid is bent to GSPro's own heights (tees, aim points, pins,
 * hazard edges), since the sim's ground is what the ball plays on.
 *
 * The course file never leaves the PC; the cloud only built the map area.
 */

export const AREA_PACKAGE_FILE = 'course-area-v1.json'

export const isAreaPackageUrl = (url: string | null | undefined) =>
  typeof url === 'string' && url.endsWith(AREA_PACKAGE_FILE)

export type AreaGreen = Readonly<{ id: string; latLon: readonly [number, number] }>

export type CourseAreaPackage = Readonly<{
  courseId: string
  courseName: string
  frame: NativeHoleFrame
  surfaces: readonly CourseSurface[]
  contextLayers: readonly CourseContextLayer[]
  mapFeatures: readonly CourseMapFeature[]
  terrain: CourseTerrainGrid | null
  greens: readonly AreaGreen[]
  lidar: boolean
}>

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const pair = (v: unknown): readonly [number, number] | null =>
  Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : null

export const parseAreaPackage = async (courseId: string, value: unknown): Promise<CourseAreaPackage> => {
  const pkg = (value ?? {}) as Record<string, unknown>
  if (pkg.schemaVersion !== 'looper-course-area-v1') throw new Error('Not a Looper course-area package.')
  const area = (pkg.area ?? {}) as Record<string, unknown>
  const cf = (area.coordinateFrame ?? {}) as Record<string, unknown>
  const anchor = pair(cf.anchorLatLon)
  if (!anchor || !finite(cf.headingDegreesTrue)) throw new Error('Course-area package has no frame.')
  const courseName = typeof pkg.courseName === 'string' ? pkg.courseName : courseId
  const greens = (Array.isArray(area.greens) ? area.greens : []).flatMap((g): AreaGreen[] => {
    const raw = g as Record<string, unknown>
    const latLon = pair(raw?.latLon)
    return latLon ? [{ id: String(raw.id ?? ''), latLon }] : []
  })
  const terrain = area.terrain
    ? await parsePackageTerrain(area.terrain as Parameters<typeof parsePackageTerrain>[0], courseName, 0).catch(() => null)
    : null
  return {
    courseId,
    courseName,
    frame: { anchorLatLon: anchor, headingDegreesTrue: cf.headingDegreesTrue, origin: 'area-centre' },
    surfaces: parseSurfaces(courseId, 0, area.surfaces),
    contextLayers: parseContextLayers(courseId, 0, area.context),
    mapFeatures: parseMapFeatures(courseId, 0, area.mapFeatures),
    terrain,
    greens,
    lidar: Boolean(pkg.enrichment),
  }
}

const areaCache = new Map<string, Promise<CourseAreaPackage>>()

export const loadCourseAreaPackage = (entry: Pick<CourseCatalogEntry, 'id' | 'staticPackageUrl'>) => {
  const url = entry.staticPackageUrl
  if (!url) return Promise.reject(new Error('This course has no area package.'))
  let pending = areaCache.get(url)
  if (!pending) {
    pending = fetch(url, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Course area returned ${r.status}.`))))
      .then((json) => parseAreaPackage(entry.id, json))
    areaCache.set(url, pending)
    pending.catch(() => areaCache.delete(url))
  }
  return pending
}

// ---------------------------------------------------------------- registration

/** At least this many of GSPro's greens must pair with the map's. */
const MIN_PAIRED_SHARE = 2 / 3
/** The paired greens must line up this well (rms) at nearly true scale. */
const AREA_GREENS_RMS_M = 8
const AREA_SCALE_TOLERANCE = 0.03
const HAZARD_POINTS_BELOW = 150
/** Terrain this coarse (Copernicus 30 m) can't refine a placement; the greens place it. */
const COARSE_TERRAIN_M = 5

export const isCoarseTerrain = (t: CourseTerrainGrid | null | undefined) =>
  Boolean(t && (t.source === 'global-dem' || t.sourceResolutionMeters >= COARSE_TERRAIN_M))

/** GSPro hole frames (anchored in GSPro metres) for a fitted registration. */
export const gsproHoleFrames = (registration: NativeRegistration, layout: NativeCourseLayout): Record<string, NativeHoleFrame> => {
  const frames: Record<string, NativeHoleFrame> = {}
  for (const hole of layout.holes) {
    const tee = Object.values(hole.tees).reduce<NativeXYZ & { distanceM: number } | null>(
      (best, t) => (!best || t.distanceM > best.distanceM ? t : best), null)
    const green = effectiveGreenCenter(hole)?.point ?? null
    if (!tee || !green) continue
    const reg = registrationForHole(registration, hole.hole)
    const teeLatLon = nativeWorldToLatLon(reg, tee)
    const greenLatLon = nativeWorldToLatLon(reg, green)
    const [east, north] = groundOffsetMeters(teeLatLon[0], teeLatLon[1], greenLatLon[0], greenLatLon[1])
    frames[String(hole.hole)] = {
      anchorLatLon: teeLatLon,
      anchorWorldXZ: [tee.x, tee.z],
      headingDegreesTrue: ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360,
      origin: 'gspro-back-tee',
    }
  }
  return frames
}

export type AreaRegistrationResult = Readonly<{
  registration: NativeRegistration | null
  reason: string
  paired: number
  greensRmsM: number | null
}>

export const fitRegistrationFromArea = async (input: Readonly<{
  courseId: string
  gsproCourseKey: string
  layout: NativeCourseLayout
  area: CourseAreaPackage
}>): Promise<AreaRegistrationResult> => {
  const { layout, area } = input
  const mapped = new Map(area.greens.map((g, i) => [i, g.latLon] as const))
  const fit = unorderedGreenFit(layout, mapped)
  const holesWithGreens = layout.holes.filter((h) => effectiveGreenCenter(h)).length
  const need = Math.max(6, Math.ceil(MIN_PAIRED_SHARE * holesWithGreens))
  if (!fit || fit.paired < need || fit.rmsM > AREA_GREENS_RMS_M || Math.abs(fit.scale - 1) > AREA_SCALE_TOLERANCE) {
    return {
      registration: null,
      paired: fit?.paired ?? 0,
      greensRmsM: fit?.rmsM ?? null,
      reason: fit
        ? `only ${fit.paired} of ${holesWithGreens} GSPro greens match the map's greens (${fit.rmsM.toFixed(1)} m); is this the same course?`
        : "GSPro's greens don't match the map's greens",
    }
  }
  const greens = fit.holes.flatMap(([gsproHole, mapIndex]) => {
    const hole = layout.holes.find((h) => h.hole === gsproHole)
    const centre = hole ? effectiveGreenCenter(hole) : null
    const g = area.greens[mapIndex]
    return centre && g ? [{ hole: gsproHole, world: centre.point, latLon: g.latLon }] : []
  })
  const points: NativeXYZ[] = layout.holes.flatMap((h) => {
    const centre = effectiveGreenCenter(h)
    return [...h.pins, ...(centre && !centre.replaced ? [centre.point] : [])]
  })
  const turned = fit.mirrored || Math.abs(fit.rotationDeg) > 0.5 || Math.abs(fit.scale - 1) > 0.003
  const fitInput = {
    ...(turned ? { rotationDeg: fit.rotationDeg, scale: fit.scale } : {}),
    ...(fit.mirrored ? { mirrored: true } : {}),
    courseId: input.courseId,
    gsproCourseKey: input.gsproCourseKey,
    layoutFingerprint: await sha256Hex(layout.fingerprintText),
    sceneFingerprint: await sha256Hex(layout.sceneFingerprintText),
    points,
    greens,
    holes: {},
    sampler: area.terrain ? terrainSamplerFromHoles([{ frame: area.frame, terrain: area.terrain }]) : () => null,
  }
  const fine = area.terrain && !isCoarseTerrain(area.terrain)
  let result = fine ? fitNativeRegistration(fitInput) : null
  const hazardPoints = layout.penaltyAreas.flatMap((a) => a.points)
  if (fine && !result?.registration && points.length < HAZARD_POINTS_BELOW && hazardPoints.length) {
    const retry = fitNativeRegistration({ ...fitInput, points: [...points, ...hazardPoints] })
    if (retry.registration) result = retry
  }
  let registration = result?.registration ?? null
  let how = result?.registration
    ? `fit ${result.medianAbsM.toFixed(2)} m, halves ${result.halvesAgreeM.toFixed(1)} m`
    : ''
  if (!registration) {
    registration = registrationFromGreens(fitInput)
    how = `placed from the greens (${fit.rmsM.toFixed(1)} m)${fine ? '' : ', coarse terrain'}`
  }
  if (!registration) {
    return { registration: null, paired: fit.paired, greensRmsM: fit.rmsM, reason: "GSPro's course could not be placed on the map" }
  }
  const placed = { ...registration, holes: gsproHoleFrames(registration, layout) }
  return {
    registration: placed,
    paired: fit.paired,
    greensRmsM: fit.rmsM,
    reason: `matched ${fit.paired} of ${holesWithGreens} greens on the map area; ${how}`
      + (placed.rotationDeg ? `, turned ${placed.rotationDeg.toFixed(1)}°` : '')
      + (placed.mirrored ? ', mirror-image scene' : ''),
  }
}

// ---------------------------------------------------------------- holes

type Affine = Readonly<{ a: number; b: number; c: number; d: number; e: number; f: number }>
const apply = (t: Affine, p: CoursePointYds): CoursePointYds => [t.a * p[0] + t.b * p[1] + t.c, t.d * p[0] + t.e * p[1] + t.f]
const invert = (t: Affine): Affine => {
  const det = t.a * t.e - t.b * t.d
  return {
    a: t.e / det, b: -t.b / det, c: (t.b * t.f - t.e * t.c) / det,
    d: -t.d / det, e: t.a / det, f: (t.d * t.c - t.a * t.f) / det,
  }
}

/** Area-local yards -> this hole's local yards (linear over a course). */
export const areaToHoleAffine = (area: CourseAreaPackage, registration: NativeRegistration, holeNumber: number): Affine | null => {
  const reg = registrationForHole(registration, holeNumber)
  const map = (p: CoursePointYds) => {
    const [lat, lon] = holeLocalYdsToLatLon(area.frame, p)
    return nativeWorldToHoleLocalYds(registration, holeNumber, nativeLatLonToWorld(reg, lat, lon))
  }
  const o = map([0, 0])
  const x = map([500, 0])
  const y = map([0, 500])
  if (!o || !x || !y) return null
  return {
    a: (x[0] - o[0]) / 500, b: (y[0] - o[0]) / 500, c: o[0],
    d: (x[1] - o[1]) / 500, e: (y[1] - o[1]) / 500, f: o[1],
  }
}

type Box = Readonly<{ minX: number; maxX: number; minY: number; maxY: number }>

const clipToBox = (ring: readonly CoursePointYds[], box: Box): CoursePointYds[] => {
  let pts: CoursePointYds[] = [...ring]
  const edges: Array<[(p: CoursePointYds) => boolean, (a: CoursePointYds, b: CoursePointYds) => CoursePointYds]> = [
    [(p) => p[0] >= box.minX, (a, b) => [box.minX, a[1] + ((box.minX - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]],
    [(p) => p[0] <= box.maxX, (a, b) => [box.maxX, a[1] + ((box.maxX - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]],
    [(p) => p[1] >= box.minY, (a, b) => [a[0] + ((box.minY - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), box.minY]],
    [(p) => p[1] <= box.maxY, (a, b) => [a[0] + ((box.maxY - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), box.maxY]],
  ]
  for (const [inside, cross] of edges) {
    if (!pts.length) break
    const out: CoursePointYds[] = []
    pts.forEach((cur, i) => {
      const prev = pts[(i + pts.length - 1) % pts.length]
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur))
        out.push(cur)
      } else if (inside(prev)) {
        out.push(cross(prev, cur))
      }
    })
    pts = out
  }
  return pts
}

const ringArea = (ring: readonly CoursePointYds[]) => {
  let s = 0
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}

const centroidOf = (ring: readonly CoursePointYds[]): CoursePointYds =>
  [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length]

const overlaps = (ring: readonly CoursePointYds[], box: Box) => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return !(maxX < box.minX || minX > box.maxX || maxY < box.minY || minY > box.maxY)
}

const transformRings = (rings: readonly CoursePolygonYds[], t: Affine, box: Box): CoursePolygonYds[] =>
  rings.flatMap((ring) => {
    const moved = ring.map((p) => apply(t, p))
    if (!overlaps(moved, box)) return []
    const clipped = clipToBox(moved, box)
    return clipped.length >= 3 && ringArea(clipped) >= 20 ? [clipped] : []
  })

const segmentDistance = (p: CoursePointYds, a: CoursePointYds, b: CoursePointYds) => {
  const vx = b[0] - a[0], vy = b[1] - a[1]
  const len = vx * vx + vy * vy
  const t = len > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len)) : 0
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy))
}

/** How close any vertex (or the centroid) of a ring comes to the hole's line. */
const ringToRoute = (ring: readonly CoursePointYds[], route: readonly CoursePointYds[]) => {
  let best = Infinity
  for (const p of [...ring, centroidOf(ring)]) {
    for (let i = 1; i < route.length; i += 1) best = Math.min(best, segmentDistance(p, route[i - 1], route[i]))
  }
  return best
}

/** A fairway this close to the hole's line (tee, GSPro's aim points, green) is this hole's. */
const OWN_FAIRWAY_YDS = 30
/** The map green nearest GSPro's green centre, within this, is this hole's green. */
const OWN_GREEN_YDS = 35
const VIEW_MARGIN_YDS = 40
const TERRAIN_MIN_VALID = 0.9

const resampleTerrain = (area: CourseAreaPackage, toArea: Affine, box: Box): CourseTerrainGrid | null => {
  const t = area.terrain
  if (!t) return null
  const spacing = t.runtimeSpacingYds
  const width = Math.max(2, Math.ceil((box.maxX - box.minX) / spacing) + 1)
  const height = Math.max(2, Math.ceil((box.maxY - box.minY) / spacing) + 1)
  const ft = new Float64Array(width * height).fill(Number.NaN)
  let valid = 0
  let minFt = Infinity
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const [ax, ay] = apply(toArea, [box.minX + col * spacing, box.minY + row * spacing])
      const gx = (ax - t.minX) / spacing
      const gy = (ay - t.minY) / spacing
      if (gx < 0 || gy < 0 || gx > t.width - 1 || gy > t.height - 1) continue
      const ix = Math.min(Math.floor(gx), t.width - 2)
      const iy = Math.min(Math.floor(gy), t.height - 2)
      const v = (cx: number, cy: number) => t.values[cy * t.width + cx]
      const c = [v(ix, iy), v(ix + 1, iy), v(ix, iy + 1), v(ix + 1, iy + 1)]
      if (c.some((x) => x === t.nodata)) continue
      const dx = gx - ix, dy = gy - iy
      const z = ((c[0] * (1 - dx) + c[1] * dx) * (1 - dy) + (c[2] * (1 - dx) + c[3] * dx) * dy) / 10 + t.elevationOffsetFt
      ft[row * width + col] = z
      valid += 1
      if (z < minFt) minFt = z
    }
  }
  if (valid < TERRAIN_MIN_VALID * width * height) return null
  const offset = Math.floor(minFt * 10) / 10
  const values = new Uint16Array(width * height)
  for (let i = 0; i < values.length; i += 1) {
    values[i] = Number.isFinite(ft[i]) ? Math.max(0, Math.min(65534, Math.round((ft[i] - offset) * 10))) : 65535
  }
  return {
    source: t.source === 'global-dem' ? 'global-dem' : 'lidar-dem',
    sourceResolutionMeters: t.sourceResolutionMeters,
    runtimeSpacingYds: spacing,
    interpolation: 'bilinear',
    minX: box.minX,
    minY: box.minY,
    width,
    height,
    elevationOffsetFt: offset,
    nodata: 65535,
    values,
    note: `Course-area ${t.sourceResolutionMeters} m terrain (${spacing} yd), turned into this hole's frame.`,
  }
}

const sampleGridFt = (t: CourseTerrainGrid, x: number, y: number): number | null => {
  const gx = (x - t.minX) / t.runtimeSpacingYds
  const gy = (y - t.minY) / t.runtimeSpacingYds
  if (gx < 0 || gy < 0 || gx > t.width - 1 || gy > t.height - 1) return null
  const ix = Math.min(Math.floor(gx), t.width - 2)
  const iy = Math.min(Math.floor(gy), t.height - 2)
  const c = [t.values[iy * t.width + ix], t.values[iy * t.width + ix + 1],
    t.values[(iy + 1) * t.width + ix], t.values[(iy + 1) * t.width + ix + 1]]
  if (c.some((v) => v === t.nodata)) return null
  const dx = gx - ix, dy = gy - iy
  return ((c[0] * (1 - dx) + c[1] * dx) * (1 - dy) + (c[2] * (1 - dx) + c[3] * dx) * dy) / 10 + t.elevationOffsetFt
}

/** Nearest GSPro heights blended into each cell, and how much they pull (yd^2 softening). */
const CORRECTION_NEIGHBOURS = 8
const CORRECTION_SOFTEN_YD2 = 4

/**
 * Coarse terrain bent to GSPro's own heights: at every GSPro point (tee, aim
 * point, pin, green centre, hazard edge) the grid takes GSPro's height; in
 * between, the coarse model's shape plus the nearest points' corrections
 * (inverse-distance weighted). Null when too few points fall on the grid.
 */
export const correctTerrainToHeights = (
  terrain: CourseTerrainGrid,
  points: ReadonlyArray<Readonly<{ x: number; y: number; ft: number }>>,
): (CourseTerrainGrid & { correctionRmsFt: number }) | null => {
  const res = points.flatMap((p) => {
    const g = sampleGridFt(terrain, p.x, p.y)
    return g == null ? [] : [{ x: p.x, y: p.y, r: p.ft - g }]
  })
  if (res.length < 3) return null
  const rmsFt = Math.sqrt(res.reduce((s, p) => s + p.r * p.r, 0) / res.length)
  const { width, height } = terrain
  const k = Math.min(CORRECTION_NEIGHBOURS, res.length)
  const bestD = new Float64Array(k)
  const bestR = new Float64Array(k)
  const ft = new Float64Array(width * height).fill(Number.NaN)
  let minFt = Infinity
  for (let row = 0; row < height; row += 1) {
    const y = terrain.minY + row * terrain.runtimeSpacingYds
    for (let col = 0; col < width; col += 1) {
      const encoded = terrain.values[row * width + col]
      if (encoded === terrain.nodata) continue
      const x = terrain.minX + col * terrain.runtimeSpacingYds
      let filled = 0
      for (let i = 0; i < res.length; i += 1) {
        const d = (res[i].x - x) ** 2 + (res[i].y - y) ** 2
        if (filled === k && d >= bestD[k - 1]) continue
        let j = filled < k ? filled++ : k - 1
        while (j > 0 && bestD[j - 1] > d) {
          bestD[j] = bestD[j - 1]
          bestR[j] = bestR[j - 1]
          j -= 1
        }
        bestD[j] = d
        bestR[j] = res[i].r
      }
      let sw = 0, sr = 0
      for (let j = 0; j < filled; j += 1) {
        const w = 1 / (bestD[j] + CORRECTION_SOFTEN_YD2)
        sw += w
        sr += w * bestR[j]
      }
      const z = terrain.elevationOffsetFt + encoded / 10 + (sw > 0 ? sr / sw : 0)
      ft[row * width + col] = z
      if (z < minFt) minFt = z
    }
  }
  if (!Number.isFinite(minFt)) return null
  const offset = Math.floor(minFt * 10) / 10
  const values = new Uint16Array(width * height)
  for (let i = 0; i < values.length; i += 1) {
    values[i] = Number.isFinite(ft[i]) ? Math.max(0, Math.min(65534, Math.round((ft[i] - offset) * 10))) : 65535
  }
  return {
    ...terrain,
    elevationOffsetFt: offset,
    values,
    correctionRmsFt: rmsFt,
    note: `${terrain.sourceResolutionMeters} m global terrain, bent to ${res.length} GSPro heights `
      + `(they differed by ${rmsFt.toFixed(1)} ft rms before).`,
  }
}

export const buildAreaHoleGeometry = (input: Readonly<{
  entry: Pick<CourseCatalogEntry, 'id' | 'name' | 'location'>
  layout: NativeCourseLayout
  layouts?: readonly NativeCourseLayout[]
  registration: NativeRegistration
  holeNumber: number
  area: CourseAreaPackage
  altLayoutName?: string | null
}>): CourseHoleGeometry => {
  const base = buildGsproOnlyHoleGeometry(input)
  const { area, registration, holeNumber } = input
  const toHole = areaToHoleAffine(area, registration, holeNumber)
  if (!toHole) return base
  const box: Box = {
    minX: base.bounds.minX - VIEW_MARGIN_YDS, maxX: base.bounds.maxX + VIEW_MARGIN_YDS,
    minY: base.bounds.minY - VIEW_MARGIN_YDS, maxY: base.bounds.maxY + VIEW_MARGIN_YDS,
  }
  const hole = input.layout.holes.find((h) => h.hole === holeNumber)!
  const local = (p: NativeXYZ) => nativeWorldToHoleLocalYds(registration, holeNumber, p)
  const greenCentre = effectiveGreenCenter(hole)?.point
  const greenLocal = greenCentre ? local(greenCentre) : null
  const route = [base.markers.tee, ...hole.aimPoints.map(local), greenLocal]
    .filter((p): p is CoursePointYds => p !== null)

  const byKind = new Map<CourseSurfaceKind, CoursePolygonYds[]>()
  const add = (kind: CourseSurfaceKind, rings: readonly CoursePolygonYds[]) => {
    if (rings.length) byKind.set(kind, [...(byKind.get(kind) ?? []), ...rings])
  }
  let mapGreen = false
  for (const surface of area.surfaces) {
    const rings = transformRings(surface.polygons, toHole, box)
    if (!rings.length) continue
    if (surface.kind === 'fairway') {
      add('fairway', rings.filter((r) => ringToRoute(r, route) <= OWN_FAIRWAY_YDS))
      add('rough', rings.filter((r) => ringToRoute(r, route) > OWN_FAIRWAY_YDS))
    } else if (surface.kind === 'green') {
      // This hole's green: the map green nearest GSPro's green centre.
      const near = greenLocal
        ? rings.map((r) => ({ r, d: Math.hypot(centroidOf(r)[0] - greenLocal[0], centroidOf(r)[1] - greenLocal[1]) }))
        : []
      const own = near.filter((x) => x.d <= OWN_GREEN_YDS).sort((a, b) => a.d - b.d)[0]?.r ?? null
      if (own) { add('green', [own]); mapGreen = true }
      add('rough', rings.filter((r) => r !== own))
    } else {
      add(surface.kind, rings)
    }
  }
  const mapSurfaces: CourseSurface[] = [...byKind.entries()].map(([kind, polygons]) => ({
    id: `${input.entry.id}-h${String(holeNumber).padStart(2, '0')}-area-${kind}`,
    kind,
    polygons,
    provenance: {
      source: 'osm',
      sourceFeature: kind === 'rough' ? 'OSM rough, and other holes\' fairways and greens' : `OSM ${kind} (course area)`,
      confidence: 'high',
      note: "From the course's map area, placed on GSPro's hole.",
    },
  }))
  // GSPro's tee pads stay; the GSPro green disc only when the map has no green here.
  const gsproSurfaces = base.surfaces.filter((s) => s.kind === 'tee' || (s.kind === 'green' && !mapGreen))
  const contextLayers: CourseContextLayer[] = area.contextLayers.flatMap((layer) => {
    const polygons = transformRings(layer.polygons, toHole, box)
    return polygons.length ? [{ ...layer, id: `${layer.id}-h${holeNumber}`, polygons }] : []
  })
  const mapFeatures: CourseMapFeature[] = area.mapFeatures.flatMap((feature) => {
    const polygons = feature.polygons ? transformRings(feature.polygons, toHole, box) : []
    const lines = (feature.lines ?? []).map((line) => line.map((p) => apply(toHole, p)))
      .filter((line) => line.length >= 2 && overlaps(line, box))
    return polygons.length || lines.length
      ? [{ ...feature, id: `${feature.id}-h${holeNumber}`, ...(polygons.length ? { polygons } : {}), ...(lines.length ? { lines } : {}) }]
      : []
  })
  const surfaces = [...gsproSurfaces, ...mapSurfaces]
  const resampled = resampleTerrain(area, invert(toHole), box)
  // Coarse (30 m) terrain takes GSPro's heights where GSPro has them.
  const terrain = resampled && isCoarseTerrain(resampled)
    ? correctTerrainToHeights(resampled, gsproHeightPoints(input.layouts ?? [input.layout], registration, holeNumber))
      ?? resampled
    : resampled ?? base.terrain
  const available = (kind: CourseSurfaceKind): GeometryAvailability =>
    surfaces.some((s) => s.kind === kind) ? 'available' : 'unavailable'
  return {
    ...base,
    surfaces,
    ...(contextLayers.length ? { contextLayers } : {}),
    ...(mapFeatures.length ? { mapFeatures } : {}),
    ...(terrain ? { terrain } : {}),
    availability: {
      tee: 'available', fairway: available('fairway'), rough: available('rough'), 'deep-rough': available('deep-rough'),
      green: 'available', bunker: available('bunker'), water: available('water'), penalty: base.availability.penalty,
    },
    provenance: {
      geometrySource: 'osm-course-area+gspro-course-file',
      attribution: '© OpenStreetMap contributors',
      license: 'ODbL-1.0',
      sourceElementIdsComplete: false,
      note: "Holes from GSPro's course file; fairways, greens, bunkers, water, trees and terrain from the course's map area.",
    },
  }
}
