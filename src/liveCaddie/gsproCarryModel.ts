import { GSPRO_CARRY_SHOTS } from './gsproCarryData'

/**
 * GSPro's carry for a launch, straight from GSPro.
 *
 * Looper's own flight model runs long against GSPro (10 yd on average over
 * these launches, 6 yd after tuning its drag and lift), so it is kept for
 * what it does well, the change wind and elevation make. When the launch
 * itself changes (a lie takes speed and spin, a slope turns the launch angle),
 * the carry that follows is read from this model instead: it interpolates
 * GSPro's measured carries over ball speed, launch angle and spin.
 *
 * ln(carry) is a smooth trend plus a radial-basis correction through the
 * measured shots. Holding each shot out of the fit it is right to 1.4 yd on
 * average (3 yd at the 90th percentile; the worst are corners of the designed
 * grid that no club produces).
 */

export type CarryLaunch = Readonly<{ ballSpeedMph: number; vlaDeg: number; totalSpinRpm: number }>

const SCALE = [0.35, 10, 4] as const
const NOISE = 1e-4
/** What was measured: outside this the model gives no answer. */
const RANGE = { ballSpeedMph: [35, 170], vlaDeg: [5, 33], totalSpinRpm: [1500, 14000] } as const

const trendTerms = (speed: number, vla: number, spinK: number) =>
  [1, Math.log(speed), vla / 10, spinK / 5, (vla / 10) ** 2, (spinK / 5) * (vla / 10)]
const place = (speed: number, vla: number, spinK: number) => [Math.log(speed) / SCALE[0], vla / SCALE[1], spinK / SCALE[2]]
const kernel = (a: readonly number[], b: readonly number[]) =>
  Math.exp(-0.5 * ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2))

/** Solve A x = b (A square, modified in place). */
const solve = (A: number[][], b: number[]): number[] => {
  const n = b.length
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row
    ;[A[col], A[pivot]] = [A[pivot], A[col]]
    ;[b[col], b[pivot]] = [b[pivot], b[col]]
    for (let row = col + 1; row < n; row += 1) {
      const factor = A[row][col] / A[col][col]
      if (factor === 0) continue
      for (let k = col; k < n; k += 1) A[row][k] -= factor * A[col][k]
      b[row] -= factor * b[col]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row]
    for (let k = row + 1; k < n; k += 1) sum -= A[row][k] * x[k]
    x[row] = sum / A[row][row]
  }
  return x
}

export type CarryFit = Readonly<{ trend: number[]; weights: number[]; places: number[][] }>

/** Fit the model to a set of measured shots (ball speed, launch, spin rpm, carry). */
export const fitGsproCarry = (shots: ReadonlyArray<readonly [number, number, number, number]>): CarryFit => {
  const terms = shots.map(([speed, vla, spin]) => trendTerms(speed, vla, spin / 1000))
  const target = shots.map((shot) => Math.log(shot[3]))
  const size = terms[0].length
  const normal = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => terms.reduce((sum, t) => sum + t[i] * t[j], 0)))
  const trend = solve(normal, Array.from({ length: size }, (_, i) => terms.reduce((sum, t, row) => sum + t[i] * target[row], 0)))
  const places = shots.map(([speed, vla, spin]) => place(speed, vla, spin / 1000))
  const gram = places.map((a, i) => places.map((b, j) => kernel(a, b) + (i === j ? NOISE : 0)))
  const weights = solve(gram, target.map((value, row) => value - terms[row].reduce((sum, t, i) => sum + t * trend[i], 0)))
  return { trend, weights, places }
}

export const carryFromFit = (fit: CarryFit, launch: CarryLaunch): number | null => {
  const { ballSpeedMph: speed, vlaDeg: vla, totalSpinRpm: spin } = launch
  const inside = (value: number, [low, high]: readonly [number, number]) => Number.isFinite(value) && value >= low && value <= high
  if (!inside(speed, RANGE.ballSpeedMph) || !inside(vla, RANGE.vlaDeg) || !inside(spin, RANGE.totalSpinRpm)) return null
  const spinK = spin / 1000
  const at = place(speed, vla, spinK)
  let value = trendTerms(speed, vla, spinK).reduce((sum, t, i) => sum + t * fit.trend[i], 0)
  fit.places.forEach((p, i) => { value += fit.weights[i] * kernel(at, p) })
  return Math.exp(value)
}

let cached: CarryFit | null = null

/** GSPro's carry (yd, level ground, sea level, no wind) for this launch; null outside what was measured. */
export const predictGsproCarry = (launch: Partial<CarryLaunch> | null | undefined): number | null => {
  if (!launch || typeof launch.ballSpeedMph !== 'number' || typeof launch.vlaDeg !== 'number' || typeof launch.totalSpinRpm !== 'number') return null
  cached ??= fitGsproCarry(GSPRO_CARRY_SHOTS)
  return carryFromFit(cached, launch as CarryLaunch)
}

/**
 * How a changed launch changes carry, as a share of the original (0.9 = 10%
 * shorter). Null when either launch is outside what was measured.
 */
export const gsproCarryRatio = (from: Partial<CarryLaunch> | null | undefined, to: Partial<CarryLaunch> | null | undefined): number | null => {
  const before = predictGsproCarry(from)
  const after = predictGsproCarry(to)
  return before != null && after != null && before > 1 ? after / before : null
}
