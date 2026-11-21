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
 * Stimp (20 Nov, to be checked at stimp 8 and 13 on Briarwood West): a
 * stimpmeter reading is how far a ball rolls on the flat from a fixed speed,
 * so the green's rolling friction goes as 1/stimp. The bounce (grab and bite,
 * set by course type and firmness) is taken to be the same at every stimp and
 * only the roll after it to change: the release scales as stimp / 11, and the
 * slope correction uses that stimp's friction. tools/gspro_lie_lab/
 * check_stimp_release.mjs tests exactly this on the shots.
 *
 * Shape (a bounce, then a roll): the ball lands with a forward speed and a
 * downward speed. The green takes forward speed in proportion to the downward
 * speed (`grab`) and to the backspin (`bite`); what is left, squared, is the
 * release (`run`). Enough spin makes it negative: the ball comes back. The
 * three numbers change with course type and firmness. Uphill shortens the
 * release as a rolling ball's own friction would (0.043 g at stimp 11, which
 * is what a stimpmeter reading of 11 works out to).
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

/** How much further the ball rolls after the bounce than at stimp 11 (rolling friction goes as 1/stimp). */
export const stimpReleaseFactor = (stimp: number | null | undefined): number => usableStimp(stimp) / REFERENCE_STIMP

/** Bentgrass, Bermuda, Links in GSPro's own order (its log writes 0, 1, 2). */
const TYPE_INDEX: Record<Firmness, 0 | 1 | 2> = { soft: 0, medium: 1, firm: 2 }
const FIRM_INDEX: Record<Firmness, 0 | 1 | 2> = { soft: 0, medium: 1, firm: 2 }

/** Fitted 18 Nov 2026 (tools/fixtures/green-release-2026-11-18.json). Bermuda soft is the base. */
const FIT = {
  grab: { base: 0.48369, bentgrass: 0.38129, links: -0.1685, perFirmness: -0.17545 },
  lnBite: { base: 0.61904, bentgrass: -0.76792, links: -0.06312, perFirmness: 0.24487 },
  lnRun: { base: -3.60297, bentgrass: 0.15028, links: -0.06302, perFirmness: -0.10408 },
} as const
/** Rolling friction of the green as a share of gravity (stimp 11). */
export const GREEN_ROLL_FRICTION = 0.04253

/** Rolling friction at a stimp: a faster green has less. */
export const greenRollFriction = (stimp: number | null | undefined): number =>
  GREEN_ROLL_FRICTION * REFERENCE_STIMP / usableStimp(stimp)

const LIMITS = { ballSpeedMph: [35, 150], spinRpm: [1500, 13500], descentDeg: [25, 58] } as const
const RELEASE_RANGE_YDS = [-10, 35] as const
const clamp = (value: number, [low, high]: readonly [number, number]) => Math.min(high, Math.max(low, value))
const rad = (deg: number) => (deg * Math.PI) / 180

const settingValue = (
  part: { base: number; bentgrass: number; links: number; perFirmness: number },
  type: 0 | 1 | 2,
  firmness: 0 | 1 | 2,
) => part.base + (type === 0 ? part.bentgrass : 0) + (type === 2 ? part.links : 0) + part.perFirmness * firmness

/** Release on a level green from how the ball lands: speed (mph), descent (deg) and spin (rpm) at touchdown. */
export const greenReleaseFromLanding = (
  landing: { speedMph: number; descentDeg: number; spinRpm: number },
  conditions: GreenConditions,
): number => {
  const type = TYPE_INDEX[conditions.courseType]
  const firmness = FIRM_INDEX[conditions.greenFirmness]
  const grab = settingValue(FIT.grab, type, firmness)
  const bite = Math.exp(settingValue(FIT.lnBite, type, firmness))
  const run = Math.exp(settingValue(FIT.lnRun, type, firmness))
  const forward = landing.speedMph * Math.cos(rad(landing.descentDeg))
  const down = landing.speedMph * Math.sin(rad(landing.descentDeg))
  const left = forward - grab * down - bite * (landing.spinRpm / 1000)
  return clamp(run * left * Math.abs(left) * stimpReleaseFactor(conditions.stimp), RELEASE_RANGE_YDS)
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

/**
 * The release on a slope: `grade` is rise over run along the shot's line
 * (+ uphill). A ball coming back down the line meets the slope the other way.
 */
export const greenReleaseOnSlope = (
  releaseYds: number,
  grade: number | null | undefined,
  stimp: number | null = null,
): number => {
  if (typeof grade !== 'number' || !Number.isFinite(grade)) return releaseYds
  const alongMotion = releaseYds >= 0 ? grade : -grade
  return releaseYds / clamp(1 + alongMotion / greenRollFriction(stimp), [0.25, 4])
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
