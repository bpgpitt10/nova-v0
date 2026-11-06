import { classifyPoint, fairwayCorridorAtForwardY } from '../courseGeometry/geometry'
import { classifyTacticalLandingPoint } from '../courseGeometry/tacticalClassification'
import { makeRollLandingTransform } from './rollModel'
import { estimateGreywolfTerrain as estimateCourseTerrain } from '../courseGeometry/lidar'
import type { CourseGreenDetail } from '../courseGeometry/courseGreenDetail'
import type {
  CourseHoleGeometry,
  CoursePointYds,
} from '../courseGeometry/types'
import type { SavedSession } from '../types'
import { buildAirAltitudeAdjustment } from './airAltitudeAdjustment'
import { clubEligibleForShot, resolveShotOriginEligibility, type ShotOriginEligibility } from './clubShotEligibility'
import {
  rankRiskAwareAimCandidates,
  rankRiskAwareClubChoices,
} from './aimDecisionRanking'
import type { QuickBagPrior } from '../lib/quickBag'
import { applyQuickBagToPlayers, applyQuickBagToProfileSet, type StartingBagMark } from './quickBagProfiles'
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
import { redirectCourseGreenRollout } from './greenTargeting'
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
  /**
   * The player's Quick Bag (handicap + three carries), laid under the range
   * data so every club in the bag has numbers from the first hole. Clubs fade
   * to their own range data by shot count (lib/quickBag BLEND_RULES).
   */
  quickBag?: QuickBagPrior | null
  windMph?: number
  windRelativeDeg?: number
  elevationDeltaFt?: number | null
  elevationSource?: string
  /** Absolute ball elevation above sea level used for air-density flight adjustment. */
  airAltitudeFt?: number | null
  airAltitudeSource?: string
  /** Authoritative current GSPro lie surface. OSM remains the landing-outcome classifier. */
  surfaceOverride?: string | null
  /** Driver and Mini Driver are eligible ONLY when the tee shot is affirmed.
   * Live callers MUST pass the actual GSPro tee/shot state explicitly. */
  shotOrigin?: ShotOriginEligibility
  /** Positive = GSPro Up. V0 applies a conservative 25% VLA prior with tight caps. */
  lieUpDownDeg?: number | null
  /** Positive = GSPro Left / ball above feet. V0 applies the existing conservative sidehill prior. */
  lieLeftRightDeg?: number | null
  lieSource?: string
  /** Exact GSPro pin in the same hole-local coordinate system as the course geometry. */
  exactPinLocalYds?: CoursePointYds | null
  /** Optional high-resolution course green grid used to shape destination rollout. */
  greenDetail?: CourseGreenDetail | null
  /**
   * Optional per-club strategic target. Used by off-sim natural-landing
   * diagnostics so Driver, 3W, hybrid, etc. can aim through the corridor at
   * their own natural carry rather than sharing an arbitrary fixed distance.
   * Default/live behavior remains unchanged when omitted.
   */
  clubTargets?: Readonly<Record<string, CoursePointYds | undefined>>
  /**
   * The pin. A club that can't reach the green (carry more than 25 yd short)
   * plans around its own spot, the fairway centre at its modeled carry toward
   * the pin, instead of the shared target (a min(220, 65%) lay-up spot far
   * out, the pin or a green spot within 260 yd).
   */
  layupPin?: CoursePointYds | null
  /** Evaluate only these clubs (parallel workers each take a share of the bag). */
  onlyClubs?: readonly string[]
}

export type { AimSurfaceDistribution } from './aimOutcomeSampling'

export type AimCandidateEvaluation = {
  aimOffsetYds: number
  aimPoint: CoursePointYds
  /** Resting/final expected center after historical rollout. */
  meanLanding: CoursePointYds
  /** Expected touchdown (carry) point on the aim line, before roll. */
  meanCarryLanding?: CoursePointYds
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
  /** Carry + mean roll of the best aim's outcomes after surface and slope (what the shot is expected to total). */
  expectedTotalYds?: number | null
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
  /**
   * What the ranking saw for this club, kept so Arm can record the engine's
   * numbers for the pick and the alternatives (caddie vs you).
   */
  decisionValue?: ClubDecisionValue | null
  /** Set while the club's numbers still lean on the Quick Bag prior. */
  startingBag?: StartingBagMark | null
  notes: string[]
}

export type ClubDecisionValue = {
  expectedFutureStrokes: number | null
  confidenceAdjustedStrokes: number | null
  catastropheProbability: number | null
  modelConfidence: number
  evDeltaToRawBest: number | null
  decisionStrength: string
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

type ModelClubCarryInput = Readonly<{
  profile: ReturnType<typeof buildLiveCaddieProfileSet>['clubs'][number]
  support: ReturnType<typeof buildLiveCaddieProfileSet>['club_support'][number] | undefined
  environment: AimLabEnvironment
  target: CoursePointYds
  ball: CoursePointYds
  hole: CourseHoleGeometry
  ballSurface: string
}>

/** One club's modeled carry for this shot (physics + altitude), shared by the
 * full evaluation and by the cheap all-club carry check used when clubs are
 * evaluated in parallel workers. */
/** Fairway centre at this carry toward the pin (never past the pin). */
/**
 * Where a club that can't reach the green should plan to land: on the circle
 * of its carry around the ball (the distance it actually flies), on fairway,
 * turned toward the pin as far as the fairway allows (spec:
 * claude/spec-long-shot-engine.md, piece 1). The old rule took the fairway
 * slice at a hole-local forward distance, which on a dogleg is not where the
 * club lands (RNK 2).
 *
 * Bearings out to ±60° from the pin line in 3° steps. Each spot scores its
 * remaining distance to the pin, plus 15 for each side (±8 yd across) that
 * isn't fairway (keeps it off the edge), plus 60 when anything within 10 yd is
 * water, penalty or woods. Fairway/tee spots first; rough if there are none;
 * the old corridor answer if neither.
 */
export const clubLayupTarget = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  pin: CoursePointYds,
  carryYds: number,
): CoursePointYds | null => {
  const dx = pin[0] - ball[0]
  const dy = pin[1] - ball[1]
  const distance = Math.hypot(dx, dy)
  if (!(distance > 0) || !(carryYds > 0)) return null
  const depth = Math.min(carryYds, distance)
  const pinBearing = Math.atan2(dx, dy)
  const at = (bearing: number, radius: number): CoursePointYds =>
    [ball[0] + Math.sin(bearing) * radius, ball[1] + Math.cos(bearing) * radius]
  const kindAt = (p: CoursePointYds) => classifyPoint(hole, p).kind
  const hazardous = (p: CoursePointYds) => {
    const kind = classifyTacticalLandingPoint(hole, p).kind
    return kind === 'water' || kind === 'penalty' || kind === 'deep-rough'
  }
  type Spot = { point: CoursePointYds; score: number }
  const fairwaySpots: Spot[] = []
  const roughSpots: Spot[] = []
  for (let deg = -LAYUP_SEARCH_DEG; deg <= LAYUP_SEARCH_DEG; deg += LAYUP_STEP_DEG) {
    const bearing = pinBearing + (deg * Math.PI) / 180
    const point = at(bearing, depth)
    const kind = kindAt(point)
    const onFairway = kind === 'fairway' || kind === 'tee'
    if (!onFairway && kind !== 'rough') continue
    const across = LAYUP_SIDE_YDS / depth
    const sides = [at(bearing - across, depth), at(bearing + across, depth)]
    const offSides = sides.filter((p) => {
      const k = kindAt(p)
      return k !== 'fairway' && k !== 'tee'
    }).length
    const clearance = [
      at(bearing, depth - LAYUP_CLEARANCE_YDS), at(bearing, depth + LAYUP_CLEARANCE_YDS),
      at(bearing - LAYUP_CLEARANCE_YDS / depth, depth), at(bearing + LAYUP_CLEARANCE_YDS / depth, depth),
    ]
    const score = Math.hypot(pin[0] - point[0], pin[1] - point[1])
      + LAYUP_EDGE_PENALTY * offSides
      + (clearance.some(hazardous) ? LAYUP_HAZARD_PENALTY : 0)
    ;(onFairway ? fairwaySpots : roughSpots).push({ point, score })
  }
  const best = (spots: Spot[]) => spots.reduce<Spot | null>((b, s) => (!b || s.score < b.score ? s : b), null)
  const pick = best(fairwaySpots) ?? best(roughSpots)
  if (pick) return pick.point
  const raw: CoursePointYds = [ball[0] + (dx / distance) * depth, ball[1] + (dy / distance) * depth]
  const corridor = fairwayCorridorAtForwardY(hole, raw[1], raw[0])
  return corridor ? [corridor.centerRightYds, raw[1]] : raw
}

const LAYUP_SEARCH_DEG = 60
const LAYUP_STEP_DEG = 3
const LAYUP_SIDE_YDS = 8
const LAYUP_CLEARANCE_YDS = 10
const LAYUP_EDGE_PENALTY = 15
const LAYUP_HAZARD_PENALTY = 60

/** Carry this far short of the pin still counts as going for the green. */
const LAYUP_REACH_SHORT_YDS = 25

const modelClubCarry = (input: ModelClubCarryInput) => {
  const { profile, environment, target, ball, hole } = input
  const fixed = environment.clubTargets?.[profile.club]
  const shared = modelClubCarryAt(input, fixed ?? target)
  if (fixed || !environment.layupPin) return shared
  // A club that can reach the green keeps the shared target (pin / green spot).
  // One that can't plays to the fairway at its own carry, even inside 260 yd:
  // otherwise a 7i from 247 out aimed at the pin through the trees and never
  // looked at the fairway slot short of the green (RNK 2, shot 2).
  const pinDistance = Math.hypot(environment.layupPin[0] - ball[0], environment.layupPin[1] - ball[1])
  if (shared.modeledCarryYds >= pinDistance - LAYUP_REACH_SHORT_YDS) return shared
  // Second pass at the club's own lay-up spot (carry barely depends on it).
  const own = clubLayupTarget(hole, ball, environment.layupPin, shared.modeledCarryYds)
  return own ? modelClubCarryAt(input, own) : shared
}

const modelClubCarryAt = (
  { profile, support, environment, ball, hole, ballSurface }: ModelClubCarryInput,
  planningTarget: CoursePointYds,
) => {
  const decisionGoal = inferDecisionShotGoal(hole, planningTarget)
  const targetDistanceYds = Math.hypot(
    planningTarget[0] - ball[0],
    planningTarget[1] - ball[1],
  )
  const aimOffsetsYds = buildAimOffsetsYds(profile.lateral_sigma_yds)
  const launch = profile.launch_profile
  const hasLieMeasurement =
    (typeof environment.lieUpDownDeg === 'number' && Number.isFinite(environment.lieUpDownDeg)) ||
    (typeof environment.lieLeftRightDeg === 'number' && Number.isFinite(environment.lieLeftRightDeg))
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
      lieUpDownDeg: environment.lieUpDownDeg ?? null,
      lieLeftRightDeg: environment.lieLeftRightDeg ?? null,
      lieSource: environment.lieSource ?? 'GSPro lie OCR',
      lieConfidence: hasLieMeasurement ? 'high' : 'unknown',
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
  return {
    planningTarget, decisionGoal, targetDistanceYds, aimOffsetsYds, launch,
    hasLieMeasurement, modeled, altitudeAdjustment, baseModeledCarryYds, modeledCarryYds,
  }
}

/**
 * Shortest modeled carry among all eligible clubs with support, exactly as
 * evaluateAimLab would compute it, without the 2,048-sample aim search. Lets a
 * worker that evaluates only part of the bag make the bag-wide short-game check.
 */
export const shortestSupportedModeledCarryYds = (
  sessions: SavedSession[],
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  target: CoursePointYds,
  environment: AimLabEnvironment,
  nowMs: number,
): number => {
  const profileSet = applyQuickBagToProfileSet(buildLiveCaddieProfileSet(sessions, nowMs), environment.quickBag)
  const ballSurface = environment.surfaceOverride?.trim() || classifyPoint(hole, ball).kind
  const shotOrigin = resolveShotOriginEligibility(environment.shotOrigin, ballSurface)
  let shortest = Number.POSITIVE_INFINITY
  for (const profile of profileSet.clubs) {
    if (!clubEligibleForShot(profile.club, shotOrigin)) continue
    const support = profileSet.club_support.find((item) => item.club === profile.club)
    if (!((support?.included_stock_shots ?? 0) > 0)) continue
    const { modeledCarryYds } = modelClubCarry({ profile, support, environment, target, ball, hole, ballSurface })
    if (Number.isFinite(modeledCarryYds)) shortest = Math.min(shortest, modeledCarryYds)
  }
  return shortest
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
  const profileSet = applyQuickBagToProfileSet(buildLiveCaddieProfileSet(sessions, nowMs), environment.quickBag)
  const decisionPlayers = applyQuickBagToPlayers(
    buildDecisionPlayerModels(sessions, nowMs), profileSet, environment.quickBag, nowMs,
  )
  const geometrySurface = classifyPoint(hole, ball).kind
  const ballSurface = environment.surfaceOverride?.trim() || geometrySurface
  const shotOrigin = resolveShotOriginEligibility(environment.shotOrigin, ballSurface)
  const exactPinLocalYds = environment.exactPinLocalYds ?? hole.markers.pin ?? null
  const greenRollout = environment.greenDetail
    ? (carryLanding: CoursePointYds, baselineLanding: CoursePointYds) =>
        redirectCourseGreenRollout({
          hole,
          detail: environment.greenDetail!,
          carryLanding,
          baselineLanding,
        }).landing
    : undefined
  // Where each ball comes down (descent vs LiDAR terrain, per club), roll
  // scaled by surface and slope there, then the green rollout.
  const ballElevationFt = estimateCourseTerrain(hole, ball)?.elevationFt ?? null

  // Hard exclusion BEFORE club physics, aim exploration, cache and ranking.
  // Never let the expected-value ranker select a non-tee Driver or Mini Driver.
  const eligibleProfiles = profileSet.clubs.filter(profile =>
    clubEligibleForShot(profile.club, shotOrigin)
      && (!environment.onlyClubs || environment.onlyClubs.includes(profile.club)),
  )
  const evaluations = eligibleProfiles.map((profile): ClubAimEvaluation => {
    const support = profileSet.club_support.find((item) => item.club === profile.club)
    const decisionPlayer = decisionPlayers.find((item) => item.club === profile.club) ?? null
    const {
      planningTarget, decisionGoal, targetDistanceYds, aimOffsetsYds,
      modeled, altitudeAdjustment, modeledCarryYds,
    } = modelClubCarry({ profile, support, environment, target, ball, hole, ballSurface })
    const stockTotalYds =
      typeof profile.stock_total_yds === 'number' && Number.isFinite(profile.stock_total_yds)
        ? Math.max(profile.stock_carry_yds, profile.stock_total_yds)
        : profile.stock_carry_yds
    const rolloutYds = Math.max(0, stockTotalYds - profile.stock_carry_yds)
    const descentDeg = profile.launch_profile?.descent_angle_deg
    const greenLandingTransform = makeRollLandingTransform(hole, greenRollout,
      ballElevationFt != null && typeof descentDeg === 'number' && Number.isFinite(descentDeg)
        ? { ball, descentDeg, refElevationFt: ballElevationFt + (environment.elevationDeltaFt ?? 0) }
        : null)
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
      notes.push(`Final-position outcomes start from ${rolloutYds.toFixed(1)} yd of observed Stock rollout, scaled by the surface and slope where each ball lands.`)
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
        pinLocalYds: exactPinLocalYds,
        landingTransform: greenLandingTransform,
        flightCheck: { descentDeg: typeof descentDeg === 'number' && Number.isFinite(descentDeg) ? descentDeg : null },
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
        pinLocalYds: exactPinLocalYds,
        landingTransform: greenLandingTransform,
        flightCheck: { descentDeg: typeof descentDeg === 'number' && Number.isFinite(descentDeg) ? descentDeg : null },
      })
      const scored = scoreCandidate(sampled.distribution, carryGapYds)
      return {
        aimOffsetYds,
        aimPoint,
        meanLanding: sampled.meanLanding,
        meanCarryLanding: sampled.meanCarryLanding,
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
    // Total: where flown balls come to rest (balls stopped by trees are outcomes,
    // not distance: they'd pull the number toward the tee).
    const bestSamples = (bestCandidate?.modeledSamples ?? []).filter((sample) => !sample.flightTag)
    // Where the ball comes to rest, measured from the ball (a ball that comes
    // down short into a hill rolls less AND carries less).
    const expectedTotalYds = bestSamples.length && bestCandidate
      ? (() => {
          const fx = bestCandidate.aimPoint[0] - ball[0], fy = bestCandidate.aimPoint[1] - ball[1]
          const fl = Math.hypot(fx, fy) || 1
          return bestSamples.reduce((sum, sample) =>
            sum + ((sample.landing[0] - ball[0]) * fx + (sample.landing[1] - ball[1]) * fy) / fl, 0) / bestSamples.length
        })()
      : null

    if (!bestCandidate) notes.push('No usable carry/lateral dispersion model for this club.')

    return {
      club: profile.club,
      variant: 'Stock',
      stockCarryYds: profile.stock_carry_yds,
      stockTotalYds,
      modeledCarryYds,
      modeledTotalYds,
      expectedTotalYds,
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
      startingBag: profileSet.starting_bag[profile.club] ?? null,
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
    ranked.evaluation.decisionValue = {
      expectedFutureStrokes: ranked.expectedFutureStrokes,
      confidenceAdjustedStrokes: ranked.confidenceAdjustedStrokes,
      catastropheProbability: ranked.catastropheProbability,
      modelConfidence: ranked.modelConfidence,
      evDeltaToRawBest: ranked.evDeltaToRawBest,
      decisionStrength: ranked.decisionStrength,
    }
  })

  return rankedClubs.map((ranked) => ranked.evaluation)
}
