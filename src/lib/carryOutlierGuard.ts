import { weightedAverage, weightedStandardDeviation } from './recency'

const toWeightedPoints = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
) =>
  values
    .map((value, index) => ({ value, weight: weights[index] }))
    .filter(
      (point): point is { value: number; weight: number } =>
        typeof point.value === 'number' &&
        Number.isFinite(point.value) &&
        typeof point.weight === 'number' &&
        Number.isFinite(point.weight) &&
        point.weight > 0,
    )

export const weightedMedianValue = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
) => {
  const points = toWeightedPoints(values, weights).sort(
    (left, right) => left.value - right.value,
  )
  if (points.length === 0) {
    return undefined
  }

  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0)
  const threshold = totalWeight * 0.5
  let cumulativeWeight = 0

  for (const point of points) {
    cumulativeWeight += point.weight
    if (cumulativeWeight >= threshold) {
      return point.value
    }
  }

  return points[points.length - 1]?.value
}

export const guardedWeightedCarryMean = (
  carryValues: Array<number | undefined>,
  weights: Array<number | undefined>,
  thresholdPct: number,
  thresholdFloorYards: number,
) => {
  const uncappedWeightedMean = weightedAverage(carryValues, weights)
  const typicalCarry = weightedMedianValue(carryValues, weights)

  if (typeof typicalCarry !== 'number') {
    return typeof uncappedWeightedMean === 'number' ? uncappedWeightedMean : undefined
  }

  const carryOutlierThreshold = Math.max(
    thresholdFloorYards,
    thresholdPct * typicalCarry,
  )

  const nonOutlierPoints = toWeightedPoints(carryValues, weights).filter(
    (point) => Math.abs(point.value - typicalCarry) <= carryOutlierThreshold,
  )

  const guardedMean = weightedAverage(
    nonOutlierPoints.map((point) => point.value),
    nonOutlierPoints.map((point) => point.weight),
  )

  if (typeof guardedMean === 'number') {
    return guardedMean
  }

  return typeof uncappedWeightedMean === 'number' ? uncappedWeightedMean : undefined
}

export const guardedWeightedCarryStdDev = (
  carryValues: Array<number | undefined>,
  weights: Array<number | undefined>,
  thresholdPct: number,
  thresholdFloorYards: number,
  minGuardedSampleSize = 3,
) => {
  const fallbackStdDev = weightedStandardDeviation(carryValues, weights)
  const typicalCarry = weightedMedianValue(carryValues, weights)

  if (typeof typicalCarry !== 'number') {
    return typeof fallbackStdDev === 'number' ? fallbackStdDev : undefined
  }

  const carryOutlierThreshold = Math.max(
    thresholdFloorYards,
    thresholdPct * typicalCarry,
  )

  const nonOutlierPoints = toWeightedPoints(carryValues, weights).filter(
    (point) => Math.abs(point.value - typicalCarry) <= carryOutlierThreshold,
  )

  if (nonOutlierPoints.length < minGuardedSampleSize) {
    return typeof fallbackStdDev === 'number' ? fallbackStdDev : undefined
  }

  const guardedStdDev = weightedStandardDeviation(
    nonOutlierPoints.map((point) => point.value),
    nonOutlierPoints.map((point) => point.weight),
  )

  return typeof guardedStdDev === 'number' ? guardedStdDev : undefined
}
