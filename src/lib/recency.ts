import type { SavedSession } from '../types'

export const recencyWeightForIndex = (
  index: number,
  decayStrength: number,
  minWeightFloor: number,
) => {
  const boundedFloor = Math.min(Math.max(minWeightFloor, 0), 1)
  const boundedDecay = Math.max(decayStrength, 0)
  const rawWeight = Math.exp(-boundedDecay * Math.max(index, 0))
  return Math.max(boundedFloor, rawWeight)
}

const parseTime = (value: string) => {
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

export const sortSessionsNewestFirst = (sessions: SavedSession[]) =>
  [...sessions].sort(
    (left, right) => parseTime(right.endedAt) - parseTime(left.endedAt),
  )

export const buildSessionRecencyWeights = (
  sessions: SavedSession[],
  decayStrength: number,
  minWeightFloor: number,
) => {
  const sorted = sortSessionsNewestFirst(sessions)
  return new Map(
    sorted.map((session, index) => [
      session.id,
      recencyWeightForIndex(index, decayStrength, minWeightFloor),
    ]),
  )
}

export const weightedAverage = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
) => {
  let weightedSum = 0
  let weightSum = 0

  values.forEach((value, index) => {
    const weight = weights[index]
    if (typeof value !== 'number' || typeof weight !== 'number' || weight <= 0) {
      return
    }

    weightedSum += value * weight
    weightSum += weight
  })

  return weightSum > 0 ? weightedSum / weightSum : null
}

export const weightedStandardDeviation = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
) => {
  const mean = weightedAverage(values, weights)
  if (typeof mean !== 'number') {
    return null
  }

  let weightedVariance = 0
  let weightSum = 0
  values.forEach((value, index) => {
    const weight = weights[index]
    if (typeof value !== 'number' || typeof weight !== 'number' || weight <= 0) {
      return
    }

    weightedVariance += weight * (value - mean) ** 2
    weightSum += weight
  })

  return weightSum > 0 ? Math.sqrt(weightedVariance / weightSum) : null
}
