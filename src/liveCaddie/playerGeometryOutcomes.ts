import type { Club } from '../lib/bagConfig'
import {
  isShotSourceIncluded,
  isSystemOldExcludedSession,
  sessionAgeInDays,
  sizeWeightForShotCount,
  timeWeightForAgeDays,
} from '../lib/historicalModel'
import {
  installMishitPlanningState,
  mishitPlanningPopulationKey,
} from '../lib/mishitPlanningPopulation'
import {
  resolveShotVariantId,
  STOCK_SHOT_VARIANT_ID,
} from '../lib/shotVariants'
import type { SavedSession, Shot } from '../types'
import {
  classifyPoint,
  fairwayCorridorAtForwardY,
} from '../courseGeometry/geometry'
import { TACTICAL_SURFACE_SEMANTICS } from '../courseGeometry/semantics'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import { buildLiveCaddieProfileSet } from './profileProvider'
import type { LiveCaddieClubProfile } from './types'

export type SurfaceOutcomeDistribution = {
  sampleWeight: number
  bySurface: Partial<Record<CourseSurfaceClassification, number>>
  preferred: number
  rough: number
  trouble: number
  penalty: number
  unknown: number
}

export type MishitEvidenceSummary = {
  baselineStatus: 'insufficient' | 'provisional' | 'stable' | 'unavailable'
  evidence: 'low' | 'medium' | 'high'
  totalShots: number
  classifiedShots: number
  unclassifiedShots: number
  normalShots: number
  mishitShots: number
  severeMishitShots: number
  observedMishitRate: number | null
  averageClassificationConfidence: number | null
}

export type ClubGeometryOutcome = {
  club: string
  stockCarryYds: number
  carrySigmaYds: number | null
  lateralBiasYds: number
  lateralSigmaYds: number | null
  aimRightYdsAtStockCarry: number
  meanLanding: CoursePointYds
  planningModel: SurfaceOutcomeDistribution | null
  empiricalAllShots: SurfaceOutcomeDistribution | null
  empiricalShotCount: number
  profileSupportShots: number
  profileSupportingSessions: number
  mishitEvidence: MishitEvidenceSummary
  riskEnvelope: {
    preferredFloor: number | null
    troubleCeiling: number | null
    penaltyCeiling: number | null
    basis: 'planning-only' | 'planning-plus-empirical'
  }
  notes: string[]
}

const NORMAL_Z_POINTS = [
  -3,
  -2.5,
  -2,
  -1.5,
  -1,
  -0.5,
  0,
  0.5,
  1,
  1.5,
  2,
  2.5,
  3,
] as const

const gaussianWeight = (z: number) => Math.exp(-0.5 * z * z)

const emptyDistribution = (): SurfaceOutcomeDistribution => ({
  sampleWeight: 0,
  bySurface: {},
  preferred: 0,
  rough: 0,
  trouble: 0,
  penalty: 0,
  unknown: 0,
})

const addOutcome = (
  distribution: SurfaceOutcomeDistribution,
  kind: CourseSurfaceClassification,
  weight: number,
) => {
  distribution.sampleWeight += weight
  distribution.bySurface[kind] = (distribution.bySurface[kind] ?? 0) + weight
}

const normalizeDistribution = (distribution: SurfaceOutcomeDistribution) => {
  const total = distribution.sampleWeight
  if (total <= 0) return null

  const normalized = emptyDistribution()
  normalized.sampleWeight = total

  Object.entries(distribution.bySurface).forEach(([kind, weight]) => {
    normalized.bySurface[kind as CourseSurfaceClassification] = weight / total
  })

  Object.entries(normalized.bySurface).forEach(([kind, fraction]) => {
    const semantics = TACTICAL_SURFACE_SEMANTICS[kind as CourseSurfaceClassification]
    if (semantics.preferred) normalized.preferred += fraction
    if (kind === 'rough') normalized.rough += fraction
    if (semantics.countsAsTrouble) normalized.trouble += fraction
    if (semantics.countsAsPenalty) normalized.penalty += fraction
    if (kind === 'unknown') normalized.unknown += fraction
  })

  return normalized
}

const aimBasis = (stockCarryYds: number, aimRightYds: number) => {
  const length = Math.max(Math.hypot(aimRightYds, stockCarryYds), 1e-9)
  const forwardUnit: CoursePointYds = [aimRightYds / length, stockCarryYds / length]
  const rightUnit: CoursePointYds = [forwardUnit[1], -forwardUnit[0]]
  return { forwardUnit, rightUnit }
}

const landingPoint = (
  carryYds: number,
  offlineYds: number,
  stockCarryYds: number,
  aimRightYds: number,
): CoursePointYds => {
  const { forwardUnit, rightUnit } = aimBasis(stockCarryYds, aimRightYds)
  return [
    carryYds * forwardUnit[0] + offlineYds * rightUnit[0],
    carryYds * forwardUnit[1] + offlineYds * rightUnit[1],
  ]
}

const modeledNormalDistribution = (
  hole: CourseHoleGeometry,
  profile: LiveCaddieClubProfile,
  aimRightYds: number,
) => {
  const carrySigma = profile.carry_sigma_yds
  const lateralSigma = profile.lateral_sigma_yds
  if (
    typeof carrySigma !== 'number' ||
    !Number.isFinite(carrySigma) ||
    carrySigma <= 0 ||
    typeof lateralSigma !== 'number' ||
    !Number.isFinite(lateralSigma) ||
    lateralSigma <= 0
  ) {
    return null
  }

  const distribution = emptyDistribution()
  for (const carryZ of NORMAL_Z_POINTS) {
    for (const lateralZ of NORMAL_Z_POINTS) {
      const weight = gaussianWeight(carryZ) * gaussianWeight(lateralZ)
      const carry = Math.max(0, profile.stock_carry_yds + carryZ * carrySigma)
      const offline = (profile.lateral_bias_yds ?? 0) + lateralZ * lateralSigma
      const point = landingPoint(carry, offline, profile.stock_carry_yds, aimRightYds)
      addOutcome(distribution, classifyPoint(hole, point).kind, weight)
    }
  }

  return normalizeDistribution(distribution)
}

type WeightedShot = { shot: Shot; weight: number }

const eligibleRawStockShots = (
  sessions: SavedSession[],
  club: string,
  nowMs: number,
): WeightedShot[] => {
  const weighted: WeightedShot[] = []

  sessions.forEach((session) => {
    if (
      session.metadata?.includeInAnalysis === false ||
      isSystemOldExcludedSession(session, nowMs)
    ) {
      return
    }

    const shots = session.shots.filter(
      (shot) =>
        String(shot.club) === club &&
        isShotSourceIncluded(shot) &&
        resolveShotVariantId(shot.shotVariantId) === STOCK_SHOT_VARIANT_ID &&
        typeof shot.carryYards === 'number' &&
        Number.isFinite(shot.carryYards) &&
        typeof shot.offlineYards === 'number' &&
        Number.isFinite(shot.offlineYards),
    )
    if (shots.length === 0) return

    const sessionWeight =
      timeWeightForAgeDays(sessionAgeInDays(session, nowMs)) *
      sizeWeightForShotCount(shots.length)
    if (sessionWeight <= 0) return

    const shotWeight = sessionWeight / shots.length
    shots.forEach((shot) => weighted.push({ shot, weight: shotWeight }))
  })

  return weighted
}

const empiricalDistribution = (
  hole: CourseHoleGeometry,
  weightedShots: WeightedShot[],
  stockCarryYds: number,
  aimRightYds: number,
) => {
  const distribution = emptyDistribution()

  weightedShots.forEach(({ shot, weight }) => {
    if (typeof shot.carryYards !== 'number' || typeof shot.offlineYards !== 'number') return
    const point = landingPoint(
      shot.carryYards,
      shot.offlineYards,
      stockCarryYds,
      aimRightYds,
    )
    addOutcome(distribution, classifyPoint(hole, point).kind, weight)
  })

  return normalizeDistribution(distribution)
}

const mishitEvidenceForClub = (
  club: string,
  sessions: SavedSession[],
  nowMs: number,
): MishitEvidenceSummary => {
  const state = installMishitPlanningState(sessions)
  const populationKey = mishitPlanningPopulationKey({
    club: club as Club,
    shotVariantId: STOCK_SHOT_VARIANT_ID,
  })
  const population = state.populations.get(populationKey)
  if (!population) {
    return {
      baselineStatus: 'unavailable',
      evidence: 'low',
      totalShots: 0,
      classifiedShots: 0,
      unclassifiedShots: 0,
      normalShots: 0,
      mishitShots: 0,
      severeMishitShots: 0,
      observedMishitRate: null,
      averageClassificationConfidence: null,
    }
  }

  const eligibleShotIds = new Set(
    eligibleRawStockShots(sessions, club, nowMs).map(({ shot }) => shot.id),
  )
  const classifications = population.analysis.classifications.filter((classification) =>
    eligibleShotIds.has(classification.shotId),
  )

  const normalShots = classifications.filter((item) => item.classification === 'normal').length
  const mishitShots = classifications.filter((item) => item.classification === 'mishit').length
  const severeMishitShots = classifications.filter(
    (item) => item.classification === 'severe_mishit',
  ).length
  const unclassifiedShots = classifications.filter(
    (item) => item.classification === 'unclassified',
  ).length
  const classifiedShots = normalShots + mishitShots + severeMishitShots
  const observedMishitRate =
    classifiedShots > 0 ? (mishitShots + severeMishitShots) / classifiedShots : null
  const confidenceValues = classifications
    .filter((item) => item.classification !== 'unclassified')
    .map((item) => item.confidence)
  const averageClassificationConfidence =
    confidenceValues.length > 0
      ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
      : null
  const baselineStatus = population.analysis.baseline.status
  const evidence =
    baselineStatus === 'stable'
      ? 'high'
      : baselineStatus === 'provisional'
        ? 'medium'
        : 'low'

  return {
    baselineStatus,
    evidence,
    totalShots: classifications.length,
    classifiedShots,
    unclassifiedShots,
    normalShots,
    mishitShots,
    severeMishitShots,
    observedMishitRate,
    averageClassificationConfidence,
  }
}

const supportForClub = (
  profileSet: ReturnType<typeof buildLiveCaddieProfileSet>,
  club: string,
) => profileSet.club_support.find((item) => item.club === club)

export const evaluatePlayerStockClubsOnHole = (
  sessions: SavedSession[],
  hole: CourseHoleGeometry,
  nowMs = Date.now(),
): ClubGeometryOutcome[] => {
  // The standard Looper profile builder intentionally consumes installed mishit
  // planning state. Install it first so Stock remains the same truth used elsewhere.
  installMishitPlanningState(sessions)
  const profileSet = buildLiveCaddieProfileSet(sessions, nowMs)

  return profileSet.clubs.map((profile) => {
    const corridor = fairwayCorridorAtForwardY(hole, profile.stock_carry_yds)
    const aimRightYdsAtStockCarry = corridor?.centerRightYds ?? 0
    const planningModel = modeledNormalDistribution(hole, profile, aimRightYdsAtStockCarry)
    const rawShots = eligibleRawStockShots(sessions, profile.club, nowMs)
    const empiricalAllShots = empiricalDistribution(
      hole,
      rawShots,
      profile.stock_carry_yds,
      aimRightYdsAtStockCarry,
    )
    const support = supportForClub(profileSet, profile.club)
    const mishitEvidence = mishitEvidenceForClub(profile.club, sessions, nowMs)
    const empiricalSupported = rawShots.length >= 5 && empiricalAllShots != null

    const preferredValues = [planningModel?.preferred]
    const troubleValues = [planningModel?.trouble]
    const penaltyValues = [planningModel?.penalty]
    if (empiricalSupported && empiricalAllShots) {
      preferredValues.push(empiricalAllShots.preferred)
      troubleValues.push(empiricalAllShots.trouble)
      penaltyValues.push(empiricalAllShots.penalty)
    }

    const definedPreferred = preferredValues.filter(
      (value): value is number => typeof value === 'number',
    )
    const definedTrouble = troubleValues.filter(
      (value): value is number => typeof value === 'number',
    )
    const definedPenalty = penaltyValues.filter(
      (value): value is number => typeof value === 'number',
    )

    const meanLanding = landingPoint(
      profile.stock_carry_yds,
      profile.lateral_bias_yds ?? 0,
      profile.stock_carry_yds,
      aimRightYdsAtStockCarry,
    )

    const notes: string[] = []
    if (!corridor) notes.push('No fairway corridor is mapped at this stock carry.')
    if (!planningModel) notes.push('Stock profile lacks usable carry/lateral sigma.')
    if (rawShots.length < 5) {
      notes.push('Empirical all-shot risk is under-supported (<5 usable Stock shots).')
    }
    if (mishitEvidence.evidence !== 'high') {
      notes.push(
        'Mishit evidence is immature; normal-shot geometry can look safer than the eventual mature player model.',
      )
    }

    return {
      club: profile.club,
      stockCarryYds: profile.stock_carry_yds,
      carrySigmaYds: profile.carry_sigma_yds ?? null,
      lateralBiasYds: profile.lateral_bias_yds ?? 0,
      lateralSigmaYds: profile.lateral_sigma_yds ?? null,
      aimRightYdsAtStockCarry,
      meanLanding,
      planningModel,
      empiricalAllShots,
      empiricalShotCount: rawShots.length,
      profileSupportShots: support?.included_stock_shots ?? 0,
      profileSupportingSessions: support?.sessions ?? 0,
      mishitEvidence,
      riskEnvelope: {
        preferredFloor:
          definedPreferred.length > 0 ? Math.min(...definedPreferred) : null,
        troubleCeiling:
          definedTrouble.length > 0 ? Math.max(...definedTrouble) : null,
        penaltyCeiling:
          definedPenalty.length > 0 ? Math.max(...definedPenalty) : null,
        basis: empiricalSupported ? 'planning-plus-empirical' : 'planning-only',
      },
      notes,
    }
  })
}
