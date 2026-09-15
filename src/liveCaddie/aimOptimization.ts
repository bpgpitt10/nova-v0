import { classifyPoint } from '../courseGeometry/geometry'
import type {
  CourseHoleGeometry,
  CoursePointYds,
} from '../courseGeometry/types'
import type { SavedSession } from '../types'
import {
  MODELED_AIM_SAMPLE_COUNT,
  sampleModeledAimDistribution,
  type AimProbabilityContour,
  type AimSurfaceDistribution,
  type ModeledAimSample,
} from './aimOutcomeSampling'
import {
  buildDecisionPlayerModels,
  inferDecisionShotGoal,
} from './decisionEngine'
import {
  buildDecisionRiskProfile,
  type DecisionRiskProfile,
} from './decisionRiskProfile'
import {
  buildWeightedEmpiricalStockShots,
  evaluateEmpiricalAimDistribution,
  type EmpiricalAimSurfaceDistribution,
} from './empiricalAimOutcomes'
import { buildLiveCaddieProfileSet } from './profileProvider'
import { modelShotContext } from './shotContextModel'

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

export type { AimSurfaceDistribution } from './aimOutcomeSampling'

export type AimCandidateEvaluation = {
  aimOffsetYds: number
  aimPoint: CoursePointYds
  meanLanding: CoursePointYds
  /** Probabilities and the map cloud come from this exact deterministic sample set. */
  surfaceOutcomes: AimSurfaceDistribution | null
  modeledSamples: ModeledAimSample[]
  probabilityContours: AimProbabilityContour[]
  /**
   * Full tactical risk = normal/core probability mass plus the empirically learned
   * planning-excluded tail. This is inspection-only for now and does not change V0 scoring.
   */
  riskProfile: DecisionRiskProfile | null
  /** Weighted historical Stock shots, including the observed mishit tail, replayed at this aim. */
  empiricalAllShots: EmpiricalAimSurfaceDistribution | null
  empiricalShotCount: number
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
  modeledSampleCount: number
  empiricalShotCount: number
  candidates: AimCandidateEvaluation[]
  bestCandidate: AimCandidateEvaluation | null
  notes: string[]
}

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
  const decisionPlayers = buildDecisionPlayerModels(sessions, nowMs)
  const decisionGoal = inferDecisionShotGoal(hole, target)
  const targetDistanceYds = Math.hypot(target[0] - ball[0], target[1] - ball[1])
  const geometrySurface = classifyPoint(hole, ball).kind
  const ballSurface = environment.surfaceOverride?.trim() || geometrySurface

  return profileSet.clubs
    .map((profile): ClubAimEvaluation => {
      const support = profileSet.club_support.find((item) => item.club === profile.club)
      const decisionPlayer = decisionPlayers.find((item) => item.club === profile.club) ?? null
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
      const baseLateralBiasYds = profile.lateral_bias_yds ?? 0
      const modeledLateralBiasYds = modeled.modeledLateralBiasYds ?? baseLateralBiasYds
      const carryGapYds = modeledCarryYds - targetDistanceYds
      const empiricalShots = buildWeightedEmpiricalStockShots(sessions, profile.club, nowMs)
      const empiricalCarryAdjustmentYds = modeledCarryYds - profile.stock_carry_yds
      const empiricalLateralAdjustmentYds = modeledLateralBiasYds - baseLateralBiasYds
      const notes: string[] = []
      if (Math.abs(carryGapYds) > 35) {
        notes.push('Modeled carry is more than 35 yd from the selected landing target.')
      }
      if (support && support.included_stock_shots < 5) {
        notes.push('Thin Stock support (<5 included shots).')
      }
      if (empiricalShots.length < 5) {
        notes.push('Empirical all-shot aim outcomes are under-supported (<5 usable Stock shots).')
      }
      if (!decisionPlayer) {
        notes.push('No decision-tail population is available for this club yet.')
      }
      if (modeled.physicsPrior.status !== 'ready' && ((environment.windMph ?? 0) !== 0 || (environment.elevationDeltaFt ?? 0) !== 0)) {
        notes.push('Airborne physics unavailable for this club; Stock baseline used for environmental response.')
      }
      if (environment.surfaceOverride && environment.surfaceOverride !== geometrySurface) {
        notes.push(`GSPro current lie (${environment.surfaceOverride}) overrides cached-map surface (${geometrySurface}) for launch response.`)
      }

      const candidates = AIM_OFFSETS_YDS.map((aimOffsetYds): AimCandidateEvaluation => {
        const aimPoint = aimPointAtOffset(ball, target, aimOffsetYds)
        const empiricalAllShots = evaluateEmpiricalAimDistribution(
          hole,
          empiricalShots,
          ball,
          aimPoint,
          empiricalCarryAdjustmentYds,
          empiricalLateralAdjustmentYds,
        )
        const sampled = sampleModeledAimDistribution({
          hole,
          ball,
          aimPoint,
          carryMeanYds: modeledCarryYds,
          lateralMeanYds: modeledLateralBiasYds,
          carrySigmaYds: profile.carry_sigma_yds,
          lateralSigmaYds: profile.lateral_sigma_yds,
        })
        if (!sampled) {
          return {
            aimOffsetYds,
            aimPoint,
            meanLanding: aimPoint,
            surfaceOutcomes: null,
            modeledSamples: [],
            probabilityContours: [],
            riskProfile: null,
            empiricalAllShots,
            empiricalShotCount: empiricalShots.length,
            score: null,
            scoreParts: null,
          }
        }
        const riskProfile = buildDecisionRiskProfile({
          hole,
          ball,
          aimPoint,
          goal: decisionGoal,
          coreSamples: sampled.samples,
          player: decisionPlayer,
          carryAdjustmentYds: empiricalCarryAdjustmentYds,
          lateralAdjustmentYds: empiricalLateralAdjustmentYds,
        })
        const scored = scoreCandidate(sampled.distribution, carryGapYds)
        return {
          aimOffsetYds,
          aimPoint,
          meanLanding: sampled.meanLanding,
          surfaceOutcomes: sampled.distribution,
          modeledSamples: sampled.samples,
          probabilityContours: sampled.probabilityContours,
          riskProfile,
          empiricalAllShots,
          empiricalShotCount: empiricalShots.length,
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
        lateralBiasYds: baseLateralBiasYds,
        modeledLateralBiasYds,
        airborneLateralDeltaYds: modeled.appliedAdjustments.combinedAirborneLateralYds,
        surfaceLateralDeltaYds: modeled.appliedAdjustments.surfaceLateralYds,
        lateralSigmaYds: profile.lateral_sigma_yds ?? null,
        targetDistanceYds,
        carryGapYds,
        supportShots: support?.included_stock_shots ?? 0,
        supportingSessions: support?.sessions ?? 0,
        modeledSampleCount: MODELED_AIM_SAMPLE_COUNT,
        empiricalShotCount: empiricalShots.length,
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
