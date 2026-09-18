import { classifyPoint } from '../courseGeometry/geometry'
import type {
  CourseHoleGeometry,
  CoursePointYds,
} from '../courseGeometry/types'
import type { SavedSession } from '../types'
import { buildAirAltitudeAdjustment } from './airAltitudeAdjustment'
import {
  rankRiskAwareAimCandidates,
  rankRiskAwareClubChoices,
} from './aimDecisionRanking'
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

/**
 * Expand the lateral search for wider player patterns while keeping the old
 * ±15 yd sweep as the floor. This is search-space plumbing, not strategy: the
 * ranking policy still decides whether an extreme line is worthwhile.
 */
export const buildAimOffsetsYds = (lateralSigmaYds: number | null | undefined) => {
  const sigma = typeof lateralSigmaYds === 'number' && Number.isFinite(lateralSigmaYds)
    ? Math.max(0, lateralSigmaYds)
    : 0
  const halfWidth = Math.max(15, Math.min(36, Math.ceil((sigma * 1.5) / 3) * 3))
  const offsets: number[] = []
  for (let offset = -halfWidth; offset <= halfWidth + 1e-9; offset += 3) offsets.push(offset)
  return offsets
}

/**
 * Legacy V0 utility remains visible for diagnostics and as a final tie-breaker.
 * It is no longer the authoritative recommendation policy when full-risk data
 * is available.
 */
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
  /** Absolute ball elevation above sea level used for air-density flight adjustment. */
  airAltitudeFt?: number | null
  airAltitudeSource?: string
  /** Authoritative current GSPro lie surface. OSM remains the landing-outcome classifier. */
  surfaceOverride?: string | null
  /**
   * Optional per-club strategic target. Used by off-sim natural-landing
   * diagnostics so Driver, 3W, hybrid, etc. can aim through the corridor at
   * their own natural carry rather than sharing an arbitrary fixed distance.
   * Default/live behavior remains unchanged when omitted.
   */
  clubTargets?: Readonly<Record<string, CoursePointYds | undefined>>
}

export type { AimSurfaceDistribution } from './aimOutcomeSampling'

export type AimCandidateEvaluation = {
  aimOffsetYds: number
  aimPoint: CoursePointYds
  /** Resting/final expected center after historical rollout. */
  meanLanding: CoursePointYds
  /** Probabilities and the map cloud come from this exact deterministic sample set. */
  surfaceOutcomes: AimSurfaceDistribution | null
  modeledSamples: ModeledAimSample[]
  probabilityContours: AimProbabilityContour[]
  /**
   * Authoritative tactical risk profile: normal/core probability mass plus the
   * empirically learned planning-excluded tail.
   */
  riskProfile: DecisionRiskProfile | null
  /** Weighted historical Stock shots, including the observed mishit tail, replayed at this aim. */
  empiricalAllShots: EmpiricalAimSurfaceDistribution | null
  empiricalShotCount: number
  /** Legacy V0 utility retained for diagnostics and final deterministic tie-breaking. */
  score: number | null
  scoreParts: {
    preferred: number
    nonPenaltyTrouble: number
    penalty: number
    unknown: number
    carryFit: number
  } | null
  decisionRank: number | null
  withinCatastropheGuardrail: boolean | null
  decisionReason: string | null
}

export type ClubAimEvaluation = {
  club: string
  variant: 'Stock'
  stockCarryYds: number
  stockTotalYds: number
  modeledCarryYds: number
  modeledTotalYds: number
  rolloutYds: number
  airAltitudeFt: number | null
  altitudeCarryDeltaYds: number
  altitudeLateralDeltaYds: number
  airborneCarryDeltaYds: number
  /** Individual airborne components are exposed for the player-facing condition math. */
  elevationCarryDeltaYds?: number
  windCarryDeltaYds?: number
  windLateralDeltaYds?: number
  lieCarryDeltaYds?: number
  lieLateralDeltaYds?: number
  surfaceCarryDeltaYds: number
  surfaceLabel: string
  carrySigmaYds: number | null
  totalSigmaYds: number | null
  lateralBiasYds: number
  modeledLateralBiasYds: number
  airborneLateralDeltaYds: number
  surfaceLateralDeltaYds: number
  lateralSigmaYds: number | null
  planningTarget: CoursePointYds
  targetDistanceYds: number
  carryGapYds: number
  aimSearchHalfWidthYds: number
  supportShots: number
  supportingSessions: number
  modeledSampleCount: number
  empiricalShotCount: number
  candidates: AimCandidateEvaluation[]
  bestCandidate: AimCandidateEvaluation | null
  decisionRank: number | null
  targetFit: boolean | null
  withinCatastropheGuardrail: boolean | null
  decisionReason: string | null
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
  const geometrySurface = classifyPoint(hole, ball).kind
  const ballSurface = environment.surfaceOverride?.trim() || geometrySurface

  const evaluations = profileSet.clubs.map((profile): ClubAimEvaluation => {
    const support = profileSet.club_support.find((item) => item.club === profile.club)
    const decisionPlayer = decisionPlayers.find((item) => item.club === profile.club) ?? null
    const planningTarget = environment.clubTargets?.[profile.club] ?? target
    const decisionGoal = inferDecisionShotGoal(hole, planningTarget)
    const targetDistanceYds = Math.hypot(
      planningTarget[0] - ball[0],
      planningTarget[1] - ball[1],
    )
    const aimOffsetsYds = buildAimOffsetsYds(profile.lateral_sigma_yds)
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

    const altitudeLaunch =
      launch &&
      typeof launch.ball_speed_mph === 'number' && Number.isFinite(launch.ball_speed_mph) &&
      typeof launch.vla_deg === 'number' && Number.isFinite(launch.vla_deg) &&
      typeof launch.total_spin_rpm === 'number' && Number.isFinite(launch.total_spin_rpm)
        ? {
            ballSpeedMph: launch.ball_speed_mph,
            vlaDeg: launch.vla_deg,
            hlaDeg: launch.hla_deg ?? 0,
            totalSpinRpm: launch.total_spin_rpm,
            spinAxisDeg: launch.spin_axis_deg ?? 0,
          }
        : null
    const altitudeAdjustment = buildAirAltitudeAdjustment(
      altitudeLaunch,
      environment.airAltitudeFt,
    )

    const baseModeledCarryYds = modeled.modeledCarryYds ?? profile.stock_carry_yds
    const modeledCarryYds = baseModeledCarryYds + altitudeAdjustment.carryDeltaYds
    const stockTotalYds =
      typeof profile.stock_total_yds === 'number' && Number.isFinite(profile.stock_total_yds)
        ? Math.max(profile.stock_carry_yds, profile.stock_total_yds)
        : profile.stock_carry_yds
    const rolloutYds = Math.max(0, stockTotalYds - profile.stock_carry_yds)
    // Until destination-surface rollout physics are validated, preserve the player's
    // observed Stock rollout and translate both carry and total by the same live carry delta.
    const modeledTotalYds = modeledCarryYds + rolloutYds
    const baseLateralBiasYds = profile.lateral_bias_yds ?? 0
    const baseModeledLateralBiasYds = modeled.modeledLateralBiasYds ?? baseLateralBiasYds
    const modeledLateralBiasYds = baseModeledLateralBiasYds + altitudeAdjustment.lateralDeltaYds
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
    if (altitudeAdjustment.status === 'ready' && Math.abs(altitudeAdjustment.carryDeltaYds) >= 0.25) {
      notes.push(
        `Base altitude ${Math.round(altitudeAdjustment.altitudeFt ?? 0)} ft adjusts carry by ${altitudeAdjustment.carryDeltaYds >= 0 ? '+' : ''}${altitudeAdjustment.carryDeltaYds.toFixed(1)} yd from air density.`,
      )
    } else if (
      typeof environment.airAltitudeFt === 'number' &&
      Number.isFinite(environment.airAltitudeFt) &&
      Math.abs(environment.airAltitudeFt) >= 500 &&
      altitudeAdjustment.status !== 'ready'
    ) {
      notes.push('Base altitude is known but representative launch data are insufficient for the air-density adjustment.')
    }
    if (environment.surfaceOverride && environment.surfaceOverride !== geometrySurface) {
      notes.push(`GSPro current lie (${environment.surfaceOverride}) overrides cached-map surface (${geometrySurface}) for launch response.`)
    }
    if (rolloutYds > 0) {
      notes.push(`Final-position outcomes include ${rolloutYds.toFixed(1)} yd of observed Stock rollout beyond carry.`)
    }

    const candidates = aimOffsetsYds.map((aimOffsetYds): AimCandidateEvaluation => {
      const aimPoint = aimPointAtOffset(ball, planningTarget, aimOffsetYds)
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
        totalMeanYds: modeledTotalYds,
        lateralMeanYds: modeledLateralBiasYds,
        carrySigmaYds: profile.carry_sigma_yds,
        totalSigmaYds: profile.total_sigma_yds,
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
          decisionRank: null,
          withinCatastropheGuardrail: null,
          decisionReason: null,
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
        decisionRank: null,
        withinCatastropheGuardrail: null,
        decisionReason: null,
      }
    })

    const rankedCandidates = rankRiskAwareAimCandidates(candidates)
    rankedCandidates.forEach((ranked) => {
      ranked.candidate.decisionRank = ranked.rank
      ranked.candidate.withinCatastropheGuardrail = ranked.withinCatastropheGuardrail
      ranked.candidate.decisionReason = ranked.decisionReason
    })
    const bestCandidate = rankedCandidates[0]?.candidate ?? null

    if (!bestCandidate) notes.push('No usable carry/lateral dispersion model for this club.')

    return {
      club: profile.club,
      variant: 'Stock',
      stockCarryYds: profile.stock_carry_yds,
      stockTotalYds,
      modeledCarryYds,
      modeledTotalYds,
      rolloutYds,
      airAltitudeFt: altitudeAdjustment.altitudeFt,
      altitudeCarryDeltaYds: altitudeAdjustment.carryDeltaYds,
      altitudeLateralDeltaYds: altitudeAdjustment.lateralDeltaYds,
      airborneCarryDeltaYds: modeled.appliedAdjustments.combinedAirborneCarryYds,
      elevationCarryDeltaYds: modeled.appliedAdjustments.elevationYds,
      windCarryDeltaYds: modeled.appliedAdjustments.windCarryYds,
      windLateralDeltaYds: modeled.appliedAdjustments.windLateralYds,
      lieCarryDeltaYds: modeled.appliedAdjustments.lieCarryYds,
      lieLateralDeltaYds: modeled.appliedAdjustments.lieLateralYds,
      surfaceCarryDeltaYds: modeled.appliedAdjustments.surfaceCarryYds,
      surfaceLabel: modeled.surfaceResponse.label,
      carrySigmaYds: profile.carry_sigma_yds ?? null,
      totalSigmaYds: profile.total_sigma_yds ?? null,
      lateralBiasYds: baseLateralBiasYds,
      modeledLateralBiasYds,
      airborneLateralDeltaYds:
        modeled.appliedAdjustments.combinedAirborneLateralYds + altitudeAdjustment.lateralDeltaYds,
      surfaceLateralDeltaYds: modeled.appliedAdjustments.surfaceLateralYds,
      lateralSigmaYds: profile.lateral_sigma_yds ?? null,
      planningTarget,
      targetDistanceYds,
      carryGapYds,
      aimSearchHalfWidthYds: Math.max(...aimOffsetsYds.map((offset) => Math.abs(offset))),
      supportShots: support?.included_stock_shots ?? 0,
      supportingSessions: support?.sessions ?? 0,
      modeledSampleCount: MODELED_AIM_SAMPLE_COUNT,
      empiricalShotCount: empiricalShots.length,
      candidates,
      bestCandidate,
      decisionRank: null,
      targetFit: null,
      withinCatastropheGuardrail: null,
      decisionReason: null,
      notes,
    }
  })

  const rankedClubs = rankRiskAwareClubChoices(evaluations)
  rankedClubs.forEach((ranked) => {
    ranked.evaluation.decisionRank = ranked.rank
    ranked.evaluation.targetFit = ranked.targetFit
    ranked.evaluation.withinCatastropheGuardrail = ranked.withinCatastropheGuardrail
    ranked.evaluation.decisionReason = ranked.decisionReason
  })

  return rankedClubs.map((ranked) => ranked.evaluation)
}
