import { FAIRWAY_ROLL_SHOTS } from './fairwayRollData'
import type { Firmness } from './roundConditions'

/**
 * How far a ball rolls after landing on a GSPro fairway, from how it arrives
 * and the round's Course Type and Fairway Firmness.
 *
 * Why: GSPro 4.1.9 made roll depend on those two settings (a driver rolls 5 yd
 * on Soft/Soft and 36 on Firm/Firm), and the engine was crediting every shot
 * with the club's fixed range rollout whatever the round was set to.
 *
 * What it is: a smooth interpolation of 324 measured shots (fairwayRollData).
 * Per setting, ln(roll / ball speed) is a straight-line trend in descent angle
 * and spin plus a radial-basis correction over (descent, spin, ball speed).
 * It is exact near what was measured and falls back to the trend away from it,
 * so it cannot run wild on an unusual shot. Fitted only on designed shots it
 * predicted the 99 real stock shots to 0.6 yd on average (worst 3.4); holding
 * out each of the 324 shots in turn, 95% land within 1.6 yd.
 *
 * What it is not: it knows fairways only (not greens, not rough), level ground,
 * and a ball rolling along its line. The engine's surface, slope and touchdown
 * steps (rollModel.ts) still apply on top; wind and elevation reach it through
 * the descent angle (flightPhysics deltas).
 * Notes: tools/gspro_lie_lab/data/NOTES-model-2026-11-18.md.
 */
export type FairwayConditions = Readonly<{ courseType: Firmness; fairwayFirmness: Firmness }>

export type FairwayArrival = Readonly<{
  ballSpeedMph: number
  spinRpm: number
  descentDeg: number
}>

const LEVELS: readonly Firmness[] = ['soft', 'medium', 'firm']
/** Length scales of the correction: descent deg, spin in thousands of rpm, ln(ball speed). */
const SCALE = [22, 4, 1] as const
const NOISE = 0.02
/** Inputs are held inside what was measured (a little beyond), so the trend is never pushed far. */
const LIMITS = { ballSpeedMph: [55, 185], spinRpm: [1500, 11500], descentDeg: [9, 62] } as const

type Fit = Readonly<{ trend: readonly [number, number, number]; weights: readonly number[] }>

const features = (speed: number, spinK: number, descent: number): readonly [number, number, number] =>
  [descent / SCALE[0], spinK / SCALE[1], Math.log(speed) / SCALE[2]]

const POINTS = FAIRWAY_ROLL_SHOTS.map((row) => features(row[0], row[1], row[2]))

/** Solve A x = b by Gaussian elimination with partial pivoting (A is small and well conditioned). */
const solve = (matrix: number[][], rhs: number[]): number[] => {
  const n = rhs.length
  const a = matrix.map((row, i) => [...row, rhs[i]])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    for (let row = col + 1; row < n; row += 1) {
      const factor = a[row][col] / a[col][col]
      if (factor === 0) continue
      for (let k = col; k <= n; k += 1) a[row][k] -= factor * a[col][k]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = a[row][n]
    for (let k = row + 1; k < n; k += 1) sum -= a[row][k] * x[k]
    x[row] = sum / a[row][row]
  }
  return x
}

const kernel = (p: readonly number[], q: readonly number[]) =>
  Math.exp(-0.5 * ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2))

const fits = new Map<number, Fit>()

const fitFor = (settingIndex: number): Fit => {
  const cached = fits.get(settingIndex)
  if (cached) return cached
  const rows = FAIRWAY_ROLL_SHOTS
  const y = rows.map((row) => Math.log(row[3 + settingIndex] / row[0]))
  // Trend: least squares on [1, descent/10, spin] through the normal equations.
  const basis = rows.map((row) => [1, row[2] / 10, row[1]])
  const normal = [0, 1, 2].map((i) => [0, 1, 2].map((j) => basis.reduce((sum, b) => sum + b[i] * b[j], 0)))
  const moment = [0, 1, 2].map((i) => basis.reduce((sum, b, n) => sum + b[i] * y[n], 0))
  const trend = solve(normal, moment) as [number, number, number]
  const residual = y.map((value, n) => value - (trend[0] + trend[1] * basis[n][1] + trend[2] * basis[n][2]))
  const gram = POINTS.map((p, i) => POINTS.map((q, j) => kernel(p, q) + (i === j ? NOISE : 0)))
  const fit: Fit = { trend, weights: solve(gram, residual) }
  fits.set(settingIndex, fit)
  return fit
}

const clamp = (value: number, [low, high]: readonly [number, number]) => Math.min(high, Math.max(low, value))

/** Roll in yards on a level fairway for this arrival and these conditions; null when an input is missing. */
export const predictFairwayRoll = (arrival: Partial<FairwayArrival> | null | undefined, conditions: FairwayConditions | null | undefined): number | null => {
  if (!arrival || !conditions) return null
  const type = LEVELS.indexOf(conditions.courseType)
  const fairway = LEVELS.indexOf(conditions.fairwayFirmness)
  const { ballSpeedMph, spinRpm, descentDeg } = arrival
  if (type < 0 || fairway < 0) return null
  if (!(typeof ballSpeedMph === 'number' && ballSpeedMph > 0) || !(typeof spinRpm === 'number' && spinRpm >= 0)
    || !(typeof descentDeg === 'number' && descentDeg > 0)) return null
  const speed = clamp(ballSpeedMph, LIMITS.ballSpeedMph)
  const spinK = clamp(spinRpm, LIMITS.spinRpm) / 1000
  const descent = clamp(descentDeg, LIMITS.descentDeg)
  const fit = fitFor(type * 3 + fairway)
  const at = features(speed, spinK, descent)
  let value = fit.trend[0] + fit.trend[1] * (descent / 10) + fit.trend[2] * spinK
  for (let n = 0; n < POINTS.length; n += 1) value += fit.weights[n] * kernel(POINTS[n], at)
  return Math.exp(value) * speed
}

/** The Practice Range's fixed setup: what a player's range rollout was measured on (GSPro 4.1.9 on). */
export const RANGE_CONDITIONS: FairwayConditions = { courseType: 'medium', fairwayFirmness: 'medium' }

export type FairwayRollEstimate = Readonly<{
  conditions: FairwayConditions
  /** Roll the model expects on a level fairway under the round's conditions, yards. */
  predictedYds: number
  /** The club's rollout from the range, yards. */
  stockYds: number
  /** predicted / stock: what each shot's roll is multiplied by when the model is on. */
  scale: number
  /** Descent used, after wind and elevation. */
  descentDeg: number
}>

/** Never scale a club's roll by more than this either way. */
const MAX_SCALE = 6

/**
 * The scale to apply to a club's range rollout for the round's conditions.
 * Null when the club has no launch data, no rollout to scale, or no conditions.
 */
export const estimateFairwayRoll = (input: {
  arrival: Partial<FairwayArrival> | null | undefined
  /** Change in landing angle from wind and elevation (flight model: combined minus baseline), degrees. */
  descentDeltaDeg?: number | null
  stockRolloutYds: number
  conditions: FairwayConditions | null | undefined
}): FairwayRollEstimate | null => {
  const { arrival, conditions, stockRolloutYds } = input
  if (!arrival || !conditions || typeof arrival.descentDeg !== 'number') return null
  const delta = typeof input.descentDeltaDeg === 'number' && Number.isFinite(input.descentDeltaDeg)
    ? Math.max(-12, Math.min(12, input.descentDeltaDeg)) : 0
  const descentDeg = arrival.descentDeg + delta
  const predictedYds = predictFairwayRoll({ ...arrival, descentDeg }, conditions)
  if (predictedYds == null || !(stockRolloutYds > 0.25)) return null
  const scale = Math.min(MAX_SCALE, Math.max(1 / MAX_SCALE, predictedYds / stockRolloutYds))
  return { conditions, predictedYds, stockYds: stockRolloutYds, scale, descentDeg }
}
