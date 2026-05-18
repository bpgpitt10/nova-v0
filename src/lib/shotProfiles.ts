import type { Club } from './bagConfig'
import { getClubFamily, getIronBucket } from './clubTaxonomy'
import { confidenceConfig } from './confidenceConfig'
import {
  guardedWeightedCarryMean,
  guardedWeightedCarryStdDev,
} from './carryOutlierGuard'
import { isShotIncludedInAnalysis } from './historicalModel'
import { resolveHandedOpenGolfCoachValue } from './openGolfCoach'
import { weightedAverage, weightedStandardDeviation } from './recency'
import { weightedTrimmedMean, weightedWinsorizedStdDev } from './robustStats'
import { normalizeShotRank, shotRankWeight } from './shotRank'
import type { OpenGolfCoachPayload, Shot } from '../types'

export type ShotProfileSnapshot = {
  key: 'best' | 'likely'
  carry?: number
  carryVariability?: number
  total?: number
  totalVariability?: number
  offlineMean?: number
  dispersion?: number
  dispersionVariability?: number
  launch?: number
  launchVariability?: number
  hla?: number
  hlaVariability?: number
  spin?: number
  spinVariability?: number
  spinAxis?: number
  smashFactor?: number
  smashFactorVariability?: number
  ballSpeed?: number
  clubSpeed?: number
  peakHeight?: number
  descentAngle?: number
  clubPath?: number
  faceToPath?: number
  faceToTarget?: number
} | null

export type ShotProfiles = {
  bestAvailable: ShotProfileSnapshot
  mostLikely: ShotProfileSnapshot
  executionGapRows: Array<{ label: string; value: string }>
  takeaway: string
}

type BuildShotProfilesForIdentityArgs = {
  shots: Shot[]
  club: Club
  shotWeightsById?: Map<string, number>
}

const weightedAverageNumbers = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
) => {
  const average = weightedAverage(values, weights)
  return typeof average === 'number' ? average : undefined
}

const weightedStandardDeviationNumbers = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
) => {
  const deviation = weightedStandardDeviation(values, weights)
  return typeof deviation === 'number' ? deviation : undefined
}

const payloadNumber = (payload: OpenGolfCoachPayload | undefined, keys: string[]) => {
  if (!payload) {
    return undefined
  }

  const parseNumberLike = (value: unknown) => {
    const resolved = resolveHandedOpenGolfCoachValue(value)
    if (typeof resolved === 'number' && Number.isFinite(resolved)) {
      return resolved
    }
    if (typeof resolved === 'string') {
      const parsed = Number(resolved)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
    return undefined
  }

  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null

  const root = asRecord(payload)
  if (!root) {
    return undefined
  }

  const scopedObjects: Record<string, unknown>[] = [root]
  const coach = asRecord(root.open_golf_coach)
  if (coach) {
    scopedObjects.push(coach)
    const usCustomaryUnits = asRecord(coach.us_customary_units)
    if (usCustomaryUnits) {
      scopedObjects.push(usCustomaryUnits)
    }
    const siUnits = asRecord(coach.si_units)
    if (siUnits) {
      scopedObjects.push(siUnits)
    }
  }

  for (const source of scopedObjects) {
    for (const key of keys) {
      const parsed = parseNumberLike(source[key])
      if (typeof parsed === 'number') {
        return parsed
      }
    }
  }

  const visited = new Set<Record<string, unknown>>()
  const stack: Record<string, unknown>[] = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || visited.has(current)) {
      continue
    }
    visited.add(current)

    for (const key of keys) {
      const parsed = parseNumberLike(current[key])
      if (typeof parsed === 'number') {
        return parsed
      }
    }

    Object.values(current).forEach((value) => {
      const nested = asRecord(value)
      if (nested && !visited.has(nested)) {
        stack.push(nested)
      }
    })
  }

  return undefined
}

const carryValue = (shot: Shot) =>
  typeof shot.carryYards === 'number'
    ? shot.carryYards
    : payloadNumber(shot.openGolfCoach, [
        'carry_distance_yards',
        'carryDistanceYards',
        'carry',
      ])

const totalValue = (shot: Shot) =>
  typeof shot.totalYards === 'number'
    ? shot.totalYards
    : payloadNumber(shot.openGolfCoach, [
        'total_distance_yards',
        'totalDistanceYards',
        'total',
      ])

const offlineValue = (shot: Shot) =>
  typeof shot.offlineYards === 'number'
    ? shot.offlineYards
    : payloadNumber(shot.openGolfCoach, [
        'offline_distance_yards',
        'offlineDistanceYards',
        'offline',
      ])

const launchValue = (shot: Shot) =>
  typeof shot.verticalLaunchAngleDegrees === 'number'
    ? shot.verticalLaunchAngleDegrees
    : typeof shot.launchAngleDeg === 'number'
      ? shot.launchAngleDeg
      : payloadNumber(shot.openGolfCoach, [
          'vertical_launch_angle_degrees',
          'verticalLaunchAngleDegrees',
          'launch_angle_degrees',
          'launchAngleDeg',
        ])

const hlaValue = (shot: Shot) =>
  typeof shot.horizontalLaunchAngleDegrees === 'number'
    ? shot.horizontalLaunchAngleDegrees
    : payloadNumber(shot.openGolfCoach, [
        'horizontal_launch_angle_degrees',
        'horizontalLaunchAngleDegrees',
        'horizontal_launch_angle',
      ])

const spinValue = (shot: Shot) =>
  typeof shot.totalSpinRpm === 'number'
    ? shot.totalSpinRpm
    : typeof shot.spinRpm === 'number'
      ? shot.spinRpm
      : payloadNumber(shot.openGolfCoach, [
          'backspin_rpm',
          'total_spin_rpm',
          'totalSpinRpm',
          'spin_rpm',
        ])

const spinAxisValue = (shot: Shot) =>
  typeof shot.spinAxisDegrees === 'number'
    ? shot.spinAxisDegrees
    : payloadNumber(shot.openGolfCoach, [
        'spin_axis_degrees',
        'spinAxisDegrees',
        'spin_axis',
      ])

const descentValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, [
    'descent_angle_degrees',
    'descent_angle_deg',
    'descent_angle',
    'descentAngleDegrees',
    'descentAngleDeg',
    'descentAngle',
  ])

const clubPathValue = (shot: Shot) =>
  shot.clubPathDegrees ??
  shot.club_path_degrees ??
  shot.clubPathDeg ??
  shot.club_path_deg ??
  shot.clubPath ??
  shot.club_path ??
  payloadNumber(shot.openGolfCoach, [
    'club_path_degrees',
    'clubPathDegrees',
    'club_path_deg',
    'clubPathDeg',
    'club_path',
    'clubPath',
  ])

const faceToPathValue = (shot: Shot) =>
  shot.faceToPathDegrees ??
  shot.face_to_path_degrees ??
  shot.clubFaceToPathDegrees ??
  shot.club_face_to_path_degrees ??
  shot.faceToPathDeg ??
  shot.face_to_path_deg ??
  shot.faceToPath ??
  shot.face_to_path ??
  shot.clubFaceToPath ??
  shot.club_face_to_path ??
  payloadNumber(shot.openGolfCoach, [
    'club_face_to_path_degrees',
    'clubFaceToPathDegrees',
    'face_to_path_degrees',
    'faceToPathDegrees',
    'club_face_to_path_deg',
    'clubFaceToPathDeg',
    'face_to_path_deg',
    'faceToPathDeg',
    'club_face_to_path',
    'clubFaceToPath',
    'face_to_path',
    'faceToPath',
  ])

const faceToTargetValue = (shot: Shot) =>
  shot.faceToTargetDegrees ??
  shot.face_to_target_degrees ??
  shot.clubFaceToTargetDegrees ??
  shot.club_face_to_target_degrees ??
  shot.faceToTargetDeg ??
  shot.face_to_target_deg ??
  shot.faceToTarget ??
  shot.face_to_target ??
  shot.clubFaceToTarget ??
  shot.club_face_to_target ??
  payloadNumber(shot.openGolfCoach, [
    'club_face_to_target_degrees',
    'clubFaceToTargetDegrees',
    'face_to_target_degrees',
    'faceToTargetDegrees',
    'club_face_to_target_deg',
    'clubFaceToTargetDeg',
    'face_to_target_deg',
    'faceToTargetDeg',
    'club_face_to_target',
    'clubFaceToTarget',
    'face_to_target',
    'faceToTarget',
  ])

const smashFactorValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, ['smash_factor', 'smashFactor', 'smash'])

const peakHeightValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, [
    'peak_height_yards',
    'peakHeightYards',
    'peak_height',
    'peakHeight',
  ])

const clubSpeedValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, [
    'club_speed_mph',
    'clubSpeedMph',
    'club_speed_miles_per_hour',
    'clubSpeedMilesPerHour',
  ])

const ballSpeedMphValue = (shot: Shot) =>
  typeof shot.ballSpeedMph === 'number'
    ? shot.ballSpeedMph
    : payloadNumber(shot.openGolfCoach, [
        'ball_speed_mph',
        'ballSpeedMph',
        'ball_speed_miles_per_hour',
        'ballSpeedMilesPerHour',
      ])

const buildProfile = (
  rows: Array<{ shot: Shot; effectiveWeight: number }>,
  key: 'best' | 'likely',
): ShotProfileSnapshot => {
  if (rows.length === 0) {
    return null
  }
  const shots = rows.map((row) => row.shot)
  const weights = rows.map((row) => row.effectiveWeight)
  const offline = shots.map(offlineValue)
  const absOffline = offline.map((value) =>
    typeof value === 'number' ? Math.abs(value) : undefined,
  )
  const carry = shots.map(carryValue)
  const total = shots.map(totalValue)
  const launch = shots.map(launchValue)
  const hla = shots.map(hlaValue)
  const spin = shots.map(spinValue)
  const smashFactor = shots.map(smashFactorValue)

  return {
    key,
    carry: guardedWeightedCarryMean(
      carry,
      weights,
      confidenceConfig.displayCarryOutlierThresholdPct,
      confidenceConfig.displayCarryOutlierThresholdFloorYards,
    ),
    carryVariability:
      key === 'likely'
        ? guardedWeightedCarryStdDev(
            carry,
            weights,
            confidenceConfig.displayCarryOutlierThresholdPct,
            confidenceConfig.displayCarryOutlierThresholdFloorYards,
          )
        : weightedStandardDeviationNumbers(carry, weights),
    total: weightedAverageNumbers(total, weights),
    totalVariability: weightedStandardDeviationNumbers(total, weights),
    offlineMean: weightedAverageNumbers(offline, weights),
    dispersion: weightedTrimmedMean(absOffline, weights, 0.1),
    dispersionVariability: weightedWinsorizedStdDev(offline, weights, 0.1),
    launch: weightedAverageNumbers(launch, weights),
    launchVariability: weightedStandardDeviationNumbers(launch, weights),
    hla: weightedAverageNumbers(hla, weights),
    hlaVariability: weightedStandardDeviationNumbers(hla, weights),
    spin: weightedAverageNumbers(spin, weights),
    spinVariability: weightedStandardDeviationNumbers(spin, weights),
    spinAxis: weightedAverageNumbers(shots.map(spinAxisValue), weights),
    smashFactor: weightedAverageNumbers(smashFactor, weights),
    smashFactorVariability: weightedStandardDeviationNumbers(smashFactor, weights),
    ballSpeed: weightedAverageNumbers(shots.map(ballSpeedMphValue), weights),
    clubSpeed: weightedAverageNumbers(shots.map(clubSpeedValue), weights),
    peakHeight: weightedAverageNumbers(shots.map(peakHeightValue), weights),
    descentAngle: weightedAverageNumbers(shots.map(descentValue), weights),
    clubPath: weightedAverageNumbers(shots.map(clubPathValue), weights),
    faceToPath: weightedAverageNumbers(shots.map(faceToPathValue), weights),
    faceToTarget: weightedAverageNumbers(shots.map(faceToTargetValue), weights),
  }
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const weightedAvailableScore = (rows: Array<{ score: number | undefined; weight: number }>) => {
  const available = rows.filter(
    (row): row is { score: number; weight: number } =>
      typeof row.score === 'number' && Number.isFinite(row.score) && row.weight > 0,
  )
  if (available.length === 0) {
    return undefined
  }
  const weightTotal = available.reduce((sum, row) => sum + row.weight, 0)
  if (weightTotal <= 0) {
    return undefined
  }
  return available.reduce((sum, row) => sum + row.score * row.weight, 0) / weightTotal
}

export const buildShotProfilesForIdentity = ({
  shots,
  club,
  shotWeightsById,
}: BuildShotProfilesForIdentityArgs): ShotProfiles => {
  const includedShots = shots.filter(isShotIncludedInAnalysis)
  if (includedShots.length === 0) {
    return {
      bestAvailable: null,
      mostLikely: null,
      executionGapRows: [],
      takeaway: 'Not enough shots to profile this club yet.',
    }
  }

  const shotWeight = (shot: Shot) => shotWeightsById?.get(shot.id) ?? 1
  const mostLikely = buildProfile(
    includedShots.map((shot) => ({
      shot,
      effectiveWeight: shotWeight(shot),
    })),
    'likely',
  )

  const stockCarry = mostLikely?.carry
  const stockOfflineAbs = mostLikely?.dispersion
  const stockHlaAbs =
    typeof mostLikely?.hla === 'number' ? Math.abs(mostLikely.hla) : undefined
  const carryImprovementCap = 12
  const carryDownsideCap = 10
  const offlineImprovementCap = 10
  const offlineDownsideCap = 12
  const hlaBonusCap = 2
  const feltPerfectBonusValue = 0.08
  const sparseSupportAllowed = includedShots.length < 4

  const flightFloorByClub = (() => {
    const family = getClubFamily(club)
    const ironBucket = getIronBucket(club)
    const isDriverBucket = club === 'Driver' || club === 'Mini Driver'

    if (isDriverBucket) {
      return { launch: 2.4, spin: 550 }
    }
    if (family === 'wood' || family === 'hybrid') {
      return { launch: 2.1, spin: 500 }
    }
    if (family === 'wedge' || ironBucket === 'short') {
      return { launch: 1.3, spin: 300 }
    }
    if (ironBucket === 'mid') {
      return { launch: 1.55, spin: 360 }
    }
    if (ironBucket === 'long') {
      return { launch: 1.8, spin: 425 }
    }
    return { launch: 1.8, spin: 425 }
  })()

  const launchCenter = weightedAverageNumbers(
    includedShots.map(launchValue),
    includedShots.map((shot) => shotWeight(shot)),
  )
  const launchSpread = weightedStandardDeviationNumbers(
    includedShots.map(launchValue),
    includedShots.map((shot) => shotWeight(shot)),
  )
  const spinCenter = weightedAverageNumbers(
    includedShots.map(spinValue),
    includedShots.map((shot) => shotWeight(shot)),
  )
  const spinSpread = weightedStandardDeviationNumbers(
    includedShots.map(spinValue),
    includedShots.map((shot) => shotWeight(shot)),
  )

  const coherenceScore = (
    value: number | undefined,
    center: number | undefined,
    spread: number | undefined,
    floor: number,
  ) => {
    if (typeof value !== 'number' || typeof center !== 'number') {
      return undefined
    }
    const effectiveSpread = Math.max(spread ?? 0, floor)
    const deviation = Math.abs(value - center)
    if (deviation <= effectiveSpread) {
      return 1
    }
    if (deviation >= effectiveSpread * 2.5) {
      return 0
    }
    return clamp01(1 - (deviation - effectiveSpread) / (effectiveSpread * 1.5))
  }

  const candidates = includedShots.flatMap((shot) => {
    const carry = carryValue(shot)
    const offline = offlineValue(shot)
    if (
      typeof carry !== 'number' ||
      typeof offline !== 'number' ||
      typeof stockCarry !== 'number' ||
      typeof stockOfflineAbs !== 'number'
    ) {
      return []
    }

    const carryDelta = carry - stockCarry
    const carryOutcome =
      carryDelta >= 0
        ? clamp01(carryDelta / carryImprovementCap)
        : -clamp01(Math.abs(carryDelta) / carryDownsideCap) * 0.45
    const offlineDelta = stockOfflineAbs - Math.abs(offline)
    const offlineOutcome =
      offlineDelta >= 0
        ? clamp01(offlineDelta / offlineImprovementCap)
        : -clamp01(Math.abs(offlineDelta) / offlineDownsideCap) * 0.45
    const shotHla = hlaValue(shot)
    const hlaBonus =
      typeof shotHla === 'number' && typeof stockHlaAbs === 'number'
        ? clamp01((stockHlaAbs - Math.abs(shotHla)) / hlaBonusCap)
        : undefined
    const outcomeScore =
      weightedAvailableScore([
        { score: carryOutcome, weight: 0.55 },
        { score: offlineOutcome, weight: 0.35 },
        { score: hlaBonus, weight: 0.1 },
      ]) ?? 0

    const flightScore = weightedAvailableScore([
      {
        score: coherenceScore(
          launchValue(shot),
          launchCenter,
          launchSpread,
          flightFloorByClub.launch,
        ),
        weight: 0.5,
      },
      {
        score: coherenceScore(
          spinValue(shot),
          spinCenter,
          spinSpread,
          flightFloorByClub.spin,
        ),
        weight: 0.5,
      },
    ])

    const normalizedRank = normalizeShotRank(shot.shotRanking)
    const baseStrikeScore =
      typeof normalizedRank === 'undefined'
        ? 0.5
        : clamp01(0.5 + (shotRankWeight(shot.shotRanking) - 1) * 1.2)
    const measuredOutcomeStrong =
      carryOutcome >= 0.45 && Math.abs(offline) <= Math.max(stockOfflineAbs, 6)
    const strikeScore =
      normalizedRank === 'B' && measuredOutcomeStrong
        ? Math.max(baseStrikeScore, 0.58)
        : baseStrikeScore

    const neighborCount = includedShots.reduce((count, candidate) => {
      if (candidate.id === shot.id) {
        return count
      }
      const candidateCarry = carryValue(candidate)
      const candidateOffline = offlineValue(candidate)
      if (typeof candidateCarry !== 'number' || typeof candidateOffline !== 'number') {
        return count
      }
      return Math.abs(candidateCarry - carry) <= 12 && Math.abs(candidateOffline - offline) <= 15
        ? count + 1
        : count
    }, 0)
    const supportScore =
      neighborCount <= 0 ? 0 : neighborCount === 1 ? 0.4 : neighborCount === 2 ? 0.7 : 1

    if (!sparseSupportAllowed && supportScore <= 0) {
      return []
    }

    const pureScore =
      weightedAvailableScore([
        { score: outcomeScore, weight: 0.4 },
        { score: flightScore, weight: 0.2 },
        { score: strikeScore, weight: 0.1 },
        { score: supportScore, weight: 0.3 },
      ]) ?? 0
    const feltPerfectBonus = shot.feltPerfect ? feltPerfectBonusValue : 0

    return [
      {
        shot,
        pureScore: pureScore + feltPerfectBonus,
        effectiveWeight: shotWeight(shot) * (0.7 + (pureScore + feltPerfectBonus) * 0.6),
      },
    ]
  })

  const bestSubset = (() => {
    if (candidates.length === 0) {
      return []
    }
    const ranked = [...candidates].sort((left, right) => right.pureScore - left.pureScore)
    const subsetSize = Math.min(Math.max(Math.round(ranked.length * 0.4), 3), 8)
    return ranked.slice(0, subsetSize)
  })()

  const bestAvailable = buildProfile(bestSubset, 'best')

  const numberGap = (best: number | undefined, likely: number | undefined) =>
    typeof best === 'number' && typeof likely === 'number' ? best - likely : undefined

  const carryGap = numberGap(bestAvailable?.carry, mostLikely?.carry)
  const dispersionGap = numberGap(bestAvailable?.dispersion, mostLikely?.dispersion)
  const variabilityGap = numberGap(
    bestAvailable?.dispersionVariability,
    mostLikely?.dispersionVariability,
  )
  const spinGap = numberGap(bestAvailable?.spin, mostLikely?.spin)

  const executionGapRows = [
    typeof carryGap === 'number'
      ? {
          label: 'Carry',
          value: `${carryGap >= 0 ? '+' : '-'}${Math.abs(carryGap).toFixed(1)} yd`,
        }
      : null,
    typeof dispersionGap === 'number'
      ? {
          label: 'Dispersion',
          value: `${dispersionGap >= 0 ? '+' : '-'}${Math.abs(dispersionGap).toFixed(1)} yd`,
        }
      : null,
    typeof variabilityGap === 'number'
      ? {
          label: 'Variability',
          value: `${variabilityGap >= 0 ? '+' : '-'}${Math.abs(variabilityGap).toFixed(1)} yd`,
        }
      : null,
    typeof spinGap === 'number'
      ? {
          label: 'Spin',
          value:
            Math.abs(spinGap) < 120
              ? 'Nearly unchanged'
              : `${spinGap >= 0 ? '+' : '-'}${Math.abs(Math.round(spinGap))} rpm`,
        }
      : null,
  ].filter((row): row is { label: string; value: string } => row !== null)

  const takeaway = (() => {
    if (executionGapRows.length === 0) {
      return 'Execution gap will sharpen as more clean swings come in.'
    }

    if (
      typeof dispersionGap === 'number' &&
      typeof variabilityGap === 'number' &&
      typeof carryGap === 'number' &&
      dispersionGap <= -2 &&
      variabilityGap <= -2 &&
      Math.abs(carryGap) <= 1.5
    ) {
      return 'Execution mainly tightens the miss, not the distance.'
    }

    if (
      typeof carryGap === 'number' &&
      carryGap >= 2 &&
      (typeof dispersionGap !== 'number' || dispersionGap > -1.5)
    ) {
      return 'Best swings add distance more than they tighten the miss.'
    }

    if (typeof dispersionGap === 'number' && dispersionGap <= -2) {
      return 'The gain comes mostly from reducing spread.'
    }

    if (
      typeof carryGap === 'number' &&
      typeof dispersionGap === 'number' &&
      Math.abs(carryGap) < 1 &&
      Math.abs(dispersionGap) < 1
    ) {
      return 'Most likely and best-executed outcomes are close right now.'
    }

    return 'Execution changes this club, but not in one single dimension.'
  })()

  return {
    bestAvailable,
    mostLikely,
    executionGapRows,
    takeaway,
  }
}
