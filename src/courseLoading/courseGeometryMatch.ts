import { effectiveGreenCenter, type NativeCourseLayout } from '../courseGeometry/nativeGkd'
import { groundOffsetMeters } from '../courseGeometry/nativeRegistration'

/**
 * Match an installed GSPro course to its real course by geometry, not name
 * (spec: claude/spec-geometry-course-matching.md, Match 1).
 *
 * The GKD's green centres (GSPro scene metres) are a fingerprint of the
 * course whatever GSPro calls it ("DPC Pebble", "Mammoth Dunes" under Sand
 * Valley). Candidate OpenStreetMap golf courses near the GKD's location are
 * scored by how well their greens line up with GSPro's after the best
 * rotation / scale / mirror: a few metres for the real course, hundreds for
 * a neighbour (Kiawah's other courses).
 */

export type Xy = readonly [number, number]

export type GreenFit = Readonly<{
  rmsM: number
  paired: number
  gkdGreens: number
  scale: number
  rotationDeg: number
  mirrored: boolean
  /** Final pairs: [index into the GSPro greens, index into the map greens]. */
  pairs?: ReadonlyArray<readonly [number, number]>
}>

const PAIR_GATE_FINAL_M = 25
const ICP_GATES_M = [150, 80, 40, PAIR_GATE_FINAL_M, PAIR_GATE_FINAL_M, PAIR_GATE_FINAL_M] as const
const COARSE_STEP_DEG = 15
const VOTE_BIN_M = 40
const VOTE_STARTS = 3

export const ACCEPT_RMS_M = 20
export const ACCEPT_SCALE = [0.9, 1.1] as const
export const acceptPaired = (gkdGreens: number) => Math.max(6, Math.ceil((2 / 3) * gkdGreens))

type Similarity = { c: number; s: number; tx: number; ty: number } // q = [c -s; s c] p + t

const fitSimilarity = (pairs: ReadonlyArray<readonly [Xy, Xy]>): Similarity | null => {
  const n = pairs.length
  if (n < 3) return null
  let px = 0, py = 0, qx = 0, qy = 0
  for (const [p, q] of pairs) { px += p[0]; py += p[1]; qx += q[0]; qy += q[1] }
  px /= n; py /= n; qx /= n; qy /= n
  let a = 0, b = 0, norm = 0
  for (const [p, q] of pairs) {
    const ux = p[0] - px, uy = p[1] - py
    const vx = q[0] - qx, vy = q[1] - qy
    a += ux * vx + uy * vy
    b += ux * vy - uy * vx
    norm += ux * ux + uy * uy
  }
  if (norm <= 0) return null
  const c = a / norm, s = b / norm // scale·cosθ, scale·sinθ
  return { c, s, tx: qx - (c * px - s * py), ty: qy - (s * px + c * py) }
}

const apply = (t: Similarity, p: Xy): Xy => [t.c * p[0] - t.s * p[1] + t.tx, t.s * p[0] + t.c * p[1] + t.ty]

const nearest = (p: Xy, qs: readonly Xy[]) => {
  let best = -1, bestD = Infinity
  for (let i = 0; i < qs.length; i += 1) {
    const d = Math.hypot(qs[i][0] - p[0], qs[i][1] - p[1])
    if (d < bestD) { bestD = d; best = i }
  }
  return { index: best, d: bestD }
}

/**
 * Mutual nearest neighbours within `gate`: a GSPro green and a map green pair
 * only if each is the other's closest. A GSPro green whose real green is
 * missing from the map then stays unpaired instead of grabbing a neighbour.
 */
const mutualPairs = (moved: readonly Xy[], map: readonly Xy[], gate: number): Array<readonly [number, number]> => {
  const pairs: Array<readonly [number, number]> = []
  for (let i = 0; i < moved.length; i += 1) {
    const hit = nearest(moved[i], map)
    if (hit.index < 0 || hit.d > gate) continue
    if (nearest(map[hit.index], moved).index === i) pairs.push([i, hit.index])
  }
  return pairs
}

/**
 * Best fit of GKD greens (scene metres, x east / z north) onto map greens
 * (ground metres east/north), unknown hole numbering: coarse rotations every
 * 15° (plain and mirrored), translations by voting, then iterative
 * closest-point refinement with shrinking gates and mutual pairing; the fit
 * with the lowest truncated squared error over all GSPro greens wins.
 */
export const fitGreens = (gkd: readonly Xy[], map: readonly Xy[]): GreenFit | null => {
  if (gkd.length < 3 || map.length < 3) return null
  let best: (GreenFit & { cost: number }) | null = null
  for (const mirrored of [false, true]) {
    const pts: Xy[] = gkd.map((p) => [mirrored ? -p[0] : p[0], p[1]])
    for (let deg = 0; deg < 360; deg += COARSE_STEP_DEG) {
      const th = (deg * Math.PI) / 180
      const c = Math.cos(th), sn = Math.sin(th)
      // Translation by voting (each GSPro green onto each map green, 40 m
      // bins): stray or missing greens shift a centroid, not the vote.
      const rotated = pts.map((p) => [c * p[0] - sn * p[1], sn * p[0] + c * p[1]] as const)
      const bins = new Map<string, { n: number; x: number; y: number }>()
      for (const r of rotated) {
        for (const q of map) {
          const x = q[0] - r[0], y = q[1] - r[1]
          const key = `${Math.round(x / VOTE_BIN_M)},${Math.round(y / VOTE_BIN_M)}`
          const bin = bins.get(key) ?? { n: 0, x: 0, y: 0 }
          bin.n += 1; bin.x += x; bin.y += y
          bins.set(key, bin)
        }
      }
      const starts = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, VOTE_STARTS)
      for (const start of starts) {
        let t: Similarity = { c, s: sn, tx: start.x / start.n, ty: start.y / start.n }
        for (const gate of ICP_GATES_M) {
          const pairs = mutualPairs(pts.map((p) => apply(t, p)), map, gate).map(([i, j]) => [pts[i], map[j]] as const)
          const next = fitSimilarity(pairs)
          if (!next) break
          t = next
        }
        const moved = pts.map((p) => apply(t, p))
        let sq = 0, paired = 0
        const finalPairs = mutualPairs(moved, map, PAIR_GATE_FINAL_M)
        for (const [i, j] of finalPairs) {
          sq += (moved[i][0] - map[j][0]) ** 2 + (moved[i][1] - map[j][1]) ** 2
          paired += 1
        }
        if (paired < 3) continue
        // Truncated least squares over every GSPro green: rewards many close
        // pairs, not many loose ones.
        const cost = moved.reduce((sum, p) => sum + Math.min(nearest(p, map).d, PAIR_GATE_FINAL_M) ** 2, 0)
        const fit: GreenFit & { cost: number } = {
          cost,
          rmsM: Math.sqrt(sq / paired),
          paired,
          gkdGreens: gkd.length,
          scale: Math.hypot(t.c, t.s),
          rotationDeg: (Math.atan2(t.s, t.c) * 180) / Math.PI,
          mirrored,
          pairs: finalPairs,
        }
        if (!best || fit.cost < best.cost) best = fit
      }
    }
  }
  if (!best) return null
  return {
    rmsM: best.rmsM, paired: best.paired, gkdGreens: best.gkdGreens,
    scale: best.scale, rotationDeg: best.rotationDeg, mirrored: best.mirrored, pairs: best.pairs,
  }
}

export const fitAccepted = (fit: GreenFit | null): boolean =>
  fit != null
  && fit.rmsM <= ACCEPT_RMS_M
  && fit.paired >= acceptPaired(fit.gkdGreens)
  && fit.scale >= ACCEPT_SCALE[0] && fit.scale <= ACCEPT_SCALE[1]

/** GSPro green centres (pins' centroid where the designer's is missing) for the fingerprint. */
export const gkdGreenPoints = (layout: NativeCourseLayout): Xy[] =>
  layout.holes
    .map((h) => effectiveGreenCenter(h)?.point ?? null)
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => [p.x, p.z] as const)

// ---------------------------------------------------------------- candidates

export type OsmCourseCandidate = Readonly<{
  osmType: 'way' | 'relation'
  osmId: number
  name: string
  centre: readonly [number, number] // lat, lon
  /** Outline bbox [south, west, north, east]. */
  bbox: readonly [number, number, number, number]
}>

export type MapGreen = readonly [number, number] // lat, lon

export type GeometryMatchResult = Readonly<{
  status: 'matched' | 'ambiguous' | 'no-fit' | 'no-candidates'
  best: (OsmCourseCandidate & { fit: GreenFit }) | null
  runnerUp: (OsmCourseCandidate & { fit: GreenFit }) | null
}>

/** Greens within the candidate's outline box plus a margin (outlines are often incomplete). */
const greensNear = (candidate: OsmCourseCandidate, greens: readonly MapGreen[], marginM = 300): MapGreen[] => {
  const [s, w, n, e] = candidate.bbox
  const dLat = marginM / 110_540
  const dLon = marginM / (111_320 * Math.cos((candidate.centre[0] * Math.PI) / 180))
  return greens.filter(([lat, lon]) => lat >= s - dLat && lat <= n + dLat && lon >= w - dLon && lon <= e + dLon)
}

/** Score every candidate; the best accepted fit wins, unless another accepted one is within 10 m rms. */
export const matchCourseByGreens = (
  gkd: readonly Xy[],
  candidates: readonly OsmCourseCandidate[],
  greens: readonly MapGreen[],
): GeometryMatchResult => {
  if (!candidates.length) return { status: 'no-candidates', best: null, runnerUp: null }
  const scored = candidates.flatMap((candidate) => {
    const near = greensNear(candidate, greens)
    if (near.length < 6) return []
    const [lat0, lon0] = candidate.centre
    const map = near.map(([lat, lon]) => groundOffsetMeters(lat0, lon0, lat, lon) as unknown as Xy)
    const fit = fitGreens(gkd, map)
    return fit ? [{ ...candidate, fit }] : []
  }).sort((a, b) => (b.fit.paired - a.fit.paired) || (a.fit.rmsM - b.fit.rmsM))
  const accepted = scored.filter((c) => fitAccepted(c.fit))
  if (!accepted.length) return { status: 'no-fit', best: scored[0] ?? null, runnerUp: scored[1] ?? null }
  const [best, second] = accepted
  // Two outlines over the same greens (a resort and its course) are the same match.
  const sameGreens = second && Math.hypot(
    (best.centre[0] - second.centre[0]) * 110_540,
    (best.centre[1] - second.centre[1]) * 111_320 * Math.cos((best.centre[0] * Math.PI) / 180)) < 400
  if (second && !sameGreens && Math.abs(second.fit.rmsM - best.fit.rmsM) < 10 && second.fit.paired === best.fit.paired) {
    return { status: 'ambiguous', best, runnerUp: second }
  }
  return { status: 'matched', best, runnerUp: second ?? null }
}

// ---------------------------------------------------------------- Overpass

// Tried in turn, each with a time limit: on 11/4 overpass-api.de was
// overloaded for hours and a request without a limit hung the Load page.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
const OVERPASS_TIMEOUT_MS = 45_000

/** No Overpass server answered in time: not "no match". */
export class MapServerBusyError extends Error {}

type OverpassElement = {
  type: string
  id: number
  tags?: Record<string, string>
  center?: { lat: number; lon: number }
  geometry?: Array<{ lat: number; lon: number }>
  members?: Array<{ role?: string; geometry?: Array<{ lat: number; lon: number }> }>
}

/** Golf courses and greens within `radiusM` of a point, from Overpass. */
export const fetchCoursesAndGreens = async (
  centre: readonly [number, number],
  radiusM = 8000,
): Promise<{ candidates: OsmCourseCandidate[]; greens: MapGreen[] }> => {
  const [lat, lon] = centre
  const query = `[out:json][timeout:50];`
    + `(way["leisure"="golf_course"](around:${radiusM},${lat},${lon});`
    + `relation["leisure"="golf_course"](around:${radiusM},${lat},${lon}););out tags geom;`
    + `way["golf"="green"](around:${radiusM},${lat},${lon});out center;`
  let payload: { elements?: OverpassElement[] } | null = null
  let lastError: unknown = null
  for (const url of OVERPASS_URLS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS)
    try {
      const response = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: controller.signal })
      if (!response.ok) throw new Error(`Overpass ${response.status}`)
      payload = await response.json()
      break
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
  }
  if (!payload) {
    throw new MapServerBusyError(`No OpenStreetMap server answered (${lastError instanceof Error ? lastError.message : 'timeout'}).`)
  }
  const candidates: OsmCourseCandidate[] = []
  const greens: MapGreen[] = []
  for (const el of payload.elements ?? []) {
    if (el.tags?.golf === 'green' && el.center) {
      greens.push([el.center.lat, el.center.lon])
      continue
    }
    if (el.tags?.leisure !== 'golf_course' || (el.type !== 'way' && el.type !== 'relation')) continue
    const points = el.type === 'way'
      ? el.geometry ?? []
      : (el.members ?? []).filter((m) => (m.role ?? 'outer') === 'outer').flatMap((m) => m.geometry ?? [])
    if (points.length < 3) continue
    const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon)
    candidates.push({
      osmType: el.type,
      osmId: el.id,
      name: el.tags?.name ?? `Golf course ${el.id}`,
      centre: [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2],
      bbox: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)],
    })
  }
  return { candidates, greens }
}
