import { confidenceConfig } from './confidenceConfig'
import {
  weightedAverage,
  weightedStandardDeviation,
} from './recency'
import {
  includedClubShotsForSession,
  isSystemOldExcludedSession,
  sessionHistoricalWeightForClub,
} from './historicalModel'
import type { Club, ReviewClubSummary, SavedSession, Shot } from '../types'

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value))

const weightedAverageFromShots = (
  shots: Shot[],
  valueAccessor: (shot: Shot) => number | undefined,
  weightAccessor: (shot: Shot) => number,
) =>
  weightedAverage(
    shots.map(valueAccessor),
    shots.map(weightAccessor),
  )

const weightedStdDevFromShots = (
  shots: Shot[],
  valueAccessor: (shot: Shot) => number | undefined,
  weightAccessor: (shot: Shot) => number,
) =>
  weightedStandardDeviation(
    shots.map(valueAccessor),
    shots.map(weightAccessor),
  )

const oneDecimal = (value: number | null) =>
  value === null ? null : Number(value.toFixed(1))

const includedClubShots = (club: Club, shots: Shot[]) =>
  shots.filter((shot) => shot.club === club && shot.included)

const getRankWeight = (shot: Shot) => {
  const key = typeof shot.shotRanking === 'undefined' ? '' : String(shot.shotRanking)
  return confidenceConfig.distanceWindow.rankWeights[key] ?? 1
}

const weightedAverageCarry = (
  shots: Shot[],
  recencyWeightForShot: (shot: Shot) => number,
) => {
  const carryShots = shots.filter(
    (shot): shot is Shot & { carryYards: number } =>
      typeof shot.carryYards === 'number',
  )
  if (carryShots.length === 0) {
    return null
  }

  const weighted = carryShots.reduce(
    (accumulator, shot) => {
      const weight = getRankWeight(shot) * recencyWeightForShot(shot)
      if (weight <= 0) {
        return accumulator
      }
      return {
        total: accumulator.total + shot.carryYards * weight,
        weight: accumulator.weight + weight,
      }
    },
    { total: 0, weight: 0 },
  )

  return weighted.weight > 0 ? weighted.total / weighted.weight : null
}

const scoreFromTarget = (value: number | null, target: number) => {
  if (value === null) {
    return 0
  }

  return clamp(100 - (value / target) * 100)
}

const scoreFromRange = (
  value: number | undefined,
  [min, max]: [number, number],
): number | null => {
  if (typeof value !== 'number') {
    return null
  }

  if (value >= min && value <= max) {
    return 100
  }

  const miss = value < min ? min - value : value - max
  const span = Math.max(max - min, 1)
  return clamp(100 - (miss / span) * 100)
}

const scoreAbsolute = (value: number | undefined, maxAbs: number): number | null => {
  if (typeof value !== 'number') {
    return null
  }

  return clamp(100 - (Math.abs(value) / maxAbs) * 100)
}

const buildDirectionScore = (
  club: Club,
  shots: Shot[],
  recencyWeightForShot: (shot: Shot) => number,
) => {
  const offlineShots = shots.filter(
    (shot): shot is Shot & { offlineYards: number } =>
      typeof shot.offlineYards === 'number',
  )
  const offlineValues = offlineShots.map((shot) => shot.offlineYards)
  const offlineWeights = offlineShots.map((shot) => recencyWeightForShot(shot))
  if (offlineValues.length === 0) {
    return { score: 0, note: 'No offline data' }
  }

  const targetWidth = confidenceConfig.directionWindow.targetWidthByClub[club]
  const maxOffline = targetWidth * confidenceConfig.directionWindow.maxOfflineMultiplier
  const averageAbsoluteOffline =
    weightedAverage(
      offlineValues.map((value) => Math.abs(value)),
      offlineWeights,
    ) ?? 0
  const baseScore = clamp(100 - (averageAbsoluteOffline / targetWidth) * 100)

  const totalWeight = offlineWeights.reduce((sum, weight) => sum + weight, 0)
  const extremeMissWeight = offlineShots.reduce(
    (sum, shot) =>
      sum +
      (Math.abs(shot.offlineYards) >= maxOffline ? recencyWeightForShot(shot) : 0),
    0,
  )
  const extremePenalty =
    totalWeight > 0 ? clamp((extremeMissWeight / totalWeight) * 100, 0, 40) : 0

  const missesLeftWeight = offlineShots.reduce(
    (sum, shot) =>
      sum +
      (shot.offlineYards < -confidenceConfig.directionWindow.sideSwitchThresholdYards
        ? recencyWeightForShot(shot)
        : 0),
    0,
  )
  const missesRightWeight = offlineShots.reduce(
    (sum, shot) =>
      sum +
      (shot.offlineYards > confidenceConfig.directionWindow.sideSwitchThresholdYards
        ? recencyWeightForShot(shot)
        : 0),
    0,
  )
  const missesLeft = totalWeight > 0 && missesLeftWeight / totalWeight >= 0.1
  const missesRight = totalWeight > 0 && missesRightWeight / totalWeight >= 0.1
  const twoWayPenalty =
    missesLeft && missesRight ? confidenceConfig.directionWindow.twoWayMissPenalty : 0

  return {
    score: clamp(baseScore - extremePenalty - twoWayPenalty),
    note:
      twoWayPenalty > 0
        ? `Avg abs offline ${oneDecimal(averageAbsoluteOffline)} yd with two-way miss`
        : `Avg abs offline ${oneDecimal(averageAbsoluteOffline)} yd`,
  }
}

const buildDistanceScore = (
  shots: Shot[],
  recencyWeightForShot: (shot: Shot) => number,
) => {
  const carryShots = shots.filter(
    (shot): shot is Shot & { carryYards: number } =>
      typeof shot.carryYards === 'number',
  )
  const carryValues = carryShots.map((shot) => shot.carryYards)
  if (carryShots.length === 0) {
    return { score: 0, note: 'No carry data' }
  }

  const carryAnchor = weightedAverageCarry(shots, recencyWeightForShot)
  const carryWeights = carryShots.map(
    (shot) => recencyWeightForShot(shot) * getRankWeight(shot),
  )
  const carryStdDev = weightedStandardDeviation(carryValues, carryWeights) ?? 0
  const averageDeviation = oneDecimal(
    carryAnchor === null
      ? null
      : weightedAverage(
          carryValues.map((value) => Math.abs(value - carryAnchor)),
          carryWeights,
        ),
  )
  const anchorScore = scoreFromTarget(
    averageDeviation,
    confidenceConfig.distanceWindow.anchorToleranceYards,
  )
  const consistencyScore = scoreFromTarget(
    carryStdDev,
    confidenceConfig.distanceWindow.consistencyTargetStdDevYards,
  )

  return {
    score: Math.round(anchorScore * 0.55 + consistencyScore * 0.45),
    note:
      carryAnchor === null
        ? 'No carry anchor'
        : `Anchor ${oneDecimal(carryAnchor)} yd, std dev ${oneDecimal(carryStdDev)} yd`,
  }
}

const buildFlightQualityScore = (
  shots: Shot[],
  recencyWeightForShot: (shot: Shot) => number,
) => {
  let scoreTotal = 0
  let scoreCount = 0
  let missingFieldCount = 0

  shots.forEach((shot) => {
    const recencyWeight = recencyWeightForShot(shot)
    const shotScores = [
      scoreFromRange(
        shot.ballSpeedMetersPerSecond,
        confidenceConfig.flightQuality.ballSpeedRange,
      ),
      scoreFromRange(
        shot.verticalLaunchAngleDegrees,
        confidenceConfig.flightQuality.verticalLaunchRange,
      ),
      scoreAbsolute(
        shot.horizontalLaunchAngleDegrees,
        confidenceConfig.flightQuality.horizontalLaunchAbsMax,
      ),
      scoreFromRange(shot.totalSpinRpm, confidenceConfig.flightQuality.totalSpinRange),
      scoreAbsolute(shot.spinAxisDegrees, confidenceConfig.flightQuality.spinAxisAbsMax),
    ]

    shotScores.forEach((value) => {
      if (value === null) {
        missingFieldCount += recencyWeight
      } else {
        scoreTotal += value * recencyWeight
        scoreCount += recencyWeight
      }
    })

    if (typeof shot.shotRanking !== 'undefined') {
      scoreTotal += clamp(getRankWeight(shot) * 90) * recencyWeight
      scoreCount += recencyWeight
    }
  })

  if (scoreCount === 0) {
    return { score: 0, note: 'Missing raw flight fields' }
  }

  const averageScore = scoreTotal / scoreCount
  const penalty =
    missingFieldCount * confidenceConfig.flightQuality.missingFieldPenaltyPerField

  return {
    score: clamp(Math.round(averageScore - penalty)),
    note:
      missingFieldCount > 0
        ? `Missing ${missingFieldCount} raw field values`
        : 'Raw flight fields available',
  }
}

const buildPatternStabilityScore = (
  shots: Shot[],
  supportingSessions: SavedSession[],
  club: Club,
  recencyWeightForShot: (shot: Shot) => number,
) => {
  const carryStdDev = weightedStdDevFromShots(
    shots,
    (shot) => shot.carryYards,
    recencyWeightForShot,
  )
  const offlineStdDev = weightedStdDevFromShots(
    shots,
    (shot) => shot.offlineYards,
    recencyWeightForShot,
  )
  const carryStability = scoreFromTarget(
    carryStdDev,
    confidenceConfig.patternStability.carryStdDevTarget,
  )
  const offlineStability = scoreFromTarget(
    offlineStdDev,
    confidenceConfig.patternStability.offlineStdDevTarget,
  )

  const firstHalf = shots.slice(0, Math.ceil(shots.length / 2))
  const secondHalf = shots.slice(Math.ceil(shots.length / 2))
  const carryDrift = Math.abs(
    (weightedAverageFromShots(firstHalf, (shot) => shot.carryYards, recencyWeightForShot) ??
      0) -
      (weightedAverageFromShots(secondHalf, (shot) => shot.carryYards, recencyWeightForShot) ??
        0),
  )
  const directionDrift = Math.abs(
    (weightedAverageFromShots(
      firstHalf,
      (shot) => shot.offlineYards,
      recencyWeightForShot,
    ) ?? 0) -
      (weightedAverageFromShots(
        secondHalf,
        (shot) => shot.offlineYards,
        recencyWeightForShot,
      ) ?? 0),
  )
  const driftScore = scoreFromTarget(
    Math.max(carryDrift, directionDrift),
    confidenceConfig.patternStability.driftTargetYards,
  )

  const signedOffline = shots.flatMap((shot) =>
    typeof shot.offlineYards === 'number' &&
    Math.abs(shot.offlineYards) >= confidenceConfig.directionWindow.sideSwitchThresholdYards
      ? [{ sign: Math.sign(shot.offlineYards), weight: recencyWeightForShot(shot) }]
      : [],
  )
  const weightedSwitches = signedOffline.reduce(
    (sum, value, index) =>
      index > 0 && value.sign !== signedOffline[index - 1].sign
        ? sum + (value.weight + signedOffline[index - 1].weight) / 2
        : sum,
    0,
  )
  const possibleSwitchWeight = signedOffline.slice(1).reduce((sum, value) => sum + value.weight, 0)
  const sideSwitchPenalty =
    possibleSwitchWeight > 0 ? (weightedSwitches / possibleSwitchWeight) * 25 : 0

  const supportSessions = supportingSessions.filter((session) =>
    session.shots.some((shot) => shot.club === club && shot.included),
  )
  const supportBonus = Math.min(
    supportSessions.length * confidenceConfig.patternStability.sessionSupportBonusPerSession,
    confidenceConfig.patternStability.maxSessionSupportBonus,
  )

  const base =
    (carryStability * 0.35 + offlineStability * 0.25 + driftScore * 0.4) - sideSwitchPenalty

  return {
    score: clamp(Math.round(base + supportBonus)),
    note: `Drift ${oneDecimal(Math.max(carryDrift, directionDrift))} yd, support ${supportSessions.length} sessions`,
  }
}

const buildDataConfidenceScore = (
  shots: Shot[],
  sessionCount: number,
  recencyWeightForShot: (shot: Shot) => number,
) => {
  const weightedShotCount = shots.reduce(
    (sum, shot) => sum + recencyWeightForShot(shot),
    0,
  )
  const includedShotScore = clamp(
    (weightedShotCount / confidenceConfig.dataConfidence.targetIncludedShots) * 100,
  )
  const sessionScore = clamp(
    (sessionCount / confidenceConfig.dataConfidence.targetSessions) * 100,
  )
  const missingRequiredFields = shots.reduce((sum, shot) => {
    const hasMissingField =
      typeof shot.ballSpeedMetersPerSecond !== 'number' ||
      typeof shot.verticalLaunchAngleDegrees !== 'number' ||
      typeof shot.horizontalLaunchAngleDegrees !== 'number' ||
      typeof shot.totalSpinRpm !== 'number' ||
      typeof shot.spinAxisDegrees !== 'number'
    return sum + (hasMissingField ? recencyWeightForShot(shot) : 0)
  }, 0)
  const missingPenalty =
    weightedShotCount > 0
      ? (missingRequiredFields / weightedShotCount) *
        confidenceConfig.dataConfidence.missingRequiredFieldPenalty
      : confidenceConfig.dataConfidence.missingRequiredFieldPenalty

  return {
    score: clamp(Math.round(includedShotScore * 0.7 + sessionScore * 0.3 - missingPenalty)),
    note: `${shots.length} shots across ${sessionCount} sessions`,
  }
}

const caddieCallForScore = (
  score: number,
  includedShots: number,
): ReviewClubSummary['caddieCall'] => {
  if (includedShots < confidenceConfig.insufficientData.minIncludedShots) {
    return 'Insufficient Data'
  }

  return (
    confidenceConfig.caddieCalls.find((call) => score >= call.minScore)?.label ??
    'Liability'
  )
}

const explanationPrefix = (caddieCall: ReviewClubSummary['caddieCall']) => {
  switch (caddieCall) {
    case 'Attack':
      return 'Strong option with aggressive trust.'
    case 'Play':
      return 'Reliable option and a positive go-to.'
    case 'Manage':
      return 'Usable option, but stay aware of the pattern.'
    case 'Careful':
      return 'Risk is present and this needs caution.'
    case 'Liability':
      return 'High-risk option and better avoided.'
    case 'Insufficient Data':
      return 'Not enough usable evidence yet.'
  }
}

const componentDisplayName = (
  component: keyof ReviewClubSummary['componentScores'],
) => {
  switch (component) {
    case 'distanceWindow':
      return 'distance control'
    case 'directionWindow':
      return 'start line'
    case 'flightQuality':
      return 'flight profile'
    case 'patternStability':
      return 'pattern stability'
    case 'dataConfidence':
      return 'sample strength'
  }
}

const buildInsights = (
  caddieCall: ReviewClubSummary['caddieCall'],
  includedShots: number,
  componentScores: ReviewClubSummary['componentScores'],
) => {
  const rankedComponents = Object.entries(componentScores).sort((left, right) => right[1] - left[1]) as Array<
    [keyof ReviewClubSummary['componentScores'], number]
  >
  const strongestPositive = rankedComponents[0]
  const strongestNegative = rankedComponents[rankedComponents.length - 1]

  const firstInsight = (() => {
    switch (caddieCall) {
      case 'Attack':
        return `Lean on this one. ${componentDisplayName(strongestPositive[0])} is leading the way.`
      case 'Play':
        return `This is a go-to club. ${componentDisplayName(strongestPositive[0])} keeps it dependable.`
      case 'Manage':
        return `This club is playable, but pick your spot. ${componentDisplayName(strongestPositive[0])} gives you something to work with.`
      case 'Careful':
        return `Handle this with care. The miss pattern can still bring penalty strokes into play.`
      case 'Liability':
        return `This club is asking for trouble right now. Only pull it if this really has to be the play.`
      case 'Insufficient Data':
        return `Need a few more swings before the caddie has a real read.`
    }
  })()

  const secondInsight =
    caddieCall === 'Insufficient Data'
      ? `${includedShots} included shots is not enough to trust the read yet.`
      : `${includedShots} included shots so far. Biggest drag is ${componentDisplayName(
          strongestNegative[0],
        )}.`

  return [firstInsight, secondInsight]
}

export const summarizeReviewClub = (
  club: Club,
  shots: Shot[],
  savedSessions: SavedSession[],
  activeSessionId: string | null,
): ReviewClubSummary | null => {
  const includedClubShotsRaw = includedClubShots(club, shots)
  const activeSessionEndedAt =
    includedClubShotsRaw.length > 0
      ? includedClubShotsRaw
          .map((shot) => new Date(shot.capturedAt).getTime())
          .filter((value) => Number.isFinite(value))
          .sort((left, right) => right - left)[0]
      : Date.now()
  const recencySessions =
    activeSessionId === null
      ? savedSessions
      : [
          {
            id: activeSessionId,
            startedAt: new Date(activeSessionEndedAt).toISOString(),
            endedAt: new Date(activeSessionEndedAt).toISOString(),
            shots,
          },
          ...savedSessions.filter((session) => session.id !== activeSessionId),
        ]
  const nowMs = Date.now()
  const eligibleSessions = recencySessions.filter(
    (session) => !isSystemOldExcludedSession(session, nowMs),
  )

  const shotSessionById = new Map<string, string>()
  eligibleSessions.forEach((session) => {
    session.shots.forEach((shot) => {
      if (!shotSessionById.has(shot.id)) {
        shotSessionById.set(shot.id, session.id)
      }
    })
  })

  const sessionWeightById = new Map(
    eligibleSessions.map((session) => [
      session.id,
      sessionHistoricalWeightForClub(session, club, nowMs),
    ]),
  )
  const includedCountBySessionId = new Map(
    eligibleSessions.map((session) => [
      session.id,
      includedClubShotsForSession(session, club).length,
    ]),
  )
  const includedShots = includedClubShotsRaw.filter((shot) => {
    const sessionId = shotSessionById.get(shot.id)
    if (!sessionId) {
      return false
    }
    return (sessionWeightById.get(sessionId) ?? 0) > 0
  })
  if (includedShots.length === 0) {
    return null
  }

  const recencyWeightForShot = (shot: Shot) => {
    const sessionId = shotSessionById.get(shot.id)
    if (!sessionId) {
      return 0
    }
    const sessionWeight = sessionWeightById.get(sessionId) ?? 0
    const includedCount = includedCountBySessionId.get(sessionId) ?? 0
    if (sessionWeight <= 0 || includedCount <= 0) {
      return 0
    }
    return sessionWeight / includedCount
  }

  const shotRanks = includedShots.flatMap((shot) =>
    typeof shot.shotRanking !== 'undefined' ? [String(shot.shotRanking)] : [],
  )
  const rankCounts = new Map<string, number>()
  shotRanks.forEach((rank) => {
    rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1)
  })
  const shotRankSummary =
    shotRanks.length > 0
      ? [...rankCounts.entries()]
          .map(([rank, count]) => `${rank}: ${count}`)
          .join(', ')
      : '-'

  const supportingSessions =
    activeSessionId === null
      ? eligibleSessions
      : eligibleSessions.filter((session) => session.id !== activeSessionId)
  const sessionCount = (() => {
    const activeWeight = activeSessionId === null ? 0 : sessionWeightById.get(activeSessionId) ?? 0
    const supportWeight = supportingSessions.reduce((sum, session) => {
      const hasClubShots = session.shots.some(
        (shot) => shot.club === club && shot.included,
      )
      if (!hasClubShots) {
        return sum
      }
      return sum + (sessionWeightById.get(session.id) ?? 0)
    }, 0)
    return supportWeight + activeWeight
  })()

  const distanceWindow = buildDistanceScore(includedShots, recencyWeightForShot)
  const directionWindow = buildDirectionScore(club, includedShots, recencyWeightForShot)
  const flightQuality = buildFlightQualityScore(includedShots, recencyWeightForShot)
  const patternStability = buildPatternStabilityScore(
    includedShots,
    supportingSessions,
    club,
    recencyWeightForShot,
  )
  const dataConfidence = buildDataConfidenceScore(
    includedShots,
    sessionCount,
    recencyWeightForShot,
  )

  const weighted =
    distanceWindow.score * confidenceConfig.componentWeights.distanceWindow +
    directionWindow.score * confidenceConfig.componentWeights.directionWindow +
    flightQuality.score * confidenceConfig.componentWeights.flightQuality +
    patternStability.score * confidenceConfig.componentWeights.patternStability +
    dataConfidence.score * confidenceConfig.componentWeights.dataConfidence

  const caddieScore = Math.round(weighted)
  const caddieCall = caddieCallForScore(caddieScore, includedShots.length)
  const explanation = [
    explanationPrefix(caddieCall),
    `Distance ${distanceWindow.note}`,
    `Direction ${directionWindow.note}`,
    `Flight ${flightQuality.note}`,
    `Pattern ${patternStability.note}`,
    `Data ${dataConfidence.note}`,
  ].join('. ')

  return {
    club,
    includedShots: includedShots.length,
    carryAverageYards: oneDecimal(
      weightedAverageFromShots(
        includedShots,
        (shot) => shot.carryYards,
        recencyWeightForShot,
      ),
    ),
    carryStdDevYards: oneDecimal(
      weightedStdDevFromShots(
        includedShots,
        (shot) => shot.carryYards,
        recencyWeightForShot,
      ),
    ),
    offlineAverageYards: oneDecimal(
      weightedAverageFromShots(
        includedShots,
        (shot) => shot.offlineYards,
        recencyWeightForShot,
      ),
    ),
    offlineStdDevYards: oneDecimal(
      weightedStdDevFromShots(
        includedShots,
        (shot) => shot.offlineYards,
        recencyWeightForShot,
      ),
    ),
    shotRankSummary,
    caddieScore,
    caddieCall,
    componentScores: {
      distanceWindow: distanceWindow.score,
      directionWindow: directionWindow.score,
      flightQuality: flightQuality.score,
      patternStability: patternStability.score,
      dataConfidence: dataConfidence.score,
    },
    explanation,
    insights: buildInsights(caddieCall, includedShots.length, {
      distanceWindow: distanceWindow.score,
      directionWindow: directionWindow.score,
      flightQuality: flightQuality.score,
      patternStability: patternStability.score,
      dataConfidence: dataConfidence.score,
    }),
  }
}
