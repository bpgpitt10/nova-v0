import { classifyPoint } from '../courseGeometry/geometry'
import { TACTICAL_SURFACE_SEMANTICS } from '../courseGeometry/semantics'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import type { SavedSession } from '../types'
import { buildLiveCaddieProfileSet } from './profileProvider'
import { modelShotContext } from './shotContextModel'
import type { LiveCaddieClubProfile } from './types'

export const AIM_OFFSETS_YDS = [-15, -12, -9, -6, -3, 0, 3, 6, 9, 12, 15] as const

export const AIM_SCORE_ASSUMPTIONS = {
  preferredWeight: 100,
  nonPenaltyTroubleWeight: -80,
  penaltyWeight: -180,
  unknownWeight: -40,
  carryGapPerYard: -1.5,
} as const

export type AimLabEnvironment = {
  windMph?: number
  windRelativeDeg?: number
  elevationDeltaFt?: number | null
  elevationSource?: string
  /** Authoritative current GSPro lie surface. OSM remains the landing-outcome classifier. */
  surfaceOverride?: string | null
}

export type AimSurfaceDistribution = {
  bySurface: Partial<Record<CourseSurfaceClassification, number>>
  preferred: number
  rough: number
  trouble: number
  penalty: number
  unknown: number
}

export type AimCandidateEvaluation = {
  aimOffsetYds: number
  aimPoint: CoursePointYds
  meanLanding: CoursePointYds
  surfaceOutcomes: AimSurfaceDistribution | null
  score: number | null
  scoreParts: {
    preferred: number
    nonPenaltyTrouble: number
    penalty: number
    unknown: number
    carryFit: number
  } | null
}

export type ClubAimEvaluation = {
  club: string
  variant: 'Stock'
  stockCarryYds: number
  modeledCarryYds: number
  airborneCarryDeltaYds: number
  surfaceCarryDeltaYds: number
  surfaceLabel: string
  carrySigmaYds: number | null
  lateralBiasYds: number
  modeledLateralBiasYds: number
  airborneLateralDeltaYds: number
  surfaceLateralDeltaYds: number
  lateralSigmaYds: number | null
  targetDistanceYds: number
  carryGapYds: number
  supportShots: number
  supportingSessions: number
  candidates: AimCandidateEvaluation[]
  bestCandidate: AimCandidateEvaluation | null
  notes: string[]
}

const Z_POINTS = [-3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3] as const
const gaussianWeight = (z: number) => Math.exp(-0.5 * z * z)

const vector = (from: CoursePointYds, to: CoursePointYds): CoursePointYds => [
  to[0] - from[0],
  to[1] - from[1],
]

const unit = (value: CoursePointYds): CoursePointYds => {
  const length = Math.hypot(value[0], value[1])
  return length > 1e-9 ? [value[0] / length, value[1] / length] : [0, 1]
}

const rightOf = (forward: CoursePointYds): CoursePointYds => [forward[1], -forward[0]]

const addScaled = (
  origin: CoursePointYds,
  forward: CoursePointYds,
  forwardYds: number,
  right: CoursePointYds,
  rightYds: number,
): CoursePointYds => [
  origin[0] + forward[0] * forwardYds + right[0] * rightYds,
  origin[1] + forward[1] * forwardYds + right[1] * rightYds,
]

const aimPointAtOffset = (
  ball: CoursePointYds,
  target: CoursePointYds,
  aimOffsetYds: number,
) => {
  const baseForward = unit(vector(ball, target))
  const baseRight = rightOf(baseForward)
  return addScaled(target, baseForward, 0, baseRight, aimOffsetYds)
}

const modeledDistribution = (
  hole: CourseHoleGeometry,
  profile: LiveCaddieClubProfile,
  ball: CoursePointYds,
  aimPoint: CoursePointYds,
  carryMeanYds: number,
  lateralMeanYds: number,
): { distribution: AimSurfaceDistribution; meanLanding: CoursePointYds } | null => {
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

  const forward = unit(vector(ball, aimPoint))
  const right = rightOf(forward)
  const weights: Partial<Record<CourseSurfaceClassification, number>> = {}
  let totalWeight = 0

  for (const carryZ of Z_POINTS) {
    for (const lateralZ of Z_POINTS) {
      const weight = gaussianWeight(carryZ) * gaussianWeight(lateralZ)
      const carry = Math.max(0, carryMeanYds + carryZ * carrySigma)
      const offline = lateralMeanYds + lateralZ * lateralSigma
      const landing = addScaled(ball, forward, carry, right, offline)
      const kind = classifyPoint(hole, landing).kind
      weights[kind] = (weights[kind] ?? 0) + weight
      totalWeight += weight
    }
  }

  const bySurface: Partial<Record<CourseSurfaceClassification, number>> = {}
  Object.entries(weights).forEach(([kind, weight]) => {
    bySurface[kind as CourseSurfaceClassification] = weight / totalWeight
  })

  let preferred = 0
  let rough = 0
  let trouble = 0
  let penalty = 0
  let unknown = 0
  Object.entries(bySurface).forEach(([kind, fraction]) => {
    const typedKind = kind as CourseSurfaceClassification
    const semantics = TACTICAL_SURFACE_SEMANTICS[typedKind]
    if (semantics.preferred) preferred += fraction
    if (typedKind === 'rough') rough += fraction
    if (semantics.countsAsTrouble) trouble += fraction
    if (semantics.countsAsPenalty) penalty += fraction
    if (typedKind === 'unknown') unknown += fraction
  })

  const meanLanding = addScaled(
    ball,
    forward,
    carryMeanYds,
    right,
    lateralMeanYds,
  )

  return {
    distribution: { bySurface, preferred, rough, trouble, penalty, unknown },
    meanLanding,
  }
}

const scoreCandidate = (
  distribution: AimSurfaceDistribution,
  carryGapYds: number,
) => {
  const nonPenaltyTrouble = Math.max(0, distribution.trouble - distribution.penalty)
  const scoreParts = {
    preferred: distribution.preferred * AIM_SCORE_ASSUMPTIONS.preferredWeight,
    nonPenaltyTrouble:
      nonPenaltyTrouble * AIM_SCORE_ASSUMPTIONS.nonPenaltyTroubleWeight,
    penalty: distribution.penalty * AIM_SCORE_ASSUMPTIONS.penaltyWeight,
    unknown: distribution.unknown * AIM_SCORE_ASSUMPTIONS.unknownWeight,
    carryFit: Math.abs(carryGapYds) * AIM_SCORE_ASSUMPTIONS.carryGapPerYard,
  }
  return {
    score: Object.values(scoreParts).reduce((sum, value) => sum + value, 0),
    scoreParts,
  }
}

export const evaluateAimLab = (
  sessions: SavedSession[],
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  target: CoursePointYds,
  environmentOrNowMs: AimLabEnvironment | number = {},
  explicitNowMs = Date.now(),
): ClubAimEvaluation[] => {
  const environment = typeof environmentOrNowMs === 'number' ? {} : environmentOrNowMs
  const nowMs = typeof environmentOrNowMs === 'number' ? environmentOrNowMs : explicitNowMs
  const profileSet = buildLiveCaddieProfileSet(sessions, nowMs)
  const targetDistanceYds = Math.hypot(target[0] - ball[0], target[1] - ball[1])
  const geometrySurface = classifyPoint(hole, ball).kind
  const ballSurface = environment.surfaceOverride?.trim() || geometrySurface

  return profileSet.clubs
    .map((profile): ClubAimEvaluation => {
      const support = profileSet.club_support.find((item) => item.club === profile.club)
      const launch = profile.launch_profile
      const modeled = modelShotContext(
        {
          club: profile.club,
          variant: 'Stock',
          stockCarryYds: profile.stock_carry_yds,
          carrySigmaYds: profile.carry_sigma_yds ?? null,
          lateralBiasYds: profile.lateral_bias_yds ?? 0,
          lateralSigmaYds: profile.lateral_sigma_yds ?? null,
          supportShots: support?.included_stock_shots ?? 0,
          launchBallSpeedMph: launch?.ball_speed_mph ?? null,
          launchVlaDeg: launch?.vla_deg ?? null,
          launchHlaDeg: launch?.hla_deg ?? null,
          launchSpinRpm: launch?.total_spin_rpm ?? null,
          launchSpinAxisDeg: launch?.spin_axis_deg ?? null,
        },
        {
          targetDistanceYds,
          surface: ballSurface,
          windMph: environment.windMph ?? 0,
          windRelativeDeg: environment.windRelativeDeg ?? 0,
          elevationDeltaFt: environment.elevationDeltaFt ?? 0,
          elevationSource: environment.elevationSource ?? 'Aim Lab target terrain',
          elevationConfidence: environment.elevationDeltaFt == null ? 'unknown' : 'medium',
        },
      )

      const modeledCarryYds = modeled.modeledCarryYds ?? profile.stock_carry_yds
      const modeledLateralBiasYds = modeled.modeledLateralBiasYds ?? (profile.lateral_bias_yds ?? 0)
      const carryGapYds = modeledCarryYds - targetDistanceYds
      const notes: string[] = []
      if (Math.abs(carryGapYds) > 35) {
        notes.push('Modeled carry is more than 35 yd from the selected landing target.')
      }
      if (support && support.included_stock_shots < 5) {
        notes.push('Thin Stock support (<5 included shots).')
      }
      if (modeled.physicsPrior.status !== 'ready' && ((environment.windMph ?? 0) !== 0 || (environment.elevationDeltaFt ?? 0) !== 0)) {
        notes.push('Airborne physics unavailable for this club; Stock baseline used for environmental response.')
      }
      if (environment.surfaceOverride && environment.surfaceOverride !== geometrySurface) {
        notes.push(`GSPro current lie (${environment.surfaceOverride}) overrides cached-map surface (${geometrySurface}) for launch response.`)
      }

      const candidates = AIM_OFFSETS_YDS.map((aimOffsetYds): AimCandidateEvaluation => {
        const aimPoint = aimPointAtOffset(ball, target, aimOffsetYds)
        const distribution = modeledDistribution(
          hole,
          profile,
          ball,
          aimPoint,
          modeledCarryYds,
          modeledLateralBiasYds,
        )
        if (!distribution) {
          return {
            aimOffsetYds,
            aimPoint,
            meanLanding: aimPoint,
            surfaceOutcomes: null,
            score: null,
            scoreParts: null,
          }
        }
        const scored = scoreCandidate(distribution.distribution, carryGapYds)
        return {
          aimOffsetYds,
          aimPoint,
          meanLanding: distribution.meanLanding,
          surfaceOutcomes: distribution.distribution,
          score: scored.score,
          scoreParts: scored.scoreParts,
        }
      })

      const scoredCandidates = candidates.filter(
        (candidate): candidate is AimCandidateEvaluation & { score: number } =>
          typeof candidate.score === 'number',
      )
      const bestCandidate =
        scoredCandidates.length > 0
          ? scoredCandidates.reduce((best, candidate) =>
              candidate.score > best.score ? candidate : best,
            )
          : null

      if (!bestCandidate) notes.push('No usable carry/lateral dispersion model for this club.')

      return {
        club: profile.club,
        variant: 'Stock',
        stockCarryYds: profile.stock_carry_yds,
        modeledCarryYds,
        airborneCarryDeltaYds: modeled.appliedAdjustments.combinedAirborneCarryYds,
        surfaceCarryDeltaYds: modeled.appliedAdjustments.surfaceCarryYds,
        surfaceLabel: modeled.surfaceResponse.label,
        carrySigmaYds: profile.carry_sigma_yds ?? null,
        lateralBiasYds: profile.lateral_bias_yds ?? 0,
        modeledLateralBiasYds,
        airborneLateralDeltaYds: modeled.appliedAdjustments.combinedAirborneLateralYds,
        surfaceLateralDeltaYds: modeled.appliedAdjustments.surfaceLateralYds,
        lateralSigmaYds: profile.lateral_sigma_yds ?? null,
        targetDistanceYds,
        carryGapYds,
        supportShots: support?.included_stock_shots ?? 0,
        supportingSessions: support?.sessions ?? 0,
        candidates,
        bestCandidate,
        notes,
      }
    })
    .sort((a, b) => {
      const scoreA = a.bestCandidate?.score ?? Number.NEGATIVE_INFINITY
      const scoreB = b.bestCandidate?.score ?? Number.NEGATIVE_INFINITY
      return scoreB - scoreA
    })
}
