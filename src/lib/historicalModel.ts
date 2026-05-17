import { confidenceConfig } from './confidenceConfig'
import type { Club } from './bagConfig'
import type { SavedSession, Shot } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000

const parseTimestamp = (value: string) => {
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

export const sessionAgeInDays = (session: SavedSession, nowMs = Date.now()) =>
  Math.max(0, (nowMs - parseTimestamp(session.endedAt)) / DAY_MS)

export const isSystemOldExcludedSession = (
  session: SavedSession,
  nowMs = Date.now(),
  windowDays = confidenceConfig.historicalWindowDays,
) => sessionAgeInDays(session, nowMs) > windowDays

export const timeWeightForAgeDays = (
  ageInDays: number,
  lambda = confidenceConfig.historicalTimeDecayLambda,
) => Math.exp(-lambda * Math.max(ageInDays, 0))

export const sizeWeightForShotCount = (
  includedShotCount: number,
  targetShotCount = confidenceConfig.historicalSessionTargetShotCount,
) => {
  if (includedShotCount <= 0 || targetShotCount <= 0) {
    return 0
  }
  return Math.min(1, Math.sqrt(includedShotCount / targetShotCount))
}

export const isShotIncludedInAnalysis = (shot: Pick<Shot, 'included'>) =>
  shot.included !== false

export const includedClubShotsForSession = (
  session: SavedSession,
  club: Club,
) => session.shots.filter((shot) => shot.club === club && isShotIncludedInAnalysis(shot))

export const sessionHistoricalWeightForClub = (
  session: SavedSession,
  club: Club,
  nowMs = Date.now(),
  qualityWeight = 1,
) => {
  if (isSystemOldExcludedSession(session, nowMs)) {
    return 0
  }
  const includedCount = includedClubShotsForSession(session, club).length
  const timeWeight = timeWeightForAgeDays(sessionAgeInDays(session, nowMs))
  const sizeWeight = sizeWeightForShotCount(includedCount)
  return timeWeight * sizeWeight * qualityWeight
}

export const weightedAverageDefined = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
) => {
  let weightedSum = 0
  let totalWeight = 0

  values.forEach((value, index) => {
    const weight = weights[index]
    if (typeof value !== 'number' || typeof weight !== 'number' || weight <= 0) {
      return
    }
    weightedSum += value * weight
    totalWeight += weight
  })

  return totalWeight > 0 ? weightedSum / totalWeight : undefined
}

export const weightedAverageShots = (
  shots: Shot[],
  valueAccessor: (shot: Shot) => number | undefined,
  shotWeightAccessor: (shot: Shot) => number,
) =>
  weightedAverageDefined(
    shots.map(valueAccessor),
    shots.map(shotWeightAccessor),
  )

export const weightedSessionMetricAverage = (
  session: SavedSession,
  club: Club,
  valueAccessor: (shot: Shot) => number | undefined,
  shotWeightAccessor?: (shot: Shot) => number,
) => {
  const includedShots = includedClubShotsForSession(session, club)
  if (includedShots.length === 0) {
    return undefined
  }

  if (!shotWeightAccessor) {
    return weightedAverageDefined(
      includedShots.map(valueAccessor),
      includedShots.map(() => 1),
    )
  }

  return weightedAverageDefined(
    includedShots.map(valueAccessor),
    includedShots.map(shotWeightAccessor),
  )
}
