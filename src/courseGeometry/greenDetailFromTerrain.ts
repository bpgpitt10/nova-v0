/**
 * A green's 1-yd height grid built in the browser from the hole's own terrain, for courses that
 * have no green-detail package: map-area courses (Brian, 24 Nov, 3s Greenville: "Break on the
 * green: no green map here" though the area package carries 2-yd LiDAR over every green).
 *
 * The same contract as tools/build_course_green_detail.py: 1 yd spacing, 12 yd margin round the
 * green, bilinear from the terrain, uint16 deci-feet above an offset, a least-squares plane for the
 * whole green and for a 3x3 of sectors. The packaged builder's --lidar-package route does exactly
 * this from the full-map courses' 2-yd hole terrain, so the two agree where both exist
 * (tools/test-area-green-detail.mjs).
 *
 * Only LiDAR terrain: a 30 m global model can't see a green's tilt.
 */
import type { CourseGreenDetail, GreenDetailSector } from './courseGreenDetail'
import type { CoursePointYds, CoursePolygonYds, CourseTerrainGrid } from './types'

export const AREA_GREEN_SPACING_YDS = 1
export const AREA_GREEN_MARGIN_YDS = 12
/** Coarser terrain than this (metres) doesn't show a green's slopes. */
export const AREA_GREEN_MAX_SOURCE_M = 2
const NODATA = 65535
/** A green with less height change than this is terrain that didn't load, not a level green. */
export const MIN_GREEN_RANGE_FT = 0.15

const ringArea = (ring: CoursePolygonYds) => {
  let total = 0
  for (let i = 0; i < ring.length; i += 1) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % ring.length]
    total += x0 * y1 - x1 * y0
  }
  return Math.abs(total) / 2
}

const inside = (x: number, y: number, ring: CoursePolygonYds) => {
  let hit = false
  let [xj, yj] = ring[ring.length - 1]
  for (const [xi, yi] of ring) {
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) + 1e-12) + xi) hit = !hit
    xj = xi
    yj = yi
  }
  return hit
}

/** Bilinear height in feet, or NaN off the terrain or next to a hole in it. */
export const terrainFt = (t: CourseTerrainGrid, x: number, y: number): number => {
  const gx = (x - t.minX) / t.runtimeSpacingYds
  const gy = (y - t.minY) / t.runtimeSpacingYds
  const c0 = Math.floor(gx)
  const r0 = Math.floor(gy)
  if (c0 < 0 || r0 < 0 || c0 >= t.width - 1 || r0 >= t.height - 1) return Number.NaN
  const v = (c: number, r: number) => t.values[r * t.width + c]
  const c = [v(c0, r0), v(c0 + 1, r0), v(c0, r0 + 1), v(c0 + 1, r0 + 1)]
  if (c.some((value) => value === t.nodata)) return Number.NaN
  const dc = gx - c0
  const dr = gy - r0
  const raw = c[0] * (1 - dc) * (1 - dr) + c[1] * dc * (1 - dr) + c[2] * (1 - dc) * dr + c[3] * dc * dr
  return t.elevationOffsetFt + raw / 10
}

type Plane = Readonly<{
  sampleCount: number
  meanElevationFt: number
  minElevationFt: number
  maxElevationFt: number
  elevationRangeFt: number
  planeSlopePercent: number
  downhillLocalUnit: readonly [number, number]
  downhillBearingDeg: number
}>

const round = (value: number, places: number) => Number(value.toFixed(places))

/** Least-squares plane z = a x + b y + c through the points (x, y in yards, z in feet). */
const planeSummary = (xs: number[], ys: number[], zs: number[]): Plane | null => {
  const n = zs.length
  if (n < 4) return null
  let sx = 0, sy = 0, sz = 0
  for (let i = 0; i < n; i += 1) { sx += xs[i]; sy += ys[i]; sz += zs[i] }
  const mx = sx / n, my = sy / n, mz = sz / n
  let sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx, dy = ys[i] - my, dz = zs[i] - mz
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy; sxz += dx * dz; syz += dy * dz
    if (zs[i] < lo) lo = zs[i]
    if (zs[i] > hi) hi = zs[i]
  }
  const det = sxx * syy - sxy * sxy
  const a = Math.abs(det) > 1e-12 ? (sxz * syy - syz * sxy) / det : 0
  const b = Math.abs(det) > 1e-12 ? (syz * sxx - sxz * sxy) / det : 0
  // Feet per yard over three: percent grade.
  const slopePercent = (Math.hypot(a, b) / 3) * 100
  const norm = Math.hypot(a, b)
  const down: [number, number] = norm > 1e-9 ? [-a / norm, -b / norm] : [0, 0]
  const bearing = norm > 1e-9 ? ((Math.atan2(down[0], down[1]) * 180) / Math.PI + 360) % 360 : 0
  return {
    sampleCount: n,
    meanElevationFt: round(mz, 2),
    minElevationFt: round(lo, 2),
    maxElevationFt: round(hi, 2),
    elevationRangeFt: round(hi - lo, 2),
    planeSlopePercent: round(slopePercent, 2),
    downhillLocalUnit: [round(down[0], 4), round(down[1], 4)],
    downhillBearingDeg: round(bearing, 1),
  }
}

/**
 * The green-detail grid for one hole from its terrain and its green outline (the largest one, as the
 * packaged builder picks). Null without LiDAR terrain or a green, or when the terrain doesn't cover it.
 */
export const greenDetailFromTerrain = (
  holeNumber: number,
  terrain: CourseTerrainGrid | null | undefined,
  greens: readonly CoursePolygonYds[],
): CourseGreenDetail | null => {
  if (!terrain || terrain.source !== 'lidar-dem' || terrain.sourceResolutionMeters > AREA_GREEN_MAX_SOURCE_M) return null
  const green = greens.filter((ring) => ring.length >= 3).sort((p, q) => ringArea(q) - ringArea(p))[0]
  if (!green) return null
  const s = AREA_GREEN_SPACING_YDS
  const gxs = green.map((p) => p[0])
  const gys = green.map((p) => p[1])
  const bounds = [Math.min(...gxs), Math.max(...gxs), Math.min(...gys), Math.max(...gys)] as const
  const minX = Math.floor((bounds[0] - AREA_GREEN_MARGIN_YDS) / s) * s
  const maxX = Math.ceil((bounds[1] + AREA_GREEN_MARGIN_YDS) / s) * s
  const minY = Math.floor((bounds[2] - AREA_GREEN_MARGIN_YDS) / s) * s
  const maxY = Math.ceil((bounds[3] + AREA_GREEN_MARGIN_YDS) / s) * s
  const width = Math.round((maxX - minX) / s) + 1
  const height = Math.round((maxY - minY) / s) + 1
  const ft = new Float64Array(width * height)
  let lowest = Infinity
  const onGreen: { x: number[]; y: number[]; z: number[] } = { x: [], y: [], z: [] }
  const greenCells: Array<{ x: number; y: number; z: number }> = []
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const x = minX + c * s
      const y = minY + r * s
      const z = terrainFt(terrain, x, y)
      ft[r * width + c] = z
      if (!Number.isFinite(z)) continue
      if (z < lowest) lowest = z
      if (inside(x, y, green)) {
        onGreen.x.push(x); onGreen.y.push(y); onGreen.z.push(z)
        greenCells.push({ x, y, z })
      }
    }
  }
  const summary = planeSummary(onGreen.x, onGreen.y, onGreen.z)
  if (!summary || !Number.isFinite(lowest)) return null
  // No real green is level to a tenth of a foot: a flat one is terrain that failed to load
  // (Trosper and Wynn's bundled terrain is one height on every hole). No map beats a wrong one.
  if (summary.elevationRangeFt < MIN_GREEN_RANGE_FT) return null
  const offset = Math.floor(lowest * 10) / 10
  const values = new Uint16Array(width * height)
  for (let i = 0; i < values.length; i += 1) {
    const q = Math.round((ft[i] - offset) * 10)
    values[i] = Number.isFinite(ft[i]) && q >= 0 && q < NODATA ? q : NODATA
  }
  const edges = (lo: number, hi: number) => [0, 1, 2, 3].map((k) => lo + ((hi - lo) * k) / 3)
  const xe = edges(bounds[0], bounds[1])
  const ye = edges(bounds[2], bounds[3])
  const rows = ['front', 'middle', 'back'] as const
  const columns = ['left', 'center', 'right'] as const
  const sectors: GreenDetailSector[] = []
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const these = greenCells.filter((cell) =>
        cell.x >= xe[column] && (column === 2 ? cell.x <= xe[column + 1] : cell.x < xe[column + 1])
        && cell.y >= ye[row] && (row === 2 ? cell.y <= ye[row + 1] : cell.y < ye[row + 1]))
      const plane = planeSummary(these.map((cell) => cell.x), these.map((cell) => cell.y), these.map((cell) => cell.z))
      const base: GreenDetailSector = {
        id: `${rows[row]}-${columns[column]}`,
        row: rows[row],
        column: columns[column],
        boundsYds: [round(xe[column], 1), round(xe[column + 1], 1), round(ye[row], 1), round(ye[row + 1], 1)],
        sampleCount: plane?.sampleCount ?? 0,
      }
      sectors.push(plane ? { ...base, ...plane, deltaFromGreenMeanFt: round(plane.meanElevationFt - summary.meanElevationFt, 2) } : base)
    }
  }
  return {
    holeNumber,
    greenBoundsYds: bounds.map((value) => round(value, 1)) as unknown as CourseGreenDetail['greenBoundsYds'],
    greenSampleCount: summary.sampleCount,
    greenSummary: summary,
    sectors,
    grid: {
      minX,
      minY,
      spacingYds: s,
      width,
      height,
      elevationOffsetFt: round(offset, 1),
      nodata: NODATA,
      values,
    },
  }
}

/** Every green ring of a hole, for picking the target green. */
export const greenRingsOf = (surfaces: ReadonlyArray<{ kind: string; polygons: readonly CoursePolygonYds[] }>): CoursePolygonYds[] =>
  surfaces.filter((surface) => surface.kind === 'green').flatMap((surface) => [...surface.polygons])

export type { CoursePointYds }
