import type { NativeXYZ } from './nativeGkd'
import {
  latLonToHoleLocalYds,
  type NativeHoleFrame,
  type NativeRegistration,
} from './nativeRegistration'
import type { CourseTerrainGrid } from './types'

/**
 * Register a player's GSPro course to the real world, in the browser, so a
 * newly loaded course needs no server step with the player's GKD.
 *
 * GSPro x/z are true-north ground metres (FarmLinks: the free fit's rotation
 * matched the map's grid convergence to 0.001 deg). So the model has three
 * unknowns: where the GSPro origin sits (x0, z0 at a reference lat/lon) and
 * the height offset dy. They are found by matching GKD pin and green-centre
 * heights to the course's LiDAR terrain: a 0.5 m grid search, then robust
 * (pseudo-Huber) Gauss-Newton.
 *
 * Offline check against the 1 m Python fit on FarmLinks: with terrain at 2 m
 * the result moves 4 cm, at 3 m 7 cm (grade A both). Tee markers and aim
 * points are NOT used: tee markers sit about 1 m above the ground and moved
 * the fit by 4 m.
 */

const DEG = Math.PI / 180
const FT_TO_M = 0.3048
const ELLIPSOID_A = 6378137.0
const ELLIPSOID_F = 1 / 298.257222101
const ELLIPSOID_E2 = ELLIPSOID_F * (2 - ELLIPSOID_F)

const radii = (latDeg: number) => {
  const s = Math.sin(latDeg * DEG)
  const w = Math.sqrt(1 - ELLIPSOID_E2 * s * s)
  return { meridian: ELLIPSOID_A * (1 - ELLIPSOID_E2) / (w * w * w), primeVertical: ELLIPSOID_A / w }
}

export type TerrainSampler = (lat: number, lon: number) => number | null

/** Bilinear ground height (metres) from Looper per-hole terrain grids. */
export const terrainSamplerFromHoles = (
  holes: ReadonlyArray<Readonly<{ frame: NativeHoleFrame; terrain: CourseTerrainGrid }>>,
): TerrainSampler => (lat, lon) => {
  for (const { frame, terrain: t } of holes) {
    const [x, y] = latLonToHoleLocalYds(frame, lat, lon)
    const fx = (x - t.minX) / t.runtimeSpacingYds
    const fy = (y - t.minY) / t.runtimeSpacingYds
    if (fx < 0 || fy < 0 || fx > t.width - 1 || fy > t.height - 1) continue
    const ix = Math.min(Math.floor(fx), t.width - 2)
    const iy = Math.min(Math.floor(fy), t.height - 2)
    const v = (cx: number, cy: number) => t.values[cy * t.width + cx]
    const corners = [v(ix, iy), v(ix + 1, iy), v(ix, iy + 1), v(ix + 1, iy + 1)]
    if (corners.some((c) => c === t.nodata)) continue
    const ax = fx - ix
    const ay = fy - iy
    const top = corners[0] * (1 - ax) + corners[1] * ax
    const bottom = corners[2] * (1 - ax) + corners[3] * ax
    return ((top * (1 - ay) + bottom * ay) / 10 + t.elevationOffsetFt) * FT_TO_M
  }
  return null
}

/** Scene placement: reference point in world metres, plus the scene's turn
 * (degrees, counter-clockwise from GSPro +x/+z onto east/north) and scale. */
type Params = Readonly<{ x0: number; z0: number; rotationDeg: number; scale: number }>

const makeProjector = (refLat: number, refLon: number, mirrored = false) => {
  const { meridian, primeVertical } = radii(refLat)
  const cosLat = Math.cos(refLat * DEG)
  return (p: Params, x: number, z: number): readonly [number, number] => {
    const c = Math.cos(p.rotationDeg * DEG) * p.scale
    const s = Math.sin(p.rotationDeg * DEG) * p.scale
    const dx = (mirrored ? -1 : 1) * (x - p.x0)
    const dz = z - p.z0
    const east = c * dx - s * dz
    const north = s * dx + c * dz
    return [refLat + (north / meridian) / DEG, refLon + (east / (primeVertical * cosLat)) / DEG]
  }
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

type Residuals = Readonly<{ r: number[]; dy: number; valid: number }>

const residualsFor = (
  project: ReturnType<typeof makeProjector>,
  sampler: TerrainSampler,
  points: readonly NativeXYZ[],
  p: Params,
  dy?: number,
): Residuals => {
  const raw: number[] = []
  for (const q of points) {
    const [lat, lon] = project(p, q.x, q.z)
    const g = sampler(lat, lon)
    raw.push(g == null ? Number.NaN : g - q.y)
  }
  const finite = raw.filter(Number.isFinite)
  const offset = dy ?? (finite.length ? median(finite) : 0)
  return { r: raw.map((v) => v - offset), dy: offset, valid: finite.length }
}

const pseudoHuber = (r: number[], delta = 1) => {
  let sum = 0
  let n = 0
  for (const v of r) {
    if (!Number.isFinite(v)) continue
    const a = Math.min(Math.abs(v), 10)
    sum += delta * delta * (Math.sqrt(1 + (a / delta) ** 2) - 1)
    n += 1
  }
  return n ? sum / n : Number.POSITIVE_INFINITY
}

/** Fit (x0, z0, dy), and with `turn` also the scene's rotation and scale.
 * Returns null if too few points land on terrain. */
const fitParams = (
  project: ReturnType<typeof makeProjector>,
  sampler: TerrainSampler,
  points: readonly NativeXYZ[],
  start: Params,
  searchM = 15,
  turn = false,
): { p: Params; dy: number } | null => {
  let best: { cost: number; p: Params } | null = null
  for (let dx = -searchM; dx <= searchM + 1e-9; dx += 0.5) {
    for (let dz = -searchM; dz <= searchM + 1e-9; dz += 0.5) {
      const p = { ...start, x0: start.x0 + dx, z0: start.z0 + dz }
      const res = residualsFor(project, sampler, points, p)
      if (res.valid < 0.8 * points.length) continue
      const cost = pseudoHuber(res.r)
      if (!best || cost < best.cost) best = { cost, p }
    }
  }
  if (!best) return null
  // Robust Gauss-Newton with numeric derivatives on (x0, z0, dy), then (for a
  // turned scene) on (x0, z0, rotation, scale, dy): the greens only give the
  // turn to ~0.1-0.2°, which is ~2-3 m at the far end of a course.
  let p = best.p
  let dy = residualsFor(project, sampler, points, p).dy
  const stages: ReadonlyArray<ReadonlyArray<keyof Params>> = turn
    ? [['x0', 'z0'], ['x0', 'z0', 'rotationDeg', 'scale']]
    : [['x0', 'z0']]
  const steps: Readonly<Record<keyof Params, number>> = { x0: 0.05, z0: 0.05, rotationDeg: 0.002, scale: 2e-5 }
  const done: Readonly<Record<keyof Params, number>> = { x0: 1e-4, z0: 1e-4, rotationDeg: 1e-6, scale: 1e-8 }
  for (const keys of stages) {
    for (let iter = 0; iter < 25; iter += 1) {
      const base = residualsFor(project, sampler, points, p, dy).r
      const nudged = keys.map((k) => residualsFor(project, sampler, points, { ...p, [k]: p[k] + steps[k] }, dy).r)
      // Normal equations J^T W J d = -J^T W r; last column d/ddy = -1.
      const n = keys.length + 1
      const A = Array.from({ length: n }, () => new Array<number>(n).fill(0))
      const b = new Array<number>(n).fill(0)
      for (let i = 0; i < base.length; i += 1) {
        const r = base[i]
        if (!Number.isFinite(r) || nudged.some((rk) => !Number.isFinite(rk[i]))) continue
        const j = [...keys.map((k, c) => (nudged[c][i] - r) / steps[k]), -1]
        const w = 1 / Math.sqrt(1 + (r / 0.5) ** 2) // soft-L1 weight, f_scale 0.5 m
        for (let a = 0; a < n; a += 1) {
          b[a] -= w * j[a] * r
          for (let c = 0; c < n; c += 1) A[a][c] += w * j[a] * j[c]
        }
      }
      const step = solveLinear(A, b)
      if (!step) break
      const next: { -readonly [K in keyof Params]: number } = { ...p }
      keys.forEach((k, c) => { next[k] = p[k] + step[c] })
      p = next
      dy += step[n - 1]
      if (keys.every((k, c) => Math.abs(step[c]) < done[k]) && Math.abs(step[n - 1]) < 1e-4) break
    }
  }
  return { p, dy }
}

/** Weakest-direction terrain slope signal at the solution: the smaller
 * eigenvalue of the mean (J^T J) for (x0, z0). Flat ground gives ~0, which
 * means the heights cannot pin down the position (any placement fits). */
const horizontalInformation = (
  project: ReturnType<typeof makeProjector>,
  sampler: TerrainSampler,
  points: readonly NativeXYZ[],
  p: Params,
  dy: number,
) => {
  const h = 0.25
  const base = residualsFor(project, sampler, points, p, dy).r
  const rx = residualsFor(project, sampler, points, { ...p, x0: p.x0 + h }, dy).r
  const rz = residualsFor(project, sampler, points, { ...p, z0: p.z0 + h }, dy).r
  let a = 0, b = 0, c = 0, n = 0
  for (let i = 0; i < base.length; i += 1) {
    if (![base[i], rx[i], rz[i]].every(Number.isFinite)) continue
    const jx = (rx[i] - base[i]) / h
    const jz = (rz[i] - base[i]) / h
    a += jx * jx; b += jx * jz; c += jz * jz; n += 1
  }
  if (!n) return 0
  a /= n; b /= n; c /= n
  return (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b)
}

/** Required slope signal: about 1% rms grade in the weakest direction. */
const MIN_HORIZONTAL_INFORMATION = 1e-4

const solveLinear = (A: number[][], b: number[]): number[] | null => {
  const n = b.length
  const m = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c += 1) {
    let pivot = c
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r
    if (Math.abs(m[pivot][c]) < 1e-12) return null
    ;[m[c], m[pivot]] = [m[pivot], m[c]]
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue
      const f = m[r][c] / m[c][c]
      for (let k = c; k <= n; k += 1) m[r][k] -= f * m[c][k]
    }
  }
  return m.map((row, i) => row[n] / row[i])
}

export type NativeRegistrationFitInput = Readonly<{
  courseId: string
  gsproCourseKey: string
  layoutFingerprint: string
  sceneFingerprint: string
  /** GKD pins and green centres (GSPro world metres; y up). */
  points: readonly NativeXYZ[]
  /** GKD green centre <-> mapped green centre, per hole, for the starting guess. */
  greens: ReadonlyArray<Readonly<{ world: Readonly<{ x: number; z: number }>; latLon: readonly [number, number] }>>
  holes: Readonly<Record<string, NativeHoleFrame>>
  sampler: TerrainSampler
  /** Scene built mirror-image (x runs west). */
  mirrored?: boolean
  /** Scene rotation and scale from the green-to-green fit (default 0° / 1). */
  rotationDeg?: number
  scale?: number
}>

export type NativeRegistrationFitResult = Readonly<{
  registration: NativeRegistration | null
  grade: 'A' | 'B' | 'C'
  medianAbsM: number
  halvesAgreeM: number
  points: number
}>

/** Fit, grade and produce a registration file (no GKD geometry in it). */
export const fitNativeRegistration = (input: NativeRegistrationFitInput): NativeRegistrationFitResult => {
  const fail = (medianAbsM = Number.POSITIVE_INFINITY, halvesAgreeM = Number.POSITIVE_INFINITY) =>
    ({ registration: null, grade: 'C' as const, medianAbsM, halvesAgreeM, points: input.points.length })
  if (input.greens.length < 3 || input.points.length < 20) return fail()
  const refLat = input.greens.reduce((s, g) => s + g.latLon[0], 0) / input.greens.length
  const refLon = input.greens.reduce((s, g) => s + g.latLon[1], 0) / input.greens.length
  const turn = input.rotationDeg != null || input.scale != null
  const project = makeProjector(refLat, refLon, input.mirrored === true)
  const start: Params = {
    x0: input.greens.reduce((s, g) => s + g.world.x, 0) / input.greens.length,
    z0: input.greens.reduce((s, g) => s + g.world.z, 0) / input.greens.length,
    rotationDeg: input.rotationDeg ?? 0,
    scale: input.scale ?? 1,
  }
  const full = fitParams(project, input.sampler, input.points, start, 15, turn)
  if (!full) return fail()
  const res = residualsFor(project, input.sampler, input.points, full.p, full.dy)
  const medianAbsM = median(res.r.filter(Number.isFinite).map(Math.abs))

  // Held-out halves (west / east of the median x): both must put the course
  // in the same place.
  const mx = median(input.points.map((q) => q.x))
  const west = fitParams(project, input.sampler, input.points.filter((q) => q.x < mx), full.p, 3)
  const east = fitParams(project, input.sampler, input.points.filter((q) => q.x >= mx), full.p, 3)
  const halvesAgreeM = west && east ? Math.hypot(west.p.x0 - east.p.x0, west.p.z0 - east.p.z0) : Number.POSITIVE_INFINITY

  if (horizontalInformation(project, input.sampler, input.points, full.p, full.dy) < MIN_HORIZONTAL_INFORMATION) {
    return fail(medianAbsM, halvesAgreeM)
  }
  // Pins and green centres sit on fairly flat greens, so half a course pins
  // its own position less firmly than the whole: a very tight height fit
  // (Royal New Kent: 7 cm median) with halves ~2 m apart is still grade B.
  const grade = medianAbsM <= 0.15 && halvesAgreeM <= 0.5 ? 'A'
    : (medianAbsM <= 0.35 && halvesAgreeM <= 1.5) || (medianAbsM <= 0.15 && halvesAgreeM <= 2.5) ? 'B' : 'C'
  if (grade === 'C') return fail(medianAbsM, halvesAgreeM)
  return {
    grade,
    medianAbsM,
    halvesAgreeM,
    points: input.points.length,
    registration: {
      schemaVersion: 'looper-native-registration-v1',
      courseId: input.courseId,
      gsproCourseKey: input.gsproCourseKey,
      layoutFingerprint: input.layoutFingerprint,
      sceneFingerprint: input.sceneFingerprint,
      grade,
      reference: { latLon: [refLat, refLon], worldXZ: [full.p.x0, full.p.z0] },
      ...(turn ? { rotationDeg: full.p.rotationDeg, scale: full.p.scale } : {}),
      ...(input.mirrored ? { mirrored: true } : {}),
      worldYToElevationOffsetM: full.dy,
      holes: input.holes,
    },
  }
}

/**
 * Placement from the green-to-green fit alone, for a course whose greens line
 * up to a few metres but whose terrain doesn't match GSPro's heights (Wynn,
 * 11/4: greens 2.6 m rms, height fit 1.6 m; the map's elevation likely
 * predates the 2019 rebuild). The greens' centroids are matched, rotation and
 * scale come from the caller (the green fit), and the height offset is the
 * median over the points that land on terrain. Graded B.
 */
export const registrationFromGreens = (input: NativeRegistrationFitInput): NativeRegistration | null => {
  if (input.greens.length < 3) return null
  const refLat = input.greens.reduce((s, g) => s + g.latLon[0], 0) / input.greens.length
  const refLon = input.greens.reduce((s, g) => s + g.latLon[1], 0) / input.greens.length
  const turn = input.rotationDeg != null || input.scale != null
  const project = makeProjector(refLat, refLon, input.mirrored === true)
  const p: Params = {
    x0: input.greens.reduce((s, g) => s + g.world.x, 0) / input.greens.length,
    z0: input.greens.reduce((s, g) => s + g.world.z, 0) / input.greens.length,
    rotationDeg: input.rotationDeg ?? 0,
    scale: input.scale ?? 1,
  }
  const res = residualsFor(project, input.sampler, input.points, p)
  if (!Number.isFinite(res.dy) || res.valid < Math.min(10, input.points.length)) return null
  return {
    schemaVersion: 'looper-native-registration-v1',
    courseId: input.courseId,
    gsproCourseKey: input.gsproCourseKey,
    layoutFingerprint: input.layoutFingerprint,
    sceneFingerprint: input.sceneFingerprint,
    grade: 'B',
    reference: { latLon: [refLat, refLon], worldXZ: [p.x0, p.z0] },
    ...(turn ? { rotationDeg: p.rotationDeg, scale: p.scale } : {}),
    ...(input.mirrored ? { mirrored: true } : {}),
    worldYToElevationOffsetM: res.dy,
    holes: input.holes,
  }
}

/**
 * A course whose GSPro scene places groups of holes apart from each other
 * (Kiawah: the back nine 2.8 km from where it really is): fit each group on
 * its own (heights, else greens) and join them into one registration. The
 * first group is the registration's own placement; the rest are holeGroups.
 * Null if any group can't be placed. Grade: the weaker of the groups.
 */
export const fitHoleGroups = (
  groups: ReadonlyArray<Readonly<{ holes: readonly number[]; input: NativeRegistrationFitInput }>>,
): NativeRegistration | null => {
  if (groups.length < 2) return null
  const fits = groups.map((group) => {
    const fit = fitNativeRegistration(group.input)
    if (fit.registration) return fit.registration
    return registrationFromGreens(group.input)
  })
  if (fits.some((fit) => !fit)) return null
  const placed = fits as NativeRegistration[]
  const grade = placed.some((fit) => fit.grade === 'B') ? 'B' : 'A'
  return {
    ...placed[0],
    grade,
    holeGroups: placed.slice(1).map((fit, i) => ({
      holes: [...groups[i + 1].holes],
      reference: fit.reference,
      ...(fit.rotationDeg != null ? { rotationDeg: fit.rotationDeg } : {}),
      ...(fit.scale != null ? { scale: fit.scale } : {}),
      ...(fit.mirrored ? { mirrored: true } : {}),
      worldYToElevationOffsetM: fit.worldYToElevationOffsetM,
    })),
  }
}
