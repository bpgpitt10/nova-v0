type WeightedPoint = {
  value: number
  weight: number
}

const toWeightedPoints = (
  values: readonly (number | null | undefined)[],
  weights: readonly (number | null | undefined)[],
): WeightedPoint[] =>
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

export const weightedAverage = (
  values: readonly (number | null | undefined)[],
  weights: readonly (number | null | undefined)[],
) => {
  const points = toWeightedPoints(values, weights)
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0)
  if (!(totalWeight > 0)) {
    return undefined
  }

  return (
    points.reduce((sum, point) => sum + point.value * point.weight, 0) /
    totalWeight
  )
}

export const weightedMedian = (
  values: readonly (number | null | undefined)[],
  weights: readonly (number | null | undefined)[],
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

export const weightedPercentile = (
  values: readonly (number | null | undefined)[],
  weights: readonly (number | null | undefined)[],
  percentile: number,
) => {
  const points = toWeightedPoints(values, weights).sort(
    (left, right) => left.value - right.value,
  )
  if (points.length === 0) {
    return undefined
  }

  const boundedPercentile = Math.min(100, Math.max(0, percentile))
  if (boundedPercentile === 0) {
    return points[0].value
  }

  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0)
  const threshold = totalWeight * (boundedPercentile / 100)
  let cumulativeWeight = 0

  for (const point of points) {
    cumulativeWeight += point.weight
    if (cumulativeWeight >= threshold) {
      return point.value
    }
  }

  return points[points.length - 1]?.value
}
