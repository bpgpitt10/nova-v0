import { confidenceConfig } from './confidenceConfig'
import type { Club, ReviewClubSummary, SavedSession, Shot } from '../types'

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value))

const average = (values: number[]) =>
  values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null

const standardDeviation = (values: number[]) => {
  if (values.length === 0) {
    return null
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length

  return Math.sqrt(variance)
}

const roundNumber = (value: number | null) =>
  value === null ? null : Math.round(value)

const includedClubShots = (club: Club, shots: Shot[]) =>
  shots.filter((shot) => shot.club === club && shot.included)

const getRankWeight = (shot: Shot) => {
  const key = typeof shot.shotRanking === 'undefined' ? '' : String(shot.shotRanking)
  return confidenceConfig.distanceWindow.rankWeights[key] ?? 1
}

const weightedAverageCarry = (shots: Shot[]) => {
  const carryShots = shots.filter(
    (shot): shot is Shot & { carryYards: number } =>
      typeof shot.carryYards === 'number',
  )
  if (carryShots.length === 0) {
    return null
  }

  const weighted = carryShots.reduce(
    (accumulator, shot) => {
      const weight = getRankWeight(shot)
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

const buildDirectionScore = (club: Club, shots: Shot[]) => {
  const offlineValues = shots.flatMap((shot) =>
    typeof shot.offlineYards === 'number' ? [shot.offlineYards] : [],
  )
  if (offlineValues.length === 0) {
    return { score: 0, note: 'No offline data' }
  }

  const targetWidth = confidenceConfig.directionWindow.targetWidthByClub[club]
  const maxOffline = targetWidth * confidenceConfig.directionWindow.maxOfflineMultiplier
  const averageAbsoluteOffline =
    average(offlineValues.map((value) => Math.abs(value))) ?? 0
  const baseScore = clamp(100 - (averageAbsoluteOffline / targetWidth) * 100)
  const zeroFloorScore =
    offlineValues.some((value) => Math.abs(value) >= maxOffline) ? 0 : baseScore

  const missesLeft = offlineValues.some(
    (value) => value < -confidenceConfig.directionWindow.sideSwitchThresholdYards,
  )
  const missesRight = offlineValues.some(
    (value) => value > confidenceConfig.directionWindow.sideSwitchThresholdYards,
  )
  const twoWayPenalty =
    missesLeft && missesRight ? confidenceConfig.directionWindow.twoWayMissPenalty : 0

  return {
    score: clamp(zeroFloorScore - twoWayPenalty),
    note:
      twoWayPenalty > 0
        ? `Avg abs offline ${Math.round(averageAbsoluteOffline)} yd with two-way miss`
        : `Avg abs offline ${Math.round(averageAbsoluteOffline)} yd`,
  }
}

const buildDistanceScore = (shots: Shot[]) => {
  const carryValues = shots.flatMap((shot) =>
    typeof shot.carryYards === 'number' ? [shot.carryYards] : [],
  )
  if (carryValues.length === 0) {
    return { score: 0, note: 'No carry data' }
  }

  const carryAnchor = weightedAverageCarry(shots)
  const carryStdDev = standardDeviation(carryValues) ?? 0
  const averageDeviation =
    carryAnchor === null
      ? null
      : average(carryValues.map((value) => Math.abs(value - carryAnchor)))
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
        : `Anchor ${Math.round(carryAnchor)} yd, std dev ${Math.round(carryStdDev)} yd`,
  }
}

const buildFlightQualityScore = (shots: Shot[]) => {
  let scoreTotal = 0
  let scoreCount = 0
  let missingFieldCount = 0

  shots.forEach((shot) => {
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
        missingFieldCount += 1
      } else {
        scoreTotal += value
        scoreCount += 1
      }
    })

    if (typeof shot.shotRanking !== 'undefined') {
      scoreTotal += clamp(getRankWeight(shot) * 90)
      scoreCount += 1
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
) => {
  const carryValues = shots.flatMap((shot) =>
    typeof shot.carryYards === 'number' ? [shot.carryYards] : [],
  )
  const offlineValues = shots.flatMap((shot) =>
    typeof shot.offlineYards === 'number' ? [shot.offlineYards] : [],
  )

  const carryStdDev = standardDeviation(carryValues)
  const offlineStdDev = standardDeviation(offlineValues)
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
    (average(firstHalf.flatMap((shot) =>
      typeof shot.carryYards === 'number' ? [shot.carryYards] : [],
    )) ?? 0) -
      (average(secondHalf.flatMap((shot) =>
        typeof shot.carryYards === 'number' ? [shot.carryYards] : [],
      )) ?? 0),
  )
  const directionDrift = Math.abs(
    (average(firstHalf.flatMap((shot) =>
      typeof shot.offlineYards === 'number' ? [shot.offlineYards] : [],
    )) ?? 0) -
      (average(secondHalf.flatMap((shot) =>
        typeof shot.offlineYards === 'number' ? [shot.offlineYards] : [],
      )) ?? 0),
  )
  const driftScore = scoreFromTarget(
    Math.max(carryDrift, directionDrift),
    confidenceConfig.patternStability.driftTargetYards,
  )

  const signs = offlineValues
    .filter((value) => Math.abs(value) >= confidenceConfig.directionWindow.sideSwitchThresholdYards)
    .map((value) => Math.sign(value))
  const sideSwitches = signs.reduce(
    (count, sign, index) => count + (index > 0 && sign !== signs[index - 1] ? 1 : 0),
    0,
  )
  const sideSwitchPenalty = shots.length > 1 ? (sideSwitches / (shots.length - 1)) * 25 : 0

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
    note: `Drift ${Math.round(Math.max(carryDrift, directionDrift))} yd, support ${supportSessions.length} sessions`,
  }
}

const buildDataConfidenceScore = (shots: Shot[], sessionCount: number) => {
  const includedShotScore = clamp(
    (shots.length / confidenceConfig.dataConfidence.targetIncludedShots) * 100,
  )
  const sessionScore = clamp(
    (sessionCount / confidenceConfig.dataConfidence.targetSessions) * 100,
  )
  const missingRequiredFields = shots.filter(
    (shot) =>
      typeof shot.ballSpeedMetersPerSecond !== 'number' ||
      typeof shot.verticalLaunchAngleDegrees !== 'number' ||
      typeof shot.horizontalLaunchAngleDegrees !== 'number' ||
      typeof shot.totalSpinRpm !== 'number' ||
      typeof shot.spinAxisDegrees !== 'number',
  ).length
  const missingPenalty =
    shots.length > 0
      ? (missingRequiredFields / shots.length) *
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
  const includedShots = includedClubShots(club, shots)
  if (includedShots.length === 0) {
    return null
  }

  const carryValues = includedShots.flatMap((shot) =>
    typeof shot.carryYards === 'number' ? [shot.carryYards] : [],
  )
  const offlineValues = includedShots.flatMap((shot) =>
    typeof shot.offlineYards === 'number' ? [shot.offlineYards] : [],
  )
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

  const supportingSessions = savedSessions.filter((session) => session.id !== activeSessionId)
  const sessionCount =
    supportingSessions.filter((session) =>
      session.shots.some((shot) => shot.club === club && shot.included),
    ).length + 1

  const distanceWindow = buildDistanceScore(includedShots)
  const directionWindow = buildDirectionScore(club, includedShots)
  const flightQuality = buildFlightQualityScore(includedShots)
  const patternStability = buildPatternStabilityScore(
    includedShots,
    supportingSessions,
    club,
  )
  const dataConfidence = buildDataConfidenceScore(includedShots, sessionCount)

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
    carryAverageYards: roundNumber(average(carryValues)),
    carryStdDevYards: roundNumber(standardDeviation(carryValues)),
    offlineAverageYards: roundNumber(average(offlineValues)),
    offlineStdDevYards: roundNumber(standardDeviation(offlineValues)),
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
