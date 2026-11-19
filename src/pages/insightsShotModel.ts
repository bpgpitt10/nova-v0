import { gsproAltitudeCarryFraction } from '../liveCaddie/airAltitudeAdjustment'
import { predictFairwayRoll } from '../liveCaddie/fairwayRollModel'
import { simulateFlight } from '../liveCaddie/flightPhysics'
import { predictGreenRelease } from '../liveCaddie/greenReleaseModel'
import { predictGsproCarry } from '../liveCaddie/gsproCarryModel'
import { sidehillLieShare, upDownLieShare } from '../liveCaddie/lieResponse'
import { BROADIE_2012_OFF_GREEN_TABLE, PGA_TOUR_PUTTING_TABLE } from '../liveCaddie/nextStateValue'
import type { Firmness } from '../liveCaddie/roundConditions'
import { getSurfaceResponse } from '../liveCaddie/surfaceResponse'

/**
 * Where one swing finishes under a set of conditions, for the insights page.
 *
 * It strings together the same models the live caddie uses, in the same order:
 * the lie's penalty, the slope of the lie, GSPro's carry, altitude, elevation
 * and wind on the flight, then the release on the green or the roll short of it.
 * Stimp is not here: Looper's green model does not have it yet.
 */

export type InsightSwing = Readonly<{ ballSpeedMph: number; launchDeg: number; spinRpm: number }>
export type InsightLie = 'fairway' | 'rough' | 'deep-rough' | 'sand'

export type InsightConditions = Readonly<{
  grass: Firmness
  firmness: Firmness
  lie: InsightLie
  /** Slope under the ball along the shot, degrees (+ is uphill). */
  slopeUpDeg: number
  /** Slope across the shot, degrees (+ starts the ball right). */
  slopeRightDeg: number
  /** Height of the green above the ball, feet (negative is below). */
  elevationFt: number
  altitudeFt: number
  windMph: number
  /** Where the wind comes from: 0 is straight into you, 90 from the right, 180 behind, 270 from the left. */
  windFromDeg: number
}>

export type InsightFinish = Readonly<{ totalYds: number; sideYds: number; carryYds: number; onGreen: boolean }>

/** The stock 8 iron every example on the page uses. */
export const INSIGHT_SWING: InsightSwing = { ballSpeedMph: 108, launchDeg: 19.5, spinRpm: 7300 }

export const INSIGHT_BASELINE: InsightConditions = {
  grass: 'medium', firmness: 'medium', lie: 'fairway',
  slopeUpDeg: 0, slopeRightDeg: 0, elevationFt: 0, altitudeFt: 0, windMph: 0, windFromDeg: 0,
}

/** The green in every example: this far in front of and behind the pin, and this wide each side. */
export const INSIGHT_GREEN = { halfDepthYds: 12, halfWidthYds: 10.5 } as const

const LIE_SURFACE: Record<InsightLie, string | null> = { fairway: null, rough: 'TVGrough', 'deep-rough': 'TVGdeeprough', sand: 'TVGsand' }
const within = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** How much of a side slope becomes start line from this lie, so pictures can place a ball without the full model. */
export const sideShareForLie = (lie: InsightLie, swing: InsightSwing = INSIGHT_SWING) => {
  const surface = LIE_SURFACE[lie]
  const vla = surface
    ? getSurfaceResponse(surface, { ballSpeedMph: swing.ballSpeedMph, vlaDeg: swing.launchDeg, totalSpinRpm: swing.spinRpm }).factors.vla
    : 1
  return sidehillLieShare(swing.launchDeg * vla)
}

/**
 * Where the swing finishes. `pinYds` only decides whether the ball lands on the
 * green (and so releases like a green) or short or long of it (and rolls like fairway).
 */
export const finishOf = (conditions: InsightConditions, pinYds: number, swing: InsightSwing = INSIGHT_SWING): InsightFinish => {
  const surface = LIE_SURFACE[conditions.lie]
  const factors = surface
    ? getSurfaceResponse(surface, { ballSpeedMph: swing.ballSpeedMph, vlaDeg: swing.launchDeg, totalSpinRpm: swing.spinRpm }).factors
    : { speed: 1, spin: 1, vla: 1 }
  const afterLie = swing.launchDeg * factors.vla
  const launch = {
    ballSpeedMph: swing.ballSpeedMph * factors.speed,
    vlaDeg: Math.max(0.5, afterLie + conditions.slopeUpDeg * upDownLieShare(afterLie)),
    hlaDeg: 0,
    totalSpinRpm: swing.spinRpm * factors.spin,
    spinAxisDeg: 0,
  }
  const still = simulateFlight(launch, {})
  const stillCarry = still.carryYds ?? 0
  const level = predictGsproCarry(launch) ?? stillCarry
  let carry = level * (1 + gsproAltitudeCarryFraction(launch, conditions.altitudeFt))
  let side = 0
  let descent = still.landingAngleDeg
  // Elevation and wind are the flight model's change, scaled to GSPro's carry for this launch.
  if ((conditions.elevationFt !== 0 || conditions.windMph > 0) && stillCarry > 0) {
    const flown = simulateFlight(launch, {
      landingElevationDeltaFt: conditions.elevationFt,
      windMph: conditions.windMph,
      windRelativeDeg: conditions.windFromDeg,
    })
    if (flown.ok && flown.carryYds != null) {
      const scale = within(carry / stillCarry, 0.75, 1.25)
      carry += (flown.carryYds - stillCarry) * scale
      side += (flown.offlineYds ?? 0) * scale
      descent = flown.landingAngleDeg ?? descent
    }
  }
  const arrival = { ballSpeedMph: launch.ballSpeedMph, spinRpm: launch.totalSpinRpm, descentDeg: descent ?? 45 }
  const onGreen = Math.abs(carry - pinYds) <= INSIGHT_GREEN.halfDepthYds
  const run = onGreen
    ? predictGreenRelease(arrival, { courseType: conditions.grass, greenFirmness: conditions.firmness })
    : predictFairwayRoll(arrival, { courseType: conditions.grass, fairwayFirmness: conditions.firmness })
  const total = carry + (run ?? 0)
  side += total * Math.sin((conditions.slopeRightDeg * sidehillLieShare(afterLie) * Math.PI) / 180)
  return { totalYds: total, sideYds: side, carryYds: carry, onGreen }
}

// ---- What a misread costs, in strokes --------------------------------------

const between = (x: number, rows: readonly (readonly [number, number])[]) => {
  if (x <= rows[0][0]) return rows[0][1]
  for (let n = 1; n < rows.length; n += 1) {
    if (x <= rows[n][0]) {
      const [x0, y0] = rows[n - 1]
      const [x1, y1] = rows[n]
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
    }
  }
  return rows[rows.length - 1][1]
}

const PUTTS = PGA_TOUR_PUTTING_TABLE.map((row) => [row.distanceFeet, row.expectedPutts] as const)
const FROM_FAIRWAY = BROADIE_2012_OFF_GREEN_TABLE.map((row) => [row.distanceYds, row.fairway] as const)
const FROM_ROUGH = BROADIE_2012_OFF_GREEN_TABLE.map((row) => [row.distanceYds, row.rough] as const)

/**
 * Average strokes to hole out from a spot `longYds` past the pin and `rightYds`
 * right of it: a putt if it is on the green, a chip from fairway if it is short,
 * from rough anywhere else. Same tour tables the live caddie decides with.
 */
export const strokesFrom = (longYds: number, rightYds: number) => {
  const distanceYds = Math.hypot(longYds, rightYds)
  const onGreen = (longYds / INSIGHT_GREEN.halfDepthYds) ** 2 + (rightYds / INSIGHT_GREEN.halfWidthYds) ** 2 <= 1
  if (onGreen) return between(distanceYds * 3, PUTTS)
  const straightShort = longYds < 0 && Math.abs(rightYds) <= INSIGHT_GREEN.halfWidthYds
  return between(distanceYds, straightShort ? FROM_FAIRWAY : FROM_ROUGH)
}

/** How far a decent player's 8 iron scatters around where it was meant to go (one standard deviation). */
export const INSIGHT_SCATTER = { longYds: 6, rightYds: 5 } as const

const SPREAD = [-2.4, -1.8, -1.2, -0.6, 0, 0.6, 1.2, 1.8, 2.4]
const WEIGHTS = SPREAD.map((z) => Math.exp(-0.5 * z * z))
const WEIGHT_SUM = WEIGHTS.reduce((sum, weight) => sum + weight, 0)

type Scatter = Readonly<{ longYds: number; rightYds: number }>

/** A longer club scatters wider: about 4% of the shot long and short, a little less side to side. */
export const scatterFor = (shotYds: number): Scatter => ({ longYds: shotYds * 0.04, rightYds: shotYds * 0.033 })

/** Average strokes to hole out when shots are centred `longYds` past and `rightYds` right of the pin. */
export const strokesWhenCentredAt = (longYds: number, rightYds: number, scatter: Scatter = INSIGHT_SCATTER) => {
  let total = 0
  for (let a = 0; a < SPREAD.length; a += 1) {
    for (let b = 0; b < SPREAD.length; b += 1) {
      total += WEIGHTS[a] * WEIGHTS[b]
        * strokesFrom(longYds + SPREAD[a] * scatter.longYds, rightYds + SPREAD[b] * scatter.rightYds)
    }
  }
  return total / (WEIGHT_SUM * WEIGHT_SUM)
}

/**
 * Strokes lost by planning for the wrong number: your shots end up centred on
 * the misread instead of on the pin. Never negative.
 */
export const strokesLostToMisread = (longYds: number, rightYds: number, scatter: Scatter = INSIGHT_SCATTER) =>
  Math.max(0, strokesWhenCentredAt(longYds, rightYds, scatter) - strokesWhenCentredAt(0, 0, scatter))
