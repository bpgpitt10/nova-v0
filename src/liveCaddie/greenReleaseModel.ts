import type { Firmness } from './roundConditions'
import type { FairwayArrival } from './fairwayRollModel'

/**
 * How far a ball releases (or spins back) after landing on a green, for the
 * round's GSPro Course Type and Green Firmness.
 *
 * Measured in GSPro 4.1.9 On Course practice (18 Nov 2026): 131 shots landed
 * on greens with no swing, most from one spot at Briarwood West with only the
 * settings changed (Bentgrass, Bermuda, Links x soft, medium, firm; the same
 * six shots each run, at 126 and 174 yd), plus Royal New Kent and Woodhaven.
 * Stimp was 11 throughout (a few runs didn't record it).
 *
 * Stimp and slope (20 Nov, Briarwood West at stimp 8, 11 and 13): a release is
 * a bounce and skid that stimp doesn't touch, then a roll that follows the
 * putting model (claude/putting-model-2026-11-20.md): friction c0(stimp) plus
 * 0.68 of the slope. For a full approach about three quarters of the release
 * is that roll (fit on the 18 stimp shots: 0.08 yd mean miss, 0.42 worst,
 * against 0.27 mean for a plain stimp / 11, and 0.25 for no stimp effect). A
 * chip's release is nearly all roll.
 *
 * Chips (20 Nov, 152 chips at Briarwood West): the approach fit below gives a
 * 7 yd chip a third of its real release, so a ball landing slower than about
 * 39.3 mph (the fastest chip measured) uses its own fit (chipReleaseLevel11),
 * and one landing at 40 mph or more (the slowest approach measured) the approach
 * fit. Nothing was measured in between: a 45 to 90 yd pitch is the gap. 0.4 yd mean on the 5 to 16 yd chips, 0.8 on 30 and 40 yd, 0.6
 * on chips from the rough held out of the fit.
 *
 * Shape (a bounce, then a roll): the ball lands with a forward speed and a
 * downward speed. The green takes forward speed in proportion to the downward
 * speed (`grab`) and to the backspin (`bite`); what is left, squared, is the
 * release (`run`). Enough spin makes it negative: the ball comes back. The
 * three numbers change with course type and firmness. Stimp acts on the roll
 * share only (releaseConditionFactor). On a slope an approach keeps the 18 Nov
 * rule (the whole release over 1 + slope / 0.0425 g, that friction scaled with
 * stimp); a chip's roll share follows the putting model's slope instead.
 *
 * Accuracy on the 131 shots: 0.8 yd mean from GSPro's own landing numbers,
 * 0.9 yd from launch numbers as Looper uses it (1.7 yd at the 90th
 * percentile); 0.9 yd mean on shots held out of the fit.
 */

export type GreenConditions = Readonly<{
  courseType: Firmness
  greenFirmness: Firmness
  /** As picked at Start a Round (GSPro doesn't log it). Missing means the fit's own stimp, 11. */
  stimp?: number | null
}>

/** The stimp the 18 Nov release fit was measured at. */
export const REFERENCE_STIMP = 11
const STIMP_RANGE = [6, 15] as const

const usableStimp = (stimp: number | null | undefined): number =>
  typeof stimp === 'number' && Number.isFinite(stimp) && stimp >= STIMP_RANGE[0] && stimp <= STIMP_RANGE[1]
    ? stimp : REFERENCE_STIMP

/** The putting model's rolling friction at a stimp, as a share of gravity (flat green). */
export const puttRollFriction = (stimp: number | null | undefined): number => 0.5532 / usableStimp(stimp) - 0.01829
/** GSPro applies this share of real gravity along a slope (putting model). */
const SLOPE_GRAVITY = 0.68
/** Share of a full approach's release that is roll (the part stimp and slope change). */
export const APPROACH_ROLL_SHARE = 0.76

/**
 * How a release changes from a level stimp-11 green to this stimp and slope:
 * the skid stays, the roll goes as 1 / (friction + 0.68 * slope along the motion).
 * `alongMotion` is rise over run in the direction the ball is moving (+ uphill).
 */
export const releaseConditionFactor = (rollShare: number, stimp: number | null | undefined, alongMotion = 0): number => {
  const share = clamp(rollShare, [0, 1])
  const friction = Math.max(puttRollFriction(stimp) + SLOPE_GRAVITY * alongMotion, 0.004)
  return clamp((1 - share) + share * puttRollFriction(REFERENCE_STIMP) / friction, [0.2, 4])
}

/** How much further a level release runs at this stimp than at 11, for a full approach. */
export const stimpReleaseFactor = (stimp: number | null | undefined, rollShare = APPROACH_ROLL_SHARE): number =>
  releaseConditionFactor(rollShare, stimp, 0)

/** Bentgrass, Bermuda, Links in GSPro's own order (its log writes 0, 1, 2). */
const TYPE_INDEX: Record<Firmness, 0 | 1 | 2> = { soft: 0, medium: 1, firm: 2 }
const FIRM_INDEX: Record<Firmness, 0 | 1 | 2> = { soft: 0, medium: 1, firm: 2 }

/** Fitted 18 Nov 2026 (tools/fixtures/green-release-2026-11-18.json). Bermuda soft is the base. */
const FIT = {
  grab: { base: 0.48369, bentgrass: 0.38129, links: -0.1685, perFirmness: -0.17545 },
  lnBite: { base: 0.61904, bentgrass: -0.76792, links: -0.06312, perFirmness: 0.24487 },
  lnRun: { base: -3.60297, bentgrass: 0.15028, links: -0.06302, perFirmness: -0.10408 },
} as const
const LIMITS = { ballSpeedMph: [35, 150], spinRpm: [1500, 13500], descentDeg: [25, 58] } as const
const RELEASE_RANGE_YDS = [-10, 35] as const
const clamp = (value: number, [low, high]: readonly [number, number]) => Math.min(high, Math.max(low, value))
const rad = (deg: number) => (deg * Math.PI) / 180

const settingValue = (
  part: { base: number; bentgrass: number; links: number; perFirmness: number },
  type: 0 | 1 | 2,
  firmness: 0 | 1 | 2,
) => part.base + (type === 0 ? part.bentgrass : 0) + (type === 2 ? part.links : 0) + part.perFirmness * firmness

/**
 * Chips, fitted 20 Nov 2026 on 77 chips that landed and stayed on the green
 * (bump 12, chip 20, pitch 28, flop 40 deg launch; 5 to 40 yd; every grass and
 * firmness; stimp 8, 11, 13). Same shape as the approach fit, but spin only
 * starts to bite at pitch spins (it goes as spin^4), and almost all of the
 * release is roll. Bermuda soft is the base.
 */
const CHIP_FIT = {
  grab: { base: 0.67199, bentgrass: 0.11764, links: -0.08879, perFirmness: -0.1292 },
  lnRun: { base: -0.10202, bentgrass: 0.0214, links: 0.19221, perFirmness: 0.06927 },
  bite: 0.010303,
  spinPower: 4,
  power: 0.98037,
  rollShare: { at30Deg: 4.71498, per10Deg: 2.16021 },
} as const
const CHIP_LIMITS = { speedMph: [8, 46], descentDeg: [6, 50], spinRpm: [0, 6000] } as const

type Landing = { speedMph: number; descentDeg: number; spinRpm: number }

/** A chip's release on a level stimp-11 green, and how much of it is roll. */
export const chipReleaseLevel11 = (landing: Landing, conditions: GreenConditions): { releaseYds: number; rollShare: number } => {
  const type = TYPE_INDEX[conditions.courseType]
  const firmness = FIRM_INDEX[conditions.greenFirmness]
  const speed = clamp(landing.speedMph, CHIP_LIMITS.speedMph)
  const descent = clamp(landing.descentDeg, CHIP_LIMITS.descentDeg)
  const spin = clamp(landing.spinRpm, CHIP_LIMITS.spinRpm) / 1000
  const forward = speed * Math.cos(rad(descent))
  const down = speed * Math.sin(rad(descent))
  const left = forward - settingValue(CHIP_FIT.grab, type, firmness) * down - CHIP_FIT.bite * spin ** CHIP_FIT.spinPower
  const releaseYds = Math.exp(settingValue(CHIP_FIT.lnRun, type, firmness)) * Math.sign(left) * Math.abs(left) ** CHIP_FIT.power
  const rollShare = 1 / (1 + Math.exp(-(CHIP_FIT.rollShare.at30Deg + CHIP_FIT.rollShare.per10Deg * (descent - 30) / 10)))
  return { releaseYds, rollShare }
}

/**
 * Partial wedges, fitted 23 Nov 2026 (tools/fixtures/wedge-release-2026-11-23.json): 50 shots that landed
 * and stayed on the green at Briarwood West, four flights (16, 23, 29, 36 deg launch) with clean spin and
 * a quarter less, on six green settings, stimp 8, 11 and 13. Nearly all carried 65 yd (landing 42 to 44
 * mph); the fit also saw the 18 Nov approach shots that land under 50 mph, so it meets the full wedge.
 * Mean miss 0.4 yd on the 50. Every landing was on a 3 to 6% upslope: the level numbers lean on the slope
 * rule below. Bermuda soft is the base.
 */
const WEDGE_FIT = {
  grab: { base: 0.31948, bentgrass: -0.08062, links: 0.0401, perFirmness: -0.0001 },
  lnRun: { base: -1.0213, bentgrass: -0.61782, links: 0.36568, perFirmness: 0.2804 },
  lnBite: { base: 0.98828, bentgrass: 0.20398, links: -0.14725, perFirmness: -0.03442 },
  power: 1.03844,
  rollShare: { at40Deg: 1.63131, per10Deg: 4.0, per1000Rpm: -1.16623 },
} as const
/** Landing speeds (mph): chips up to the first pair, the wedge fit between, the approach fit past the last. */
export const WEDGE_BAND_MPH = [37, 41, 48, 52] as const

/** A partial wedge's release on a level stimp-11 green, and how much of it is roll. */
export const wedgeReleaseLevel11 = (landing: Landing, conditions: GreenConditions): { releaseYds: number; rollShare: number } => {
  const type = TYPE_INDEX[conditions.courseType]
  const firmness = FIRM_INDEX[conditions.greenFirmness]
  const forward = landing.speedMph * Math.cos(rad(landing.descentDeg))
  const down = landing.speedMph * Math.sin(rad(landing.descentDeg))
  const spin = landing.spinRpm / 1000
  const left = forward - settingValue(WEDGE_FIT.grab, type, firmness) * down - Math.exp(settingValue(WEDGE_FIT.lnBite, type, firmness)) * spin
  const releaseYds = Math.exp(settingValue(WEDGE_FIT.lnRun, type, firmness)) * Math.sign(left) * Math.abs(left) ** WEDGE_FIT.power
  const rollShare = 1 / (1 + Math.exp(-(WEDGE_FIT.rollShare.at40Deg + WEDGE_FIT.rollShare.per10Deg * (landing.descentDeg - 40) / 10
    + WEDGE_FIT.rollShare.per1000Rpm * (spin - 6))))
  return { releaseYds, rollShare }
}

/** The approach fit's release on a level stimp-11 green. */
const approachReleaseLevel11 = (landing: Landing, conditions: GreenConditions): number => {
  const type = TYPE_INDEX[conditions.courseType]
  const firmness = FIRM_INDEX[conditions.greenFirmness]
  const grab = settingValue(FIT.grab, type, firmness)
  const bite = Math.exp(settingValue(FIT.lnBite, type, firmness))
  const run = Math.exp(settingValue(FIT.lnRun, type, firmness))
  const forward = landing.speedMph * Math.cos(rad(landing.descentDeg))
  const down = landing.speedMph * Math.sin(rad(landing.descentDeg))
  const left = forward - grab * down - bite * (landing.spinRpm / 1000)
  return run * left * Math.abs(left)
}

/** Release on a level stimp-11 green and how much of it is roll, chips and approaches together. */
export type GreenReleaseShape = Readonly<{ rollShare: number; chipWeight: number }>
/** A full approach: three quarters roll, the approach slope rule. */
export const APPROACH_SHAPE: GreenReleaseShape = { rollShare: APPROACH_ROLL_SHARE, chipWeight: 0 }

export const greenReleaseParts = (landing: Landing, conditions: GreenConditions): { releaseYds: number } & GreenReleaseShape => {
  const [chipEnds, wedgeStarts, wedgeEnds, approachStarts] = WEDGE_BAND_MPH
  const pastChip = clamp((landing.speedMph - chipEnds) / (wedgeStarts - chipEnds), [0, 1])
  const approachWeight = clamp((landing.speedMph - wedgeEnds) / (approachStarts - wedgeEnds), [0, 1])
  const chipWeight = 1 - pastChip
  const wedgeWeight = pastChip * (1 - approachWeight)
  const approach = approachWeight > 0 ? approachReleaseLevel11(landing, conditions) : 0
  const chip = chipWeight > 0 ? chipReleaseLevel11(landing, conditions) : { releaseYds: 0, rollShare: 0 }
  const wedge = wedgeWeight > 0 ? wedgeReleaseLevel11(landing, conditions) : { releaseYds: 0, rollShare: 0 }
  return {
    releaseYds: approachWeight * approach + chipWeight * chip.releaseYds + wedgeWeight * wedge.releaseYds,
    rollShare: approachWeight * APPROACH_ROLL_SHARE + chipWeight * chip.rollShare + wedgeWeight * wedge.rollShare,
    // Chips and partial wedges take the slope on their roll share; a full approach keeps the approach rule.
    chipWeight: 1 - approachWeight,
  }
}

/** Release on a level green at the round's stimp from how the ball lands: speed (mph), descent (deg) and spin (rpm) at touchdown. */
export const greenReleaseFromLanding = (landing: Landing, conditions: GreenConditions): number => {
  const { releaseYds, rollShare } = greenReleaseParts(landing, conditions)
  return clamp(releaseYds * releaseConditionFactor(rollShare, conditions.stimp), RELEASE_RANGE_YDS)
}

/** How a ball landing like this releases: its roll share and how chip-like it is (for greenReleaseOnSlope). */
export const greenReleaseShape = (landing: Landing, conditions: GreenConditions): GreenReleaseShape => {
  const { rollShare, chipWeight } = greenReleaseParts(landing, conditions)
  return { rollShare, chipWeight }
}

/**
 * Landing speed and spin from the launch (GSPro, 197 shots of every kind on
 * 18 Nov 2026): landing speed to 1.5 mph, landing spin to about 30 rpm.
 */
export const landingFromLaunch = (arrival: FairwayArrival): { speedMph: number; descentDeg: number; spinRpm: number } => {
  const speed = clamp(arrival.ballSpeedMph, LIMITS.ballSpeedMph)
  const spin = clamp(arrival.spinRpm, LIMITS.spinRpm)
  const descentDeg = clamp(arrival.descentDeg, LIMITS.descentDeg)
  const speedMph = 22.67205 + 0.29093 * speed + 0.39414 * descentDeg - 0.78781 * (spin / 1000) - 0.0027779 * speed * descentDeg
  const kept = clamp(1.038776 - 0.001278 * speed - 0.001733 * descentDeg, [0.6, 0.95])
  return { speedMph, descentDeg, spinRpm: spin * kept }
}

/**
 * Yards of release on a level green for a shot that leaves the club like this
 * (ball speed and spin after any lie penalty) and comes down at this angle.
 * Negative means it spins back. Null without the numbers or the conditions.
 */
export const predictGreenRelease = (
  arrival: Partial<FairwayArrival> | null | undefined,
  conditions: GreenConditions | null | undefined,
): number | null => {
  if (!arrival || !conditions || !(conditions.courseType in TYPE_INDEX) || !(conditions.greenFirmness in FIRM_INDEX)) return null
  const { ballSpeedMph, spinRpm, descentDeg } = arrival
  const usable = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
  if (!usable(ballSpeedMph) || !usable(spinRpm) || !usable(descentDeg)) return null
  return greenReleaseFromLanding(landingFromLaunch({ ballSpeedMph, spinRpm, descentDeg }), conditions)
}

/** The 18 Nov slope rule's rolling friction (share of gravity) at stimp 11. */
export const GREEN_ROLL_FRICTION = 0.04253

/**
 * The release on a slope: `grade` is rise over run along the shot's line
 * (+ uphill). A ball coming back down the line meets the slope the other way.
 * `releaseYds` is the level release at this stimp (greenReleaseFromLanding).
 */
export const greenReleaseOnSlope = (
  releaseYds: number,
  grade: number | null | undefined,
  stimp: number | null = null,
  shape: GreenReleaseShape = APPROACH_SHAPE,
): number => {
  if (typeof grade !== 'number' || !Number.isFinite(grade)) return releaseYds
  const alongMotion = releaseYds >= 0 ? grade : -grade
  const friction = GREEN_ROLL_FRICTION * puttRollFriction(stimp) / puttRollFriction(REFERENCE_STIMP)
  const approach = releaseYds / clamp(1 + alongMotion / friction, [0.25, 4])
  if (shape.chipWeight <= 0) return approach
  const chip = releaseYds * releaseConditionFactor(shape.rollShare, stimp, alongMotion) / releaseConditionFactor(shape.rollShare, stimp, 0)
  return shape.chipWeight * chip + (1 - shape.chipWeight) * approach
}

export type GreenReleaseEstimate = Readonly<{
  conditions: GreenConditions
  /** Release on a level green in these conditions. */
  predictedYds: number
  /** The club's rollout on the range, which outcomes used before. */
  stockYds: number
  descentDeg: number
}>

/** The green release for a club's shot, with wind and elevation reaching it as a change in landing angle. */
export const estimateGreenRelease = (input: {
  arrival: Partial<FairwayArrival> | null | undefined
  descentDeltaDeg?: number | null
  stockRolloutYds: number
  conditions: GreenConditions | null | undefined
}): GreenReleaseEstimate | null => {
  const { arrival, conditions, stockRolloutYds } = input
  if (!arrival || !conditions || typeof arrival.descentDeg !== 'number') return null
  const delta = typeof input.descentDeltaDeg === 'number' && Number.isFinite(input.descentDeltaDeg)
    ? Math.max(-12, Math.min(12, input.descentDeltaDeg)) : 0
  const descentDeg = arrival.descentDeg + delta
  const predictedYds = predictGreenRelease({ ...arrival, descentDeg }, conditions)
  if (predictedYds == null) return null
  return { conditions, predictedYds, stockYds: stockRolloutYds, descentDeg }
}
