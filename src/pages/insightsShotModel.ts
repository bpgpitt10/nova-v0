import { gsproAltitudeCarryFraction } from '../liveCaddie/airAltitudeAdjustment'
import { predictFairwayRoll } from '../liveCaddie/fairwayRollModel'
import { simulateFlight } from '../liveCaddie/flightPhysics'
import { predictGreenRelease } from '../liveCaddie/greenReleaseModel'
import { predictGsproCarry } from '../liveCaddie/gsproCarryModel'
import { sidehillLieShare, upDownLieShare } from '../liveCaddie/lieResponse'
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
  const onGreen = Math.abs(carry - (pinYds + INSIGHT_HOLE.green.longYds)) <= INSIGHT_HOLE.green.halfDepthYds
  const run = onGreen
    ? predictGreenRelease(arrival, { courseType: conditions.grass, greenFirmness: conditions.firmness })
    : predictFairwayRoll(arrival, { courseType: conditions.grass, fairwayFirmness: conditions.firmness })
  const total = carry + (run ?? 0)
  side += total * Math.sin((conditions.slopeRightDeg * sidehillLieShare(afterLie) * Math.PI) / 180)
  return { totalYds: total, sideYds: side, carryYds: carry, onGreen }
}

// ---- Where a misread leaves you --------------------------------------------

/**
 * The hole every example is played on, measured from the pin (yards past it,
 * yards right of it). The pin is back right, so the middle of the green is a
 * little short and left, and there is sand long-right and short-left.
 */
export const INSIGHT_HOLE = {
  green: { longYds: -5, rightYds: -3, halfDepthYds: 11, halfWidthYds: 9 },
  bunkers: [
    { longYds: 10, rightYds: 6, halfDepthYds: 6, halfWidthYds: 5 },
    { longYds: -19, rightYds: -8, halfDepthYds: 5, halfWidthYds: 5 },
  ],
} as const

const inside = (area: { longYds: number; rightYds: number; halfDepthYds: number; halfWidthYds: number }, longYds: number, rightYds: number) =>
  ((longYds - area.longYds) / area.halfDepthYds) ** 2 + ((rightYds - area.rightYds) / area.halfWidthYds) ** 2 <= 1

export type InsightLeave = Readonly<{
  kind: 'close' | 'look' | 'green' | 'long-putt' | 'fringe' | 'sand' | 'short' | 'long' | 'wide' | 'gone'
  /** The short verdict, in plain golf. */
  headline: string
  detail: string
}>

/** What you are left with when your ball finishes `longYds` past the pin and `rightYds` right of it. */
export const describeLeave = (longYds: number, rightYds: number): InsightLeave => {
  const yards = Math.hypot(longYds, rightYds)
  const feet = Math.round(yards * 3)
  const { green, bunkers } = INSIGHT_HOLE
  if (yards > 32) return { kind: 'gone', headline: 'That is a different hole.', detail: `${Math.round(yards)} yards from the pin. Reload.` }
  if (bunkers.some((bunker) => inside(bunker, longYds, rightYds))) {
    return { kind: 'sand', headline: 'Bunker. Have fun at the beach.', detail: `${Math.round(yards)} yards from the pin, in the sand.` }
  }
  if (inside(green, longYds, rightYds)) {
    if (feet <= 6) return { kind: 'close', headline: 'Kick-in range.', detail: `${Math.max(1, feet)} feet. That read was a birdie.` }
    if (feet <= 18) return { kind: 'look', headline: 'A real birdie look.', detail: `${feet} feet from the pin.` }
    if (feet <= 45) return { kind: 'green', headline: 'On the green, not at the pin.', detail: `${feet} feet away. Two putt instead of chasing a birdie.` }
    return { kind: 'long-putt', headline: 'On the green. Barely.', detail: `${feet} feet away. That is three-putt range.` }
  }
  // The pin is near the back right edge, so a small miss that way is only just off.
  if (yards <= 5) return { kind: 'fringe', headline: 'Just off the edge.', detail: `${feet} feet from the pin, on the fringe. Putt it or chip it close.` }
  const pastGreen = longYds - green.longYds
  if (Math.abs(rightYds - green.rightYds) <= green.halfWidthYds) {
    return pastGreen < 0
      ? { kind: 'short', headline: 'Short of the green.', detail: `${Math.round(yards)} yards from the pin. A chip and a putt to save par.` }
      : { kind: 'long', headline: 'Over the back.', detail: `${Math.round(yards)} yards from the pin, with a touchy chip coming back.` }
  }
  return {
    kind: 'wide',
    headline: `Missed the green ${rightYds > green.rightYds ? 'right' : 'left'}.`,
    detail: `${Math.round(yards)} yards from the pin. Up and down for par.`,
  }
}
