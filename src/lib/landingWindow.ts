/**
 * Landing window: how much room a club needs, from its real swings.
 *
 * Width and depth are the middle 80% of offline and of carry (10th to 90th
 * percentile on each axis). The left / on line / right split uses a band that
 * grows with the club: ±4% of median carry, at least ±5 yd (about ±10 yd for a
 * 240-yd driver, ±5 yd for a wedge). Offline is negative left, positive right.
 */

export type LandingPoint = Readonly<{ carry: number; offline: number }>

export type LandingWindow = {
  swings: number
  width: number
  depth: number
  offlineLow: number
  offlineHigh: number
  carryLow: number
  carryHigh: number
  onLineBand: number
  leftPct: number
  onLinePct: number
  rightPct: number
}

export const LANDING_WINDOW_MIN_SWINGS = 8

const quantile = (sorted: readonly number[], q: number) => {
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/** Whole-number percentages that add up to 100. */
const balancedPercents = (counts: readonly number[]) => {
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total === 0) return counts.map(() => 0)
  const raw = counts.map((count) => (count / total) * 100)
  const floors = raw.map(Math.floor)
  let remainder = 100 - floors.reduce((sum, value) => sum + value, 0)
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction)
  for (const { index } of order) {
    if (remainder <= 0) break
    floors[index] += 1
    remainder -= 1
  }
  return floors
}

export const buildLandingWindow = (points: readonly LandingPoint[]): LandingWindow | null => {
  const usable = points.filter((point) => Number.isFinite(point.carry) && Number.isFinite(point.offline))
  if (usable.length < LANDING_WINDOW_MIN_SWINGS) return null

  const carries = usable.map((point) => point.carry).sort((a, b) => a - b)
  const offlines = usable.map((point) => point.offline).sort((a, b) => a - b)
  const carryLow = quantile(carries, 0.1)
  const carryHigh = quantile(carries, 0.9)
  const offlineLow = quantile(offlines, 0.1)
  const offlineHigh = quantile(offlines, 0.9)
  const onLineBand = Math.max(5, Math.round(quantile(carries, 0.5) * 0.04))

  const left = usable.filter((point) => point.offline < -onLineBand).length
  const right = usable.filter((point) => point.offline > onLineBand).length
  const onLine = usable.length - left - right
  const [leftPct, onLinePct, rightPct] = balancedPercents([left, onLine, right])

  return {
    swings: usable.length,
    width: offlineHigh - offlineLow,
    depth: carryHigh - carryLow,
    offlineLow,
    offlineHigh,
    carryLow,
    carryHigh,
    onLineBand,
    leftPct,
    onLinePct,
    rightPct,
  }
}
