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
 * The hole every example is played on, measured from the pin in yards (long:
 * past the pin; right: right of it). The picture on the page is drawn from
 * exactly these shapes, so a ball drawn in the sand is in the sand.
 *
 * The pin is back right. In front of the green is fairway; sand sits short-left,
 * right of the green and long-right; water runs down the left; trees line the
 * right; out of bounds a little way over the back. Everything else is rough.
 */
export type InsightArea = Readonly<{ longYds: number; rightYds: number; halfDepthYds: number; halfWidthYds: number }>

export const INSIGHT_HOLE = {
  /** What the picture shows; a ball outside it is off the hole. */
  frame: { shortYds: -40, longYds: 32, halfWidthYds: 22 },
  green: { longYds: -5, rightYds: -3, halfDepthYds: 11, halfWidthYds: 9 },
  /** The approach: a strip of fairway in front of the green. */
  fairway: { fromYds: -40, toYds: -13, leftYds: -10, rightYds: 8 },
  bunkers: [
    { longYds: 10, rightYds: 6, halfDepthYds: 6, halfWidthYds: 5 },
    { longYds: -19, rightYds: -8, halfDepthYds: 5, halfWidthYds: 5 },
    { longYds: -4, rightYds: 12, halfDepthYds: 6, halfWidthYds: 3.5 },
  ],
  water: { longYds: -10, rightYds: -19, halfDepthYds: 22, halfWidthYds: 5.5 },
  /** Trees from this far right of the pin to the edge. */
  treesRightYds: 17,
  /** White stakes this far past the pin. */
  outOfBoundsLongYds: 26,
} as const

export const insideArea = (area: InsightArea, longYds: number, rightYds: number, grow = 1) =>
  ((longYds - area.longYds) / (area.halfDepthYds * grow)) ** 2 + ((rightYds - area.rightYds) / (area.halfWidthYds * grow)) ** 2 <= 1

export type InsightLeave = Readonly<{
  kind: 'close' | 'look' | 'green' | 'long-putt' | 'fringe' | 'sand' | 'water' | 'trees' | 'ob' | 'fairway' | 'short' | 'long' | 'wide' | 'gone'
  /** The short verdict, in plain golf. */
  headline: string
  detail: string
}>

/** What you are left with when your ball finishes `longYds` past the pin and `rightYds` right of it. */
export const describeLeave = (longYds: number, rightYds: number): InsightLeave => {
  const yards = Math.hypot(longYds, rightYds)
  const feet = Math.round(yards * 3)
  const away = `${Math.round(yards)} yards from the pin`
  const { frame, green, fairway, bunkers, water, treesRightYds, outOfBoundsLongYds } = INSIGHT_HOLE
  if (longYds < frame.shortYds || longYds > frame.longYds || Math.abs(rightYds) > frame.halfWidthYds) {
    return { kind: 'gone', headline: 'That is a different hole.', detail: `${Math.round(yards)} yards from the pin. Reload and take your medicine.` }
  }
  if (longYds >= outOfBoundsLongYds) {
    return { kind: 'ob', headline: 'Out of bounds.', detail: 'Over the back and past the white stakes. Stroke and distance: hit it again from where you were.' }
  }
  if (insideArea(water, longYds, rightYds)) {
    return { kind: 'water', headline: 'Splash.', detail: `In the water left. Drop, add a stroke, and you are chipping for bogey.` }
  }
  if (bunkers.some((bunker) => insideArea(bunker, longYds, rightYds))) {
    return { kind: 'sand', headline: 'Bunker. Have fun at the beach.', detail: `${away}, in the sand. Splash it close or it costs a shot.` }
  }
  if (insideArea(green, longYds, rightYds)) {
    if (feet <= 6) return { kind: 'close', headline: 'Kick-in range.', detail: `${Math.max(1, feet)} feet. That read was a birdie.` }
    if (feet <= 18) return { kind: 'look', headline: 'A real birdie look.', detail: `${feet} feet from the pin.` }
    if (feet <= 45) return { kind: 'green', headline: 'On the green, not at the pin.', detail: `${feet} feet away. Two putt instead of chasing a birdie.` }
    return { kind: 'long-putt', headline: 'On the green. Barely.', detail: `${feet} feet away. That is three-putt range.` }
  }
  if (rightYds >= treesRightYds) {
    return { kind: 'trees', headline: 'In the trees right.', detail: `${away}. Punch out sideways and bogey is a good score.` }
  }
  // Just off the green's edge: a putter or a simple chip.
  if (insideArea(green, longYds, rightYds, 1.25)) {
    return { kind: 'fringe', headline: 'Just off the edge.', detail: `${away}, on the fringe. Putt it or chip it close.` }
  }
  if (longYds >= fairway.fromYds && longYds <= fairway.toYds && rightYds >= fairway.leftYds && rightYds <= fairway.rightYds) {
    return { kind: 'fairway', headline: 'Short, on the fairway.', detail: `${away}. The best miss on this hole: a simple chip and a putt for par.` }
  }
  if (longYds < green.longYds - green.halfDepthYds) {
    return { kind: 'short', headline: 'Short, in the rough.', detail: `${away}. A fluffy lie and a chip you can't spin. Par is work.` }
  }
  if (longYds > green.longYds + green.halfDepthYds) {
    return { kind: 'long', headline: 'Over the back.', detail: `${away}, chipping back to a green running away from you. Bogey is in play.` }
  }
  return {
    kind: 'wide',
    headline: `Missed the green ${rightYds > green.rightYds ? 'right' : 'left'}.`,
    detail: `${away}, in the rough. Up and down for par.`,
  }
}
