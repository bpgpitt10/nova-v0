/**
 * How a putt plays, from GSPro's putting model (20 Nov 2026, claude/putting-model-2026-11-20.md).
 *
 * GSPro slows a rolling ball at  a = g * (c0 + 0.00504 * v + 0.68 * grade),  c0 = 0.5532 / stimp - 0.01829
 * (v in ft/s, grade rise over run along the roll, + uphill). Grass type and green firmness don't change a
 * putt. That fits every measured putt within 0.05 ft on average, flat, uphill and downhill, stimp 8 to 13.
 *
 * From a putt's length and rise or fall this works out the stroke it needs, then says how far that stroke
 * would roll on a flat green: at this stimp ("plays like") and at stimp 11 (the stroke you know). Only the
 * straight line from ball to hole: break isn't measured yet, so this is pace, not aim.
 */

const G_FT_S2 = 32.174
const SPEED_TERM = 0.00504
/** GSPro applies about 68% of real gravity along a slope. */
const SLOPE_GRAVITY = 0.68
const MPH_TO_FT_S = 1.46667
export const BASELINE_STIMP = 11
const STIMP_RANGE: readonly [number, number] = [6, 16]

const usableStimp = (stimp: number | null | undefined): number =>
  typeof stimp === 'number' && Number.isFinite(stimp) && stimp >= STIMP_RANGE[0] && stimp <= STIMP_RANGE[1]
    ? stimp : BASELINE_STIMP

/** Rolling friction at a stimp, as a share of gravity (flat green, slow ball). */
export const puttFriction = (stimp: number | null | undefined): number => 0.5532 / usableStimp(stimp) - 0.01829

/** The steepest downhill (as a fraction, e.g. 0.047) a putt can still stop on at this stimp. */
export const runawayGrade = (stimp: number | null | undefined): number => puttFriction(stimp) / SLOPE_GRAVITY

/** Feet a putt rolls from a starting speed (ft/s); Infinity when the slope won't let it stop. */
export const puttRollFt = (speedFtS: number, stimp: number | null | undefined, grade = 0): number => {
  if (!(speedFtS > 0)) return 0
  const a = puttFriction(stimp) + SLOPE_GRAVITY * grade
  if (a <= 0) return Number.POSITIVE_INFINITY
  // Closed form of dv/dx = -g (a + k v) / v from v down to 0.
  return (speedFtS / SPEED_TERM - (a / SPEED_TERM ** 2) * Math.log(1 + (SPEED_TERM * speedFtS) / a)) / G_FT_S2
}

/** The starting speed (ft/s) that rolls a putt exactly `distanceFt`; null when it can't stop there. */
export const puttSpeedFor = (distanceFt: number, stimp: number | null | undefined, grade = 0): number | null => {
  if (!(distanceFt > 0)) return 0
  if (!Number.isFinite(puttRollFt(0.01, stimp, grade))) return null
  let lo = 0
  let hi = 40
  if (puttRollFt(hi, stimp, grade) < distanceFt) return null
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2
    if (puttRollFt(mid, stimp, grade) < distanceFt) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export type PuttRead = Readonly<{
  distanceFt: number
  /** Rise (+) or fall (-) from the ball to the hole, inches. */
  riseIn: number
  /** Rise over run, ball to hole (+ uphill). */
  grade: number
  stimp: number
  /** How far the same stroke rolls on a flat green at this stimp. Null when it can't stop. */
  playsLikeFt: number | null
  /** How far the same stroke rolls on a flat stimp-11 green: the stroke most players know. */
  stimp11Ft: number | null
  /** Ball speed off the putter face, mph. */
  speedMph: number | null
  /** The slope is too steep for a ball to stop on at this stimp: it runs until the green flattens. */
  runaway: boolean
  /** The steepest downhill a putt can stop on at this stimp, percent. */
  runawayPercent: number
}>

export const readPutt = (distanceFt: number, riseIn: number, stimp: number | null | undefined): PuttRead => {
  const s = usableStimp(stimp)
  const grade = distanceFt > 0 ? riseIn / 12 / distanceFt : 0
  const runaway = -grade >= runawayGrade(s)
  const speed = runaway ? null : puttSpeedFor(distanceFt, s, grade)
  const flat = (atStimp: number) => (speed == null ? null : puttRollFt(speed, atStimp, 0))
  return {
    distanceFt,
    riseIn,
    grade,
    stimp: s,
    playsLikeFt: flat(s),
    stimp11Ft: flat(BASELINE_STIMP),
    speedMph: speed == null ? null : speed / MPH_TO_FT_S,
    runaway,
    runawayPercent: runawayGrade(s) * 100,
  }
}

/** "4 ft 11 in", "8 in": a height in feet and inches. */
export const feetInches = (inches: number): string => {
  const total = Math.round(Math.abs(inches))
  const feet = Math.floor(total / 12)
  const rest = total % 12
  if (feet === 0) return `${rest} in`
  return rest === 0 ? `${feet} ft` : `${feet} ft ${rest} in`
}

// ---- Break: rolling the ball across the green's slope (not yet checked against GSPro's own putts) ----

/** Rise over run at a point, along +x and +y (hole-local yards). Null off the green. */
export type SlopeField = (point: readonly [number, number]) => readonly [number, number] | null

/** A slope field from the green read's smoothed grid (slope % and downhill direction per cell). */
export const slopeFieldFromGreenRead = (analysis: {
  slopePercent: Float32Array
  downhillX: Float32Array
  downhillY: Float32Array
  inside: Uint8Array
  grid: { minX: number; minY: number; spacingYds: number; width: number; height: number }
}): SlopeField => {
  const { minX, minY, spacingYds, width, height } = analysis.grid
  const at = (c: number, r: number): readonly [number, number] | null => {
    const i = r * width + c
    const pct = analysis.slopePercent[i]
    if (!analysis.inside[i] || !Number.isFinite(pct)) return null
    // Uphill is against the downhill direction.
    return [-analysis.downhillX[i] * pct / 100, -analysis.downhillY[i] * pct / 100]
  }
  return ([x, y]) => {
    const fx = (x - minX) / spacingYds
    const fy = (y - minY) / spacingYds
    if (fx < 0 || fy < 0 || fx > width - 1 || fy > height - 1) return null
    const c0 = Math.min(Math.floor(fx), width - 2)
    const r0 = Math.min(Math.floor(fy), height - 2)
    const dx = fx - c0
    const dy = fy - r0
    const corners = [at(c0, r0), at(c0 + 1, r0), at(c0, r0 + 1), at(c0 + 1, r0 + 1)]
    if (corners.some((v) => v == null)) return corners.find((v) => v != null) ?? null
    const [a, b, c, d] = corners as [number, number][]
    const lerp = (k: 0 | 1) => (a[k] * (1 - dx) + b[k] * dx) * (1 - dy) + (c[k] * (1 - dx) + d[k] * dx) * dy
    return [lerp(0), lerp(1)]
  }
}

export type GreenRoll = Readonly<{
  /** Where the ball stopped (yards), or where it left the green / ran out of time. */
  end: readonly [number, number]
  /** Sampled path, yards. */
  path: readonly (readonly [number, number])[]
  /** Closest the ball came to `hole`, yards (when a hole is given). */
  closestToHoleYds: number | null
  stopped: boolean
}>

const YD_TO_FT = 3

/**
 * Roll a ball from `start` (yards) along `headingDeg` (0 = +y, 90 = +x) at `speedFtS`, with GSPro's putting
 * friction and 68% of gravity along the local slope, both along and across the line.
 */
export const rollOnGreen = (
  slope: SlopeField,
  start: readonly [number, number],
  headingDeg: number,
  speedFtS: number,
  stimp: number | null | undefined,
  hole: readonly [number, number] | null = null,
): GreenRoll => {
  const c0 = puttFriction(stimp)
  const rad = (headingDeg * Math.PI) / 180
  let vx = Math.sin(rad) * speedFtS
  let vy = Math.cos(rad) * speedFtS
  let x = start[0] * YD_TO_FT
  let y = start[1] * YD_TO_FT
  const path: [number, number][] = [[start[0], start[1]]]
  let closest = hole ? Math.hypot(start[0] - hole[0], start[1] - hole[1]) : null
  const dt = 0.005
  let stopped = false
  for (let step = 0; step < 6000; step += 1) {
    const g = slope([x / YD_TO_FT, y / YD_TO_FT])
    if (!g) break
    const speed = Math.hypot(vx, vy)
    const pullX = -SLOPE_GRAVITY * g[0] * G_FT_S2
    const pullY = -SLOPE_GRAVITY * g[1] * G_FT_S2
    if (speed < 0.05) {
      // At rest unless the slope is steeper than friction can hold.
      if (Math.hypot(g[0], g[1]) * SLOPE_GRAVITY <= c0) { stopped = true; break }
    }
    const drag = G_FT_S2 * (c0 + SPEED_TERM * speed)
    const ux = speed > 1e-9 ? vx / speed : 0
    const uy = speed > 1e-9 ? vy / speed : 0
    const nvx = vx + (-drag * ux + pullX) * dt
    const nvy = vy + (-drag * uy + pullY) * dt
    // Friction stops the ball; it doesn't turn it around.
    if (speed > 0 && nvx * vx + nvy * vy < 0 && Math.hypot(pullX, pullY) <= drag) { stopped = true; break }
    vx = nvx
    vy = nvy
    x += vx * dt
    y += vy * dt
    if (step % 10 === 0) path.push([x / YD_TO_FT, y / YD_TO_FT])
    if (hole) closest = Math.min(closest!, Math.hypot(x / YD_TO_FT - hole[0], y / YD_TO_FT - hole[1]))
  }
  const end: [number, number] = [x / YD_TO_FT, y / YD_TO_FT]
  path.push(end)
  return { end, path, closestToHoleYds: closest, stopped }
}

const headingTo = (from: readonly [number, number], to: readonly [number, number]) =>
  (Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI

/**
 * The start line and pace that roll the ball over the hole and stop it `pastFt` beyond it: the putt's
 * aim, with break. `aimOffsetFt` is how far left (-) or right (+) of the hole to start it, at the hole's
 * distance. Null when no line gets there (off the green, too steep).
 */
export const aimPutt = (
  slope: SlopeField,
  ball: readonly [number, number],
  hole: readonly [number, number],
  stimp: number | null | undefined,
  pastFt = 1.5,
): { headingDeg: number; speedFtS: number; aimOffsetFt: number; roll: GreenRoll } | null => {
  const distanceFt = Math.hypot(hole[0] - ball[0], hole[1] - ball[1]) * YD_TO_FT
  if (!(distanceFt > 0.5)) return null
  const straight = headingTo(ball, hole)
  const g = slope(ball)
  const along = g ? (g[0] * (hole[0] - ball[0]) + g[1] * (hole[1] - ball[1])) / (distanceFt / YD_TO_FT) : 0
  let speed = puttSpeedFor(distanceFt + pastFt, stimp, along) ?? puttSpeedFor(distanceFt + pastFt, stimp, 0)
  if (speed == null) return null
  // Signed miss: which side of the hole the ball passes (+ right of the line to the hole).
  const sideMiss = (heading: number, v: number) => {
    const roll = rollOnGreen(slope, ball, heading, v, stimp, hole)
    // Find the path point nearest the hole and which side of ball->hole it is.
    let best = Infinity
    let side = 0
    const hx = hole[0] - ball[0]
    const hy = hole[1] - ball[1]
    for (const p of roll.path) {
      const d = Math.hypot(p[0] - hole[0], p[1] - hole[1])
      if (d < best) { best = d; side = Math.sign(hy * (p[0] - ball[0]) - hx * (p[1] - ball[1])) }
    }
    return { roll, miss: best * (side || 1) }
  }
  let heading = straight
  for (let round = 0; round < 4; round += 1) {
    // Line: bisect the heading between a start left and right of the hole.
    let lo = straight - 30
    let hi = straight + 30
    const missLo = sideMiss(lo, speed).miss
    const missHi = sideMiss(hi, speed).miss
    if (Math.sign(missLo) === Math.sign(missHi)) return null
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2
      if (Math.sign(sideMiss(mid, speed).miss) === Math.sign(missLo)) lo = mid
      else hi = mid
    }
    heading = (lo + hi) / 2
    // Pace: stop `pastFt` beyond the hole along this line.
    const { roll } = sideMiss(heading, speed)
    const beyondFt = Math.hypot(roll.end[0] - hole[0], roll.end[1] - hole[1]) * YD_TO_FT
    const pastHole = (roll.end[0] - ball[0]) * (hole[0] - ball[0]) + (roll.end[1] - ball[1]) * (hole[1] - ball[1])
      > ((hole[0] - ball[0]) ** 2 + (hole[1] - ball[1]) ** 2)
    const errorFt = (pastHole ? beyondFt : -beyondFt) - pastFt
    if (Math.abs(errorFt) < 0.1) break
    speed *= Math.max(0.7, Math.min(1.3, 1 - errorFt / (2 * (distanceFt + pastFt))))
  }
  const { roll } = sideMiss(heading, speed)
  const offsetRad = ((heading - straight) * Math.PI) / 180
  return { headingDeg: heading, speedFtS: speed, aimOffsetFt: Math.tan(offsetRad) * distanceFt, roll }
}
