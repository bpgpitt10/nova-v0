import { confidenceConfig } from './confidenceConfig'
import { guardedWeightedCarryMean, weightedMedianValue } from './carryOutlierGuard'
import {
  weightedAverage,
  weightedStandardDeviation,
} from './recency'
import { normalizeShotRank, shotRankWeight } from './shotRank'
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

const payloadNumber = (
  payload: Shot['openGolfCoach'],
  keys: string[],
) => {
  if (!payload) {
    return undefined
  }
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
  }
  return undefined
}

const descentAngleValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, [
    'descent_angle_degrees',
    'descent_angle_deg',
    'descent_angle',
    'descentAngleDegrees',
    'descentAngleDeg',
    'descentAngle',
  ])

const includedClubShots = (club: Club, shots: Shot[]) =>
  shots.filter((shot) => shot.club === club && shot.included)

const getRankWeight = (shot: Shot) => shotRankWeight(shot.shotRanking)

const buildDirectionScore = (
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

  const carryValues = offlineShots.map((shot) => shot.carryYards)
  const typicalCarry = weightedMedianValue(carryValues, offlineWeights)
  if (typeof typicalCarry !== 'number') {
    return { score: 0, note: 'No carry reference' }
  }

  const targetWidth = confidenceConfig.directionWindow.targetWidthPct * typicalCarry
  if (!(targetWidth > 0)) {
    return { score: 0, note: 'Invalid target width' }
  }

  const planningMissThreshold =
    confidenceConfig.directionWindow.planningMissThresholdPctOfTargetWidth * targetWidth
  const inWindowThreshold = 0.5 * targetWidth
  const zeroScoreThreshold = 1.5 * targetWidth
  const shotDirectionScores = offlineValues.map((offline) => {
    const offlineAbs = Math.abs(offline)
    if (offlineAbs <= inWindowThreshold) {
      return 100
    }
    if (offlineAbs >= zeroScoreThreshold) {
      return 0
    }
    return (
      100 *
      (1 -
        (offlineAbs - inWindowThreshold) /
          (zeroScoreThreshold - inWindowThreshold))
    )
  })
  const baseScore = weightedAverage(shotDirectionScores, offlineWeights) ?? 0
  const averageAbsoluteOffline =
    weightedAverage(
      offlineValues.map((value) => Math.abs(value)),
      offlineWeights,
    ) ?? 0

  const meaningfulLeftWeight = offlineShots.reduce(
    (sum, shot) =>
      sum +
      (shot.offlineYards <= -planningMissThreshold
        ? recencyWeightForShot(shot)
        : 0),
    0,
  )
  const meaningfulRightWeight = offlineShots.reduce(
    (sum, shot) =>
      sum +
      (shot.offlineYards >= planningMissThreshold
        ? recencyWeightForShot(shot)
        : 0),
    0,
  )
  const totalMeaningfulMissWeight = meaningfulLeftWeight + meaningfulRightWeight

  const twoWayPenalty =
    totalMeaningfulMissWeight > 0
      ? (() => {
          const leftShare = meaningfulLeftWeight / totalMeaningfulMissWeight
          const rightShare = meaningfulRightWeight / totalMeaningfulMissWeight
          const minorShare = Math.min(leftShare, rightShare)
          return clamp(
            confidenceConfig.directionWindow.twoWayPenaltyMultiplier * minorShare,
            0,
            confidenceConfig.directionWindow.twoWayPenaltyCap,
          )
        })()
      : 0

  return {
    score: clamp(baseScore - twoWayPenalty),
    note:
      twoWayPenalty > 0
        ? `Avg abs offline ${oneDecimal(averageAbsoluteOffline)} yd, two-way balance penalty ${oneDecimal(twoWayPenalty)}`
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

  const carryWeights = carryShots.map(
    (shot) => recencyWeightForShot(shot) * getRankWeight(shot),
  )
  const typicalCarry =
    weightedMedianValue(carryValues, carryWeights) ?? null
  if (typicalCarry === null) {
    return { score: 0, note: 'No carry anchor' }
  }

  const inWindowThreshold = Math.max(
    confidenceConfig.distanceWindow.inWindowThresholdFloorYards,
    confidenceConfig.distanceWindow.inWindowThresholdPct * typicalCarry,
  )
  const zeroScoreThreshold = Math.max(
    confidenceConfig.distanceWindow.zeroScoreThresholdFloorYards,
    confidenceConfig.distanceWindow.zeroScoreThresholdPct * typicalCarry,
  )

  const shotDistanceScores = carryValues.map((carry) => {
    const carryGap = Math.abs(carry - typicalCarry)
    if (carryGap <= inWindowThreshold) {
      return 100
    }
    if (carryGap >= zeroScoreThreshold) {
      return 0
    }
    return (
      100 *
      (1 -
        (carryGap - inWindowThreshold) /
          (zeroScoreThreshold - inWindowThreshold))
    )
  })
  const distanceWindow = weightedAverage(shotDistanceScores, carryWeights) ?? 0

  return {
    score: clamp(Math.round(distanceWindow)),
    note: `Anchor ${oneDecimal(typicalCarry)} yd`,
  }
}

const buildFlightQualityScore = (
  shots: Shot[],
  recencyWeightForShot: (shot: Shot) => number,
) => {
  type FlightField = {
    key: 'launch' | 'spin' | 'descent' | 'spinAxis'
    label: string
    baseWeight: number
    valueAccessor: (shot: Shot) => number | undefined
  }

  const fields: FlightField[] = [
    {
      key: 'descent',
      label: 'descent',
      baseWeight: 0.35,
      valueAccessor: (shot) => descentAngleValue(shot),
    },
    {
      key: 'spin',
      label: 'spin',
      baseWeight: 0.3,
      valueAccessor: (shot) => shot.totalSpinRpm,
    },
    {
      key: 'spinAxis',
      label: 'spin axis',
      baseWeight: 0.2,
      valueAccessor: (shot) => shot.spinAxisDegrees,
    },
    {
      key: 'launch',
      label: 'launch',
      baseWeight: 0.15,
      valueAccessor: (shot) => shot.verticalLaunchAngleDegrees,
    },
  ]

  const qualifiedFlightShotCount = shots.filter((shot) =>
    fields.some((field) => typeof field.valueAccessor(shot) === 'number'),
  ).length

  const fieldScores = fields.flatMap((field) => {
    const fieldShots = shots.filter(
      (shot): shot is Shot =>
        typeof field.valueAccessor(shot) === 'number',
    )
    if (fieldShots.length === 0) {
      return []
    }

    const values = fieldShots.map((shot) => field.valueAccessor(shot) as number)
    const weights = fieldShots.map((shot) => recencyWeightForShot(shot))
    const center = weightedMedianValue(values, weights)
    if (typeof center !== 'number') {
      return []
    }

    const deviation =
      weightedAverage(
        values.map((value) => Math.abs(value - center)),
        weights,
      ) ?? null
    if (deviation === null) {
      return []
    }

    const denominator = (() => {
      switch (field.key) {
        case 'launch':
          return Math.max(Math.abs(center), 1)
        case 'spin':
          return Math.max(Math.abs(center), 500)
        case 'descent':
          return Math.max(Math.abs(center), 1)
        case 'spinAxis': {
          const absMedian = weightedMedianValue(
            values.map((value) => Math.abs(value)),
            weights,
          )
          return Math.max(absMedian ?? 0, 3)
        }
      }
    })()

    const relativeDeviation = deviation / denominator
    const score = clamp(100 - 100 * relativeDeviation)
    return [{ ...field, score }]
  })

  const coreFieldsPresent = fieldScores.length
  if (qualifiedFlightShotCount < 8 || coreFieldsPresent < 2) {
    return { score: null, note: 'Insufficient flight-profile data' }
  }

  const activeWeightTotal = fieldScores.reduce(
    (sum, field) => sum + field.baseWeight,
    0,
  )
  const flightQualityBase =
    activeWeightTotal > 0
      ? fieldScores.reduce(
          (sum, field) => sum + field.score * (field.baseWeight / activeWeightTotal),
          0,
        )
      : 0

  const availabilityAdjustment =
    coreFieldsPresent === 4 ? 0 : coreFieldsPresent === 3 ? -4 : -10
  const flightQuality = clamp(Math.round(flightQualityBase + availabilityAdjustment))
  const provisionalPrefix =
    qualifiedFlightShotCount >= 8 && qualifiedFlightShotCount <= 14
      ? 'Provisional '
      : ''
  const fieldSummary = fieldScores.map((field) => field.label).join(', ')

  return {
    score: flightQuality,
    note: `${provisionalPrefix}${qualifiedFlightShotCount} qualified shots across ${coreFieldsPresent} fields (${fieldSummary})`,
  }
}

const buildPatternStabilityScore = (
  includedShots: Shot[],
  supportingSessions: SavedSession[],
  club: Club,
  recencyWeightForShot: (shot: Shot) => number,
) => {
  const carryValues = includedShots.map((shot) => shot.carryYards)
  const carryWeights = includedShots.map((shot) => recencyWeightForShot(shot))
  const typicalCarry = weightedMedianValue(carryValues, carryWeights)
  if (typeof typicalCarry !== 'number') {
    return { score: null, note: 'No carry reference' }
  }

  const targetWidth = confidenceConfig.directionWindow.targetWidthPct * typicalCarry
  if (!(targetWidth > 0)) {
    return { score: null, note: 'Invalid target width' }
  }

  const carryDriftTolerance = Math.max(
    confidenceConfig.patternStability.carryDriftToleranceFloorYards,
    confidenceConfig.patternStability.carryDriftTolerancePct * typicalCarry,
  )
  const offlineDriftTolerance = 0.5 * targetWidth

  const clubSessionsByRecency = [...supportingSessions]
    .sort(
      (left, right) =>
        new Date(right.endedAt).getTime() - new Date(left.endedAt).getTime(),
    )
    .map((session) =>
      session.shots.filter(
        (shot) =>
          shot.club === club && shot.included && recencyWeightForShot(shot) > 0,
      ),
    )
    .filter((shots) => shots.length > 0)

  const distinctSessionCount = clubSessionsByRecency.length
  if (distinctSessionCount < 2) {
    return { score: null, note: 'Insufficient supporting sessions' }
  }

  const recentGroup = clubSessionsByRecency[0]
  const priorGroup = clubSessionsByRecency.slice(1).flat()
  const recentGroupShotCount = recentGroup.length
  const priorGroupShotCount = priorGroup.length
  if (recentGroupShotCount < 5 || priorGroupShotCount < 5) {
    return { score: null, note: 'Insufficient shots for drift comparison' }
  }

  const recentCarryCenter = weightedAverageFromShots(
    recentGroup,
    (shot) => shot.carryYards,
    recencyWeightForShot,
  )
  const recentOfflineCenter = weightedAverageFromShots(
    recentGroup,
    (shot) => shot.offlineYards,
    recencyWeightForShot,
  )
  const priorCarryCenter = weightedAverageFromShots(
    priorGroup,
    (shot) => shot.carryYards,
    recencyWeightForShot,
  )
  const priorOfflineCenter = weightedAverageFromShots(
    priorGroup,
    (shot) => shot.offlineYards,
    recencyWeightForShot,
  )

  if (
    typeof recentCarryCenter !== 'number' ||
    typeof recentOfflineCenter !== 'number' ||
    typeof priorCarryCenter !== 'number' ||
    typeof priorOfflineCenter !== 'number'
  ) {
    return { score: null, note: 'Insufficient drift centers' }
  }

  const carryDrift = Math.abs(recentCarryCenter - priorCarryCenter)
  const offlineDrift = Math.abs(recentOfflineCenter - priorOfflineCenter)
  const carryDriftScore = clamp(100 - (100 * carryDrift) / carryDriftTolerance)
  const offlineDriftScore = clamp(100 - (100 * offlineDrift) / offlineDriftTolerance)
  const patternStability = clamp(Math.round(0.5 * carryDriftScore + 0.5 * offlineDriftScore))

  return {
    score: patternStability,
    note: `Carry drift ${oneDecimal(carryDrift)} yd, offline drift ${oneDecimal(offlineDrift)} yd`,
  }
}

const buildDataConfidenceScore = (
  shots: Shot[],
  distinctSessionCount: number,
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
    (distinctSessionCount / confidenceConfig.dataConfidence.targetSessions) * 100,
  )

  return {
    score: clamp(Math.round(includedShotScore * 0.7 + sessionScore * 0.3)),
    note: `${oneDecimal(weightedShotCount)} weighted shots across ${distinctSessionCount} sessions`,
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
      return 'carry expectation'
    case 'directionWindow':
      return 'direction control'
    case 'flightQuality':
      return 'shot behavior'
    case 'patternStability':
      return 'pattern trend'
    case 'dataConfidence':
      return 'data confidence'
  }
}

const buildInsights = (
  caddieCall: ReviewClubSummary['caddieCall'],
  includedShots: number,
  componentScores: ReviewClubSummary['componentScores'],
) => {
  const rankedComponents = Object.entries(componentScores)
    .map(
      ([key, value]) =>
        [key, typeof value === 'number' ? value : 0] as [
          keyof ReviewClubSummary['componentScores'],
          number,
        ],
    )
    .sort((left, right) => right[1] - left[1])
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
    typeof shot.shotRanking !== 'undefined'
      ? [normalizeShotRank(shot.shotRanking) ?? String(shot.shotRanking)]
      : [],
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
  const distinctSessionCount = new Set(
    includedShots
      .map((shot) => shotSessionById.get(shot.id))
      .filter((sessionId): sessionId is string => typeof sessionId === 'string'),
  ).size

  const distanceWindow = buildDistanceScore(includedShots, recencyWeightForShot)
  const directionWindow = buildDirectionScore(includedShots, recencyWeightForShot)
  const flightQuality = buildFlightQualityScore(includedShots, recencyWeightForShot)
  const patternStability = buildPatternStabilityScore(
    includedShots,
    supportingSessions,
    club,
    recencyWeightForShot,
  )
  const dataConfidence = buildDataConfidenceScore(
    includedShots,
    distinctSessionCount,
    recencyWeightForShot,
  )

  const componentWeights = confidenceConfig.componentWeights
  const weightedComponents = [
    { score: distanceWindow.score, weight: componentWeights.distanceWindow },
    { score: directionWindow.score, weight: componentWeights.directionWindow },
    { score: flightQuality.score, weight: componentWeights.flightQuality },
    { score: patternStability.score, weight: componentWeights.patternStability },
    { score: dataConfidence.score, weight: componentWeights.dataConfidence },
  ]
  const activeWeightTotal = weightedComponents.reduce(
    (sum, component) =>
      typeof component.score === 'number' ? sum + component.weight : sum,
    0,
  )
  const weightedScoreTotal = weightedComponents.reduce(
    (sum, component) =>
      typeof component.score === 'number'
        ? sum + component.score * component.weight
        : sum,
    0,
  )
  const caddieScore = Math.round(
    activeWeightTotal > 0 ? weightedScoreTotal / activeWeightTotal : 0,
  )
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
      guardedWeightedCarryMean(
        includedShots.map((shot) => shot.carryYards),
        includedShots.map((shot) => recencyWeightForShot(shot)),
        confidenceConfig.displayCarryOutlierThresholdPct,
        confidenceConfig.displayCarryOutlierThresholdFloorYards,
      ) ?? null,
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
      flightQuality: flightQuality.score ?? 0,
      patternStability: patternStability.score ?? 0,
      dataConfidence: dataConfidence.score,
    }),
  }
}
