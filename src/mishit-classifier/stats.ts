export const finiteNumbers = (values: Array<number | undefined>) =>
  values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

export const median = (values: Array<number | undefined>) => {
  const sorted = finiteNumbers(values).sort((left, right) => left - right)
  if (sorted.length === 0) {
    return undefined
  }

  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[middle]
  }

  return (sorted[middle - 1] + sorted[middle]) / 2
}

export const medianAbsoluteDeviation = (
  values: Array<number | undefined>,
  center = median(values),
) => {
  if (typeof center !== 'number') {
    return undefined
  }

  return median(
    finiteNumbers(values).map((value) => Math.abs(value - center)),
  )
}

export const relativeChange = (before: number | undefined, after: number | undefined) => {
  if (typeof before !== 'number' || typeof after !== 'number') {
    return undefined
  }
  const denominator = Math.max(Math.abs(before), 1e-9)
  return Math.abs(after - before) / denominator
}

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

export const uniqueStrings = (values: string[]) => [...new Set(values)]
