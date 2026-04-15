import { weightedAverage, weightedStandardDeviation } from './recency'

type WeightedPoint = {
  value: number
  weight: number
}

const toWeightedPoints = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
) =>
  values
    .map((value, index) => ({ value, weight: weights[index] }))
    .filter(
      (point): point is WeightedPoint =>
        typeof point.value === 'number' &&
        Number.isFinite(point.value) &&
        typeof point.weight === 'number' &&
        Number.isFinite(point.weight) &&
        point.weight > 0,
    )

export const weightedTrimmedMean = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
  trimPct: number,
) => {
  const points = toWeightedPoints(values, weights).sort((left, right) => left.value - right.value)
  // Robust tail treatment becomes more trustworthy once the sample reaches double digits.
  if (points.length < 10) {
    const fallback = weightedAverage(values, weights)
    return typeof fallback === 'number' ? fallback : undefined
  }

  const boundedTrimPct = Math.min(Math.max(trimPct, 0), 0.49)
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0)
  const trimWeight = totalWeight * boundedTrimPct

  let remainingLowTrim = trimWeight
  let remainingHighTrim = trimWeight

  const trimmed = points.map((point) => ({ ...point }))

  for (let index = 0; index < trimmed.length && remainingLowTrim > 0; index += 1) {
    const applied = Math.min(trimmed[index].weight, remainingLowTrim)
    trimmed[index].weight -= applied
    remainingLowTrim -= applied
  }

  for (let index = trimmed.length - 1; index >= 0 && remainingHighTrim > 0; index -= 1) {
    const applied = Math.min(trimmed[index].weight, remainingHighTrim)
    trimmed[index].weight -= applied
    remainingHighTrim -= applied
  }

  const kept = trimmed.filter((point) => point.weight > 0)
  if (kept.length === 0) {
    const fallback = weightedAverage(values, weights)
    return typeof fallback === 'number' ? fallback : undefined
  }

  const trimmedAverage = weightedAverage(
    kept.map((point) => point.value),
    kept.map((point) => point.weight),
  )
  return typeof trimmedAverage === 'number' ? trimmedAverage : undefined
}

export const weightedWinsorizedStdDev = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
  trimPct: number,
) => {
  const points = toWeightedPoints(values, weights).sort((left, right) => left.value - right.value)
  if (points.length < 10) {
    const fallback = weightedStandardDeviation(values, weights)
    return typeof fallback === 'number' ? fallback : undefined
  }

  const boundedTrimPct = Math.min(Math.max(trimPct, 0), 0.49)
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0)
  const lowerThreshold = totalWeight * boundedTrimPct
  const upperThreshold = totalWeight * (1 - boundedTrimPct)

  let cumulativeWeight = 0
  let lowerBound: number | undefined
  let upperBound: number | undefined

  for (const point of points) {
    cumulativeWeight += point.weight
    if (lowerBound === undefined && cumulativeWeight >= lowerThreshold) {
      lowerBound = point.value
      break
    }
  }

  cumulativeWeight = 0
  for (const point of points) {
    cumulativeWeight += point.weight
    if (cumulativeWeight >= upperThreshold) {
      upperBound = point.value
      break
    }
  }

  if (lowerBound === undefined) {
    lowerBound = points[0]?.value
  }
  if (upperBound === undefined) {
    upperBound = points[points.length - 1]?.value
  }

  const winsorizedValues = points.map((point) =>
    Math.min(Math.max(point.value, lowerBound ?? point.value), upperBound ?? point.value),
  )
  const winsorizedStdDev = weightedStandardDeviation(
    winsorizedValues,
    points.map((point) => point.weight),
  )
  return typeof winsorizedStdDev === 'number' ? winsorizedStdDev : undefined
}
