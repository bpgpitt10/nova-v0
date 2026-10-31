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

type Params = Readonly<{ x0: number; z0: number }>

const makeProjector = (refLat: number, refLon: number) => {
  const { meridian, primeVertical } = radii(refLat)
  const cosLat = Math.cos(refLat * DEG)
  return (p: Params, x: number, z: number): readonly [number, number] => [
    refLat + ((z - p.z0) / meridian) / DEG,
    refLon + ((x - p.x0) / (primeVertical * cosLat)) / DEG,
  ]
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

/** Fit (x0, z0, dy). Returns null if too few points land on terrain. */
const fitParams = (
  project: ReturnType<typeof makeProjector>,
  sampler: TerrainSampler,
  points: readonly NativeXYZ[],
  start: Params,
  searchM = 15,
): { p: Params; dy: number } | null => {
  let best: { cost: number; p: Params } | null = null
  for (let dx = -searchM; dx <= searchM + 1e-9; dx += 0.5) {
    for (let dz = -searchM; dz <= searchM + 1e-9; dz += 0.5) {
      const p = { x0: start.x0 + dx, z0: start.z0 + dz }
      const res = residualsFor(project, sampler, points, p)
      if (res.valid < 0.8 * points.length) continue
      const cost = pseudoHuber(res.r)
      if (!best || cost < best.cost) best = { cost, p }
    }
  }
  if (!best) return null
  // Robust Gauss-Newton on (x0, z0, dy) with numeric derivatives.
  let p = best.p
  let dy = residualsFor(project, sampler, points, p).dy
  const h = 0.05
  for (let iter = 0; iter < 25; iter += 1) {
    const base = residualsFor(project, sampler, points, p, dy).r
    const rx = residualsFor(project, sampler, points, { x0: p.x0 + h, z0: p.z0 }, dy).r
    const rz = residualsFor(project, sampler, points, { x0: p.x0, z0: p.z0 + h }, dy).r
    // Normal equations J^T W J d = -J^T W r, J columns: d/dx0, d/dz0, d/ddy (= -1).
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    const b = [0, 0, 0]
    for (let i = 0; i < base.length; i += 1) {
      const r = base[i]
      if (!Number.isFinite(r) || !Number.isFinite(rx[i]) || !Number.isFinite(rz[i])) continue
      const j = [(rx[i] - r) / h, (rz[i] - r) / h, -1]
      const w = 1 / Math.sqrt(1 + (r / 0.5) ** 2) // soft-L1 weight, f_scale 0.5 m
      for (let a = 0; a < 3; a += 1) {
        b[a] -= w * j[a] * r
        for (let c = 0; c < 3; c += 1) A[a][c] += w * j[a] * j[c]
      }
    }
    const step = solve3(A, b)
    if (!step) break
    p = { x0: p.x0 + step[0], z0: p.z0 + step[1] }
    dy += step[2]
    if (Math.hypot(step[0], step[1]) < 1e-4 && Math.abs(step[2]) < 1e-4) break
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
  const rx = residualsFor(project, sampler, points, { x0: p.x0 + h, z0: p.z0 }, dy).r
  const rz = residualsFor(project, sampler, points, { x0: p.x0, z0: p.z0 + h }, dy).r
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

const solve3 = (A: number[][], b: number[]): number[] | null => {
  const m = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < 3; c += 1) {
    let pivot = c
    for (let r = c + 1; r < 3; r += 1) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r
    if (Math.abs(m[pivot][c]) < 1e-12) return null
    ;[m[c], m[pivot]] = [m[pivot], m[c]]
    for (let r = 0; r < 3; r += 1) {
      if (r === c) continue
      const f = m[r][c] / m[c][c]
      for (let k = c; k < 4; k += 1) m[r][k] -= f * m[c][k]
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]]
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
  const project = makeProjector(refLat, refLon)
  const start = {
    x0: input.greens.reduce((s, g) => s + g.world.x, 0) / input.greens.length,
    z0: input.greens.reduce((s, g) => s + g.world.z, 0) / input.greens.length,
  }
  const full = fitParams(project, input.sampler, input.points, start)
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
  const grade = medianAbsM <= 0.15 && halvesAgreeM <= 0.5 ? 'A'
    : medianAbsM <= 0.35 && halvesAgreeM <= 1.5 ? 'B' : 'C'
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
      worldYToElevationOffsetM: full.dy,
      holes: input.holes,
    },
  }
}
