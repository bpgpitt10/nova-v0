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
