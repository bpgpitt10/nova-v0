import type { CourseGreenDetail } from '../courseGeometry/courseGreenDetail'
import { pointInPolygon } from '../courseGeometry/geometry'
import type { CoursePointYds, CoursePolygonYds } from '../courseGeometry/types'
import { encodePngRgba } from './hillshade'

/**
 * Reads a green from its 1-yd LiDAR grid the way a player would:
 *  - how steep each spot is (each square against its neighbours, after ~3 yd
 *    smoothing so LiDAR speckle doesn't show as slope);
 *  - the overall tilt (a plane fitted to the whole green);
 *  - shapes on top of the tilt: tiers (a band clearly steeper than the rest
 *    with a real step in height) and spines (ground that falls away on both
 *    sides of it).
 * Everything is in hole-local yards (+x right, +y forward).
 */

export type GreenFeature = {
  kind: 'tier' | 'spine'
  /** Tier: height of the step, ft. Spine: 0. */
  riseFt: number
  /** Where to hang the label (centre of the feature). */
  at: CoursePointYds
  /** Downhill direction across the feature (unit). */
  downhill: CoursePointYds
  areaSqYds: number
}

export type GreenReadAnalysis = {
  tiltPercent: number
  /** Unit vector of the overall downhill direction (null when flat). */
  tiltDownhill: CoursePointYds | null
  features: GreenFeature[]
  /** Smoothed slope % per grid cell (NaN off the green). */
  slopePercent: Float32Array
  /** Smoothed elevation ft per grid cell. */
  elevationFt: Float32Array
  /** Smoothed downhill unit vector per grid cell. */
  downhillX: Float32Array
  downhillY: Float32Array
  inside: Uint8Array
  grid: { minX: number; minY: number; spacingYds: number; width: number; height: number }
}

const SMOOTH_SIGMA_CELLS = 1.6
const MIN_FEATURE_SQ_YDS = 20
const MIN_TIER_RISE_FT = 0.5
const TIER_PROBE_YDS = 7
const SPINE_PROBE_YDS = 3
const SPINE_MIN_SIDE_PERCENT = 1.5
export const FLAT_PERCENT = 1

const gaussianKernel = (sigma: number) => {
  const r = Math.ceil(sigma * 3)
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)))
  const sum = k.reduce((a, b) => a + b, 0)
  return { r, k: k.map((v) => v / sum) }
}

const smooth = (z: Float64Array, w: number, h: number, sigma: number) => {
  const { r, k } = gaussianKernel(sigma)
  const tmp = new Float64Array(w * h)
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0
      for (let i = -r; i <= r; i += 1) s += k[i + r] * z[y * w + Math.min(w - 1, Math.max(0, x + i))]
      tmp[y * w + x] = s
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0
      for (let i = -r; i <= r; i += 1) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]
      out[y * w + x] = s
    }
  }
  return out
}

/**
 * Central differences (one-sided at the edges), like numpy.gradient. With a
 * mask, a neighbour outside it is not used (one-sided against the inside).
 */
const gradient = (f: ArrayLike<number>, w: number, h: number, step: number, mask?: Uint8Array) => {
  const gx = new Float64Array(w * h)
  const gy = new Float64Array(w * h)
  const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && (!mask || mask[y * w + x] === 1)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x
      const x0 = ok(x - 1, y) ? x - 1 : x
      const x1 = ok(x + 1, y) ? x + 1 : x
      const y0 = ok(x, y - 1) ? y - 1 : y
      const y1 = ok(x, y + 1) ? y + 1 : y
      gx[i] = x1 > x0 ? (f[y * w + x1] - f[y * w + x0]) / ((x1 - x0) * step) : 0
      gy[i] = y1 > y0 ? (f[y1 * w + x] - f[y0 * w + x]) / ((y1 - y0) * step) : 0
    }
  }
  return { gx, gy }
}

/** 4-connected components of a mask. */
const components = (mask: Uint8Array, w: number, h: number): number[][] => {
  const seen = new Uint8Array(mask.length)
  const out: number[][] = []
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue
    const cells: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      cells.push(i)
      const x = i % w
      const y = (i - x) / w
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (mask[j] && !seen[j]) {
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    out.push(cells)
  }
  return out
}

export const analyzeGreen = (
  detail: CourseGreenDetail,
  greenPolygons: readonly CoursePolygonYds[],
): GreenReadAnalysis | null => {
  const { minX, minY, spacingYds: s, width: w, height: h, values, nodata, elevationOffsetFt } = detail.grid
  if (w < 4 || h < 4 || !(s > 0) || !greenPolygons.length) return null
  const n = w * h
  const inside = new Uint8Array(n)
  const raw = new Float64Array(n)
  let sum = 0
  let count = 0
  for (let i = 0; i < n; i += 1) {
    const v = values[i]
    if (v === nodata || v == null) {
      raw[i] = Number.NaN
      continue
    }
    raw[i] = elevationOffsetFt + v / 10
    sum += raw[i]
    count += 1
  }
  if (!count) return null
  const mean = sum / count
  for (let i = 0; i < n; i += 1) if (!Number.isFinite(raw[i])) raw[i] = mean
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p: CoursePointYds = [minX + x * s, minY + y * s]
      if (greenPolygons.some((poly) => pointInPolygon(p, poly))) inside[y * w + x] = 1
    }
  }
  // Drop the outer yard: mapped green outlines are rarely exact, and the
  // squares on the line often catch the collar or the bank beyond it.
  const core = new Uint8Array(n)
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x
      core[i] = inside[i] && inside[i - 1] && inside[i + 1] && inside[i - w] && inside[i + w] ? 1 : 0
    }
  }
  if (core.reduce((a, b) => a + b, 0) >= 40) inside.set(core)
  const insideCount = inside.reduce((a, b) => a + b, 0)
  if (insideCount < 10) return null

  // Smooth and difference using green squares only, so the banks, bunkers
  // and water around the edge don't leak into the green's slopes.
  const masked = new Float64Array(n)
  const weight = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    masked[i] = inside[i] ? raw[i] : 0
    weight[i] = inside[i]
  }
  const num = smooth(masked, w, h, SMOOTH_SIGMA_CELLS)
  const den = smooth(weight, w, h, SMOOTH_SIGMA_CELLS)
  const zs = new Float64Array(n)
  for (let i = 0; i < n; i += 1) zs[i] = den[i] > 1e-6 ? num[i] / den[i] : raw[i]
  const { gx, gy } = gradient(zs, w, h, s * 3, inside) // ft per ft
  const slope = new Float32Array(n)
  const dX = new Float32Array(n)
  const dY = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    const m = Math.hypot(gx[i], gy[i])
    slope[i] = inside[i] ? m * 100 : Number.NaN
    dX[i] = m > 1e-6 ? -gx[i] / m : 0
    dY[i] = m > 1e-6 ? -gy[i] / m : 0
  }

  // Overall tilt: least-squares plane z = a + b x + c y over the green.
  let sx = 0; let sy = 0; let sz = 0; let sxx = 0; let syy = 0; let sxy = 0; let sxz = 0; let syz = 0
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x
      if (!inside[i]) continue
      const X = x * s
      const Y = y * s
      const Z = zs[i]
      sx += X; sy += Y; sz += Z; sxx += X * X; syy += Y * Y; sxy += X * Y; sxz += X * Z; syz += Y * Z
    }
  }
  const N = insideCount
  const cxx = sxx - (sx * sx) / N
  const cyy = syy - (sy * sy) / N
  const cxy = sxy - (sx * sy) / N
  const cxz = sxz - (sx * sz) / N
  const cyz = syz - (sy * sz) / N
  const det = cxx * cyy - cxy * cxy
  const b = det ? (cxz * cyy - cyz * cxy) / det : 0 // ft per yd
  const c = det ? (cyz * cxx - cxz * cxy) / det : 0
  const tilt: CoursePointYds = [-b / 3, -c / 3] // ft/ft downhill
  const tiltPercent = Math.hypot(tilt[0], tilt[1]) * 100
  const tiltDownhill: CoursePointYds | null = tiltPercent >= 0.2
    ? [tilt[0] / Math.hypot(...tilt), tilt[1] / Math.hypot(...tilt)]
    : null

  const sample = (x: number, y: number) =>
    zs[Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))]
  const features: GreenFeature[] = []
  const describe = (cells: number[]) => {
    let cx = 0; let cy = 0; let ux = 0; let uy = 0
    for (const i of cells) {
      const x = i % w
      cx += x; cy += (i - x) / w; ux += dX[i]; uy += dY[i]
    }
    cx /= cells.length; cy /= cells.length
    const um = Math.hypot(ux, uy) || 1
    return { cx, cy, u: [ux / um, uy / um] as CoursePointYds }
  }

  // Tiers: a band clearly steeper than the green around it, with a real step.
  const insideSlopes = Array.from(slope).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const median = insideSlopes[Math.floor(insideSlopes.length / 2)] ?? 0
  const steepCut = Math.max(2.5, median * 1.6)
  const steep = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) steep[i] = inside[i] && slope[i] > steepCut ? 1 : 0
  for (const cells of components(steep, w, h)) {
    if (cells.length * s * s < MIN_FEATURE_SQ_YDS) continue
    const { cx, cy, u } = describe(cells)
    const t = TIER_PROBE_YDS / s
    const rise = sample(cx - u[0] * t, cy - u[1] * t) - sample(cx + u[0] * t, cy + u[1] * t)
    if (rise < MIN_TIER_RISE_FT) continue
    features.push({ kind: 'tier', riseFt: rise, at: [minX + cx * s, minY + cy * s], downhill: u, areaSqYds: cells.length * s * s })
  }

  // Spines: compare each square with the squares a few yards either side of it
  // (across, along, and both diagonals). If the ground falls away from it on
  // both sides, at a slope that matters, it is on a spine.
  const k = Math.max(1, Math.round(SPINE_PROBE_YDS / s))
  const spineMask = new Uint8Array(n)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x
      if (!inside[i]) continue
      for (const [ax, ay] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const px = x + ax * k; const py = y + ay * k; const qx = x - ax * k; const qy = y - ay * k
        if (px < 0 || py < 0 || qx < 0 || qy < 0 || px >= w || qx >= w || py >= h || qy >= h) continue
        const p = py * w + px
        const q = qy * w + qx
        const norm = Math.hypot(ax, ay)
        const awayP = (dX[p] * ax + dY[p] * ay) / norm
        const awayQ = -(dX[q] * ax + dY[q] * ay) / norm
        if (awayP > 0.6 && awayQ > 0.6 && slope[p] >= SPINE_MIN_SIDE_PERCENT && slope[q] >= SPINE_MIN_SIDE_PERCENT) {
          spineMask[i] = 1
          break
        }
      }
    }
  }
  for (const cells of components(spineMask, w, h)) {
    if (cells.length * s * s < MIN_FEATURE_SQ_YDS) continue
    const { cx, cy, u } = describe(cells)
    features.push({ kind: 'spine', riseFt: 0, at: [minX + cx * s, minY + cy * s], downhill: u, areaSqYds: cells.length * s * s })
  }
  features.sort((a, b) => b.riseFt - a.riseFt || b.areaSqYds - a.areaSqYds)

  return {
    tiltPercent,
    tiltDownhill,
    features,
    slopePercent: slope,
    elevationFt: Float32Array.from(zs),
    downhillX: dX,
    downhillY: dY,
    inside,
    grid: { minX, minY, spacingYds: s, width: w, height: h },
  }
}

const sampleGrid = (a: GreenReadAnalysis, field: Float32Array, p: CoursePointYds) => {
  const { minX, minY, spacingYds: s, width: w, height: h } = a.grid
  const x = Math.round((p[0] - minX) / s)
  const y = Math.round((p[1] - minY) / s)
  if (x < 0 || y < 0 || x >= w || y >= h) return Number.NaN
  return field[y * w + x]
}

/** Where `dir` points relative to the shot: past / short / left / right of the hole. */
const relative = (dir: CoursePointYds, shot: CoursePointYds) => {
  const along = dir[0] * shot[0] + dir[1] * shot[1]
  const leftward = shot[0] * dir[1] - shot[1] * dir[0] // > 0: dir points left of the shot
  if (along > 0.6) return 'past'
  if (along < -0.6) return 'short'
  return leftward > 0 ? 'left' : 'right'
}

/**
 * One plain line for the golfer, relative to this shot (ball -> pin), e.g.
 * "Tilts 4.2% back toward you: wedges spin back. Land it past the hole.
 *  Pin on the upper tier (1.0 ft step). Leave it short of the hole for an uphill putt."
 */
export const greenReadLine = (
  a: GreenReadAnalysis,
  ball: CoursePointYds,
  pin: CoursePointYds,
  /** False when the pin is only estimated: pin-specific advice is left out. */
  pinKnown = true,
): string => {
  const d = Math.hypot(pin[0] - ball[0], pin[1] - ball[1]) || 1
  const shot: CoursePointYds = [(pin[0] - ball[0]) / d, (pin[1] - ball[1]) / d]
  const parts: string[] = []
  const tiers = a.features.filter((f) => f.kind === 'tier')
  const spines = a.features.filter((f) => f.kind === 'spine')
  if (a.tiltPercent < FLAT_PERCENT && !tiers.length && !spines.length) {
    return 'Flat green: nothing to play around. Aim at the pin.'
  }
  if (a.tiltPercent >= FLAT_PERCENT && a.tiltDownhill) {
    const where = relative(a.tiltDownhill, shot)
    const pct = a.tiltPercent.toFixed(1)
    if (where === 'short') {
      parts.push(`Tilts ${pct}% back toward you${a.tiltPercent >= 3 ? ': wedges will spin back. Land it past the hole' : ''}.`)
    } else if (where === 'past') {
      parts.push(`Tilts ${pct}% away from you${a.tiltPercent >= 3 ? ': it will release. Land it short of the hole' : ''}.`)
    } else {
      const flow = where === 'left' ? 'right to left' : 'left to right'
      parts.push(`Tilts ${pct}% ${flow}${a.tiltPercent >= 3 ? `: it will feed ${where} after it lands` : ''}.`)
    }
  } else {
    parts.push('Flat overall.')
  }
  const tier = tiers[0]
  if (tier && !pinKnown) {
    parts.push(`${tier.riseFt.toFixed(1)} ft tier in the green.`)
  } else if (tier) {
    const pinZ = sampleGrid(a, a.elevationFt, pin)
    const t = TIER_PROBE_YDS
    const upper = sampleGrid(a, a.elevationFt, [tier.at[0] - tier.downhill[0] * t, tier.at[1] - tier.downhill[1] * t])
    const lower = sampleGrid(a, a.elevationFt, [tier.at[0] + tier.downhill[0] * t, tier.at[1] + tier.downhill[1] * t])
    const level = Number.isFinite(pinZ) && Number.isFinite(upper) && Number.isFinite(lower)
      ? (pinZ > (upper + lower) / 2 ? 'upper' : 'lower')
      : null
    parts.push(level
      ? `Pin on the ${level} tier (${tier.riseFt.toFixed(1)} ft step): stay on its level.`
      : `${tier.riseFt.toFixed(1)} ft tier in the green.`)
  }
  if (spines.length) parts.push('Spine in the green: it will kick off either side.')
  // Local slope at the pin: leave it on the low side for an uphill putt.
  const pinSlope = pinKnown ? sampleGrid(a, a.slopePercent, pin) : Number.NaN
  if (Number.isFinite(pinSlope) && pinSlope >= 2) {
    const down: CoursePointYds = [sampleGrid(a, a.downhillX, pin), sampleGrid(a, a.downhillY, pin)]
    const low = relative(down, shot)
    parts.push(`Leave it ${low === 'past' ? 'past' : `${low} of`} the hole for an uphill putt.`)
  }
  return parts.join(' ')
}

/** Slope colours, by how much the ball reacts: clear under 1%, then green, yellow, orange, red (4%+). */
const SLOPE_COLOURS: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0],
  [156, 196, 106, 140],
  [225, 207, 79, 158],
  [236, 148, 64, 168],
  [220, 75, 63, 178],
]

export const slopeBand = (pct: number) => (pct < 1 ? 0 : pct < 2 ? 1 : pct < 3 ? 2 : pct < 4 ? 3 : 4)

/** The steepness heatmap as a PNG (row 0 = minY), for the map to clip to the green. */
export const greenSlopeImage = (a: GreenReadAnalysis) => {
  const { minX, minY, spacingYds: s, width: w, height: h } = a.grid
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i += 1) {
    if (!a.inside[i] || !Number.isFinite(a.slopePercent[i])) continue
    const c = SLOPE_COLOURS[slopeBand(a.slopePercent[i])]
    rgba.set(c, i * 4)
  }
  let binary = ''
  const png = encodePngRgba(w, h, rgba)
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000))
  return {
    dataUrl: `data:image/png;base64,${btoa(binary)}`,
    x: minX - s / 2,
    y: minY - s / 2,
    width: w * s,
    height: h * s,
  }
}
