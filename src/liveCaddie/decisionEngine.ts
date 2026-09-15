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
  type MishitPlanningState,
} from '../lib/mishitPlanningPopulation'
import {
  resolveShotVariantId,
  STOCK_SHOT_VARIANT_ID,
} from '../lib/shotVariants'
import type { SavedSession, Shot } from '../types'
import { classifyPoint } from '../courseGeometry/geometry'
import { TACTICAL_SURFACE_SEMANTICS } from '../courseGeometry/semantics'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import { buildLiveCaddieProfileSet } from './profileProvider'

export type DecisionShotQuality =
  | 'normal'
  | 'mishit'
  | 'severe_mishit'
  | 'unclassified'

export type DecisionOutcomeTier = 'success' | 'manageable' | 'disaster' | 'unknown'

export type DecisionShotGoal = 'green' | 'fairway' | 'layup'

export type DecisionPlayerSample = {
  shotId: string
  capturedAt: string
  carryYds: number
  offlineYds: number
  weight: number
  quality: DecisionShotQuality
  planningEligible: boolean
  classificationConfidence: number | null
  clubPathDeg?: number
  angleOfAttackDeg?: number
}

export type DecisionPlayerClubModel = {
  club: string
  variantId: string
  variantLabel: string
  stockCarryYds: number
  carrySigmaYds: number | null
  lateralBiasYds: number
  lateralSigmaYds: number | null
  supportShots: number
  supportingSessions: number
  samples: DecisionPlayerSample[]
  representativeLaunch: {
    ballSpeedMph: number | null
    vlaDeg: number | null
    hlaDeg: number | null
    totalSpinRpm: number | null
    spinAxisDeg: number | null
    peakHeightYds: number | null
    descentAngleDeg: number | null
  }
  representativeClub: {
    clubPathDeg: number | null
    angleOfAttackDeg: number | null
  }
}

export type DecisionCourseModel = {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  goal: DecisionShotGoal
}

/**
 * The decision evaluator intentionally consumes already-modeled condition deltas.
 * Raw wind/elevation/lie physics stays upstream in shotContextModel so the base
 * player x geometry evaluator remains deterministic and independently testable.
 */
export type DecisionLiveTransform = {
  carryDeltaYds: number
  lateralDeltaYds: number
  source: 'neutral' | 'shot-context-model' | 'other'
  notes?: readonly string[]
}

export type DecisionCandidate = {
  id: string
  aimPoint: CoursePointYds
  aimOffsetYds?: number
}

export type DecisionSurfaceDistribution = {
  bySurface: Partial<Record<CourseSurfaceClassification, number>>
  success: number
  manageable: number
  disaster: number
  unknown: number
  expectedSeverity: number
}

export type DecisionQualityDistribution = {
  normal: number
  mishit: number
  severe_mishit: number
  unclassified: number
}

export type DecisionEvaluationSlice = {
  sampleCount: number
  sampleWeight: number
  surface: DecisionSurfaceDistribution
  quality: DecisionQualityDistribution
  averageProximityYds: number | null
  meanLanding: CoursePointYds | null
  disasterFromMishits: number
  disasterFromSevereMishits: number
}

export type DecisionCandidateEvaluation = {
  candidate: DecisionCandidate
  targetDistanceYds: number
  allShots: DecisionEvaluationSlice | null
  planningCore: DecisionEvaluationSlice | null
  mishitTail: DecisionEvaluationSlice | null
  notes: string[]
}

export type DecisionRankPolicy = {
  /**
   * Candidates within this absolute disaster-probability margin of the safest
   * option are allowed to compete on success. This avoids optimizing for 0.0%
   * disaster at the cost of a materially worse golf shot while still making
   * catastrophe the first gate.
   */
  disasterToleranceAboveBest: number
}

export type RankedDecisionCandidate = DecisionCandidateEvaluation & {
  rank: number
  withinDisasterGuardrail: boolean
  decisionReason: string
}

export const DEFAULT_DECISION_RANK_POLICY: DecisionRankPolicy = {
  disasterToleranceAboveBest: 0.02,
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const weightedMean = (values: Array<{ value: number; weight: number }>) => {
  const totalWeight = values.reduce((sum, item) => sum + item.weight, 0)
  if (totalWeight <= 0) return null
  return values.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight
}

const shotClubPathDeg = (shot: Shot) => {
  const candidates = [
    shot.clubPathDegrees,
    shot.clubPathDeg,
    shot.clubPath,
    shot.club_path_degrees,
    shot.club_path_deg,
    shot.club_path,
  ]
  return candidates.find(finite)
}

const shotAngleOfAttackDeg = (shot: Shot) => finite(shot.clubAoa) ? shot.clubAoa : undefined

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

const weightedRawStockShots = (
  sessions: SavedSession[],
  club: string,
  nowMs: number,
) => {
  const weighted: Array<{ shot: Shot; weight: number }> = []

  sessions.forEach((session) => {
    if (
      session.metadata?.includeInAnalysis === false ||
      isSystemOldExcludedSession(session, nowMs)
    ) return

    const shots = session.shots.filter(
      (shot) =>
        String(shot.club) === club &&
        isShotSourceIncluded(shot) &&
        resolveShotVariantId(shot.shotVariantId) === STOCK_SHOT_VARIANT_ID &&
        finite(shot.carryYards) &&
        finite(shot.offlineYards),
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

const qualityForShot = (
  shotId: string,
  state: MishitPlanningState,
): Pick<DecisionPlayerSample, 'quality' | 'planningEligible' | 'classificationConfidence'> => {
  const classification = state.classificationByShotId.get(shotId)
  if (!classification) {
    return {
      quality: 'unclassified',
      planningEligible: true,
      classificationConfidence: null,
    }
  }

  return {
    quality: classification.classification,
    planningEligible: classification.planningEligible,
    classificationConfidence: finite(classification.confidence)
      ? classification.confidence
      : null,
  }
}

/**
 * Build the decision engine's player contract.
 *
 * The normal Stock profile remains the stable center/dispersion representation
 * used elsewhere in Looper. The empirical sample population is deliberately
 * SOURCE-included rather than planning-included, so classified mishits are
 * retained at their observed, time-weighted frequency for outcome decisions.
 */
export const buildDecisionPlayerModels = (
  sessions: SavedSession[],
  nowMs = Date.now(),
): DecisionPlayerClubModel[] => {
  const mishitState = installMishitPlanningState(sessions)
  const profileSet = buildLiveCaddieProfileSet(sessions, nowMs)

  return profileSet.clubs.map((profile) => {
    const support = profileSet.club_support.find((item) => item.club === profile.club)
    const weightedShots = weightedRawStockShots(sessions, profile.club, nowMs)
    const samples = weightedShots.map(({ shot, weight }): DecisionPlayerSample => ({
      shotId: shot.id,
      capturedAt: shot.capturedAt,
      carryYds: shot.carryYards!,
      offlineYds: shot.offlineYards!,
      weight,
      ...qualityForShot(shot.id, mishitState),
      clubPathDeg: shotClubPathDeg(shot),
      angleOfAttackDeg: shotAngleOfAttackDeg(shot),
    }))

    const planningClubPath = weightedMean(
      samples
        .filter((sample) => sample.planningEligible && finite(sample.clubPathDeg))
        .map((sample) => ({ value: sample.clubPathDeg!, weight: sample.weight })),
    )
    const planningAoa = weightedMean(
      samples
        .filter((sample) => sample.planningEligible && finite(sample.angleOfAttackDeg))
        .map((sample) => ({ value: sample.angleOfAttackDeg!, weight: sample.weight })),
    )

    return {
      club: profile.club,
      variantId: STOCK_SHOT_VARIANT_ID,
      variantLabel: 'Stock',
      stockCarryYds: profile.stock_carry_yds,
      carrySigmaYds: profile.carry_sigma_yds ?? null,
      lateralBiasYds: profile.lateral_bias_yds ?? 0,
      lateralSigmaYds: profile.lateral_sigma_yds ?? null,
      supportShots: support?.included_stock_shots ?? 0,
      supportingSessions: support?.sessions ?? 0,
      samples,
      representativeLaunch: {
        ballSpeedMph: profile.launch_profile?.ball_speed_mph ?? null,
        vlaDeg: profile.launch_profile?.vla_deg ?? null,
        hlaDeg: profile.launch_profile?.hla_deg ?? null,
        totalSpinRpm: profile.launch_profile?.total_spin_rpm ?? null,
        spinAxisDeg: profile.launch_profile?.spin_axis_deg ?? null,
        peakHeightYds: profile.launch_profile?.peak_height_yds ?? null,
        descentAngleDeg: profile.launch_profile?.descent_angle_deg ?? null,
      },
      representativeClub: {
        clubPathDeg: planningClubPath,
        angleOfAttackDeg: planningAoa,
      },
    }
  })
}

export const inferDecisionShotGoal = (
  hole: CourseHoleGeometry,
  target: CoursePointYds,
): DecisionShotGoal => {
  const targetSurface = classifyPoint(hole, target).kind
  return targetSurface === 'green' ? 'green' : 'fairway'
}

export const outcomeTierForSurface = (
  kind: CourseSurfaceClassification,
  goal: DecisionShotGoal,
): DecisionOutcomeTier => {
  if (kind === 'unknown') return 'unknown'
  if (kind === 'water' || kind === 'penalty' || kind === 'deep-rough') return 'disaster'

  if (goal === 'green') {
    if (kind === 'green') return 'success'
    return 'manageable'
  }

  if (kind === 'fairway') return 'success'
  return 'manageable'
}

type WeightedLanding = {
  sample: DecisionPlayerSample
  weight: number
  landing: CoursePointYds
  surface: CourseSurfaceClassification
  tier: DecisionOutcomeTier
  proximityYds: number
}

const evaluateSlice = (landings: WeightedLanding[]): DecisionEvaluationSlice | null => {
  if (landings.length === 0) return null
  const sampleWeight = landings.reduce((sum, item) => sum + item.weight, 0)
  if (sampleWeight <= 0) return null

  const bySurface: Partial<Record<CourseSurfaceClassification, number>> = {}
  const qualityWeight: Record<DecisionShotQuality, number> = {
    normal: 0,
    mishit: 0,
    severe_mishit: 0,
    unclassified: 0,
  }
  let success = 0
  let manageable = 0
  let disaster = 0
  let unknown = 0
  let severity = 0
  let proximity = 0
  let meanRight = 0
  let meanForward = 0
  let disasterFromMishits = 0
  let disasterFromSevereMishits = 0

  landings.forEach((item) => {
    const fraction = item.weight / sampleWeight
    bySurface[item.surface] = (bySurface[item.surface] ?? 0) + fraction
    qualityWeight[item.sample.quality] += fraction
    proximity += item.proximityYds * fraction
    meanRight += item.landing[0] * fraction
    meanForward += item.landing[1] * fraction
    severity += TACTICAL_SURFACE_SEMANTICS[item.surface].severity * fraction

    if (item.tier === 'success') success += fraction
    else if (item.tier === 'manageable') manageable += fraction
    else if (item.tier === 'disaster') {
      disaster += fraction
      if (item.sample.quality === 'mishit' || item.sample.quality === 'severe_mishit') {
        disasterFromMishits += fraction
      }
      if (item.sample.quality === 'severe_mishit') {
        disasterFromSevereMishits += fraction
      }
    } else unknown += fraction
  })

  return {
    sampleCount: landings.length,
    sampleWeight,
    surface: {
      bySurface,
      success,
      manageable,
      disaster,
      unknown,
      expectedSeverity: severity,
    },
    quality: qualityWeight,
    averageProximityYds: proximity,
    meanLanding: [meanRight, meanForward],
    disasterFromMishits,
    disasterFromSevereMishits,
  }
}

export const evaluateDecisionCandidate = (
  player: DecisionPlayerClubModel,
  course: DecisionCourseModel,
  candidate: DecisionCandidate,
  live: DecisionLiveTransform = {
    carryDeltaYds: 0,
    lateralDeltaYds: 0,
    source: 'neutral',
  },
): DecisionCandidateEvaluation => {
  const forward = unit(vector(course.ball, candidate.aimPoint))
  const right = rightOf(forward)
  const landings: WeightedLanding[] = player.samples.map((sample) => {
    const carry = Math.max(0, sample.carryYds + live.carryDeltaYds)
    const offline = sample.offlineYds + live.lateralDeltaYds
    const landing = addScaled(course.ball, forward, carry, right, offline)
    const surface = classifyPoint(course.hole, landing).kind
    const tier = outcomeTierForSurface(surface, course.goal)
    return {
      sample,
      weight: sample.weight,
      landing,
      surface,
      tier,
      proximityYds: Math.hypot(
        landing[0] - course.target[0],
        landing[1] - course.target[1],
      ),
    }
  })

  const allShots = evaluateSlice(landings)
  const planningCore = evaluateSlice(
    landings.filter((item) => item.sample.planningEligible),
  )
  const mishitTail = evaluateSlice(
    landings.filter((item) => !item.sample.planningEligible),
  )
  const notes: string[] = []

  if (player.samples.length < 5) notes.push('Thin empirical support (<5 usable Stock shots).')
  if (!mishitTail) notes.push('No classified mishit tail is available yet; all-shot risk may be under-resolved.')
  if (allShots && allShots.surface.unknown > 0.05) {
    notes.push('More than 5% of weighted outcomes land on unmapped geometry.')
  }

  return {
    candidate,
    targetDistanceYds: Math.hypot(
      course.target[0] - course.ball[0],
      course.target[1] - course.ball[1],
    ),
    allShots,
    planningCore,
    mishitTail,
    notes,
  }
}

const compareWithinSafeSet = (
  a: DecisionCandidateEvaluation,
  b: DecisionCandidateEvaluation,
) => {
  const aSurface = a.allShots!.surface
  const bSurface = b.allShots!.surface

  if (Math.abs(aSurface.success - bSurface.success) > 1e-9) {
    return bSurface.success - aSurface.success
  }
  if (Math.abs(aSurface.unknown - bSurface.unknown) > 1e-9) {
    return aSurface.unknown - bSurface.unknown
  }
  if (Math.abs(aSurface.expectedSeverity - bSurface.expectedSeverity) > 1e-9) {
    return aSurface.expectedSeverity - bSurface.expectedSeverity
  }

  return (a.allShots!.averageProximityYds ?? Number.POSITIVE_INFINITY) -
    (b.allShots!.averageProximityYds ?? Number.POSITIVE_INFINITY)
}

/**
 * Catastrophe-aware deterministic ranking.
 *
 * 1) Find the safest observed candidate by all-shot disaster probability.
 * 2) Admit only candidates within a small absolute disaster guardrail.
 * 3) Inside that safe set, maximize success; then minimize unknown geometry,
 *    expected tactical severity, and finally average proximity.
 *
 * This deliberately avoids an opaque single weighted score where a proximity
 * gain can silently buy a materially larger catastrophic tail.
 */
export const rankDecisionCandidates = (
  evaluations: DecisionCandidateEvaluation[],
  policy: DecisionRankPolicy = DEFAULT_DECISION_RANK_POLICY,
): RankedDecisionCandidate[] => {
  const usable = evaluations.filter(
    (evaluation): evaluation is DecisionCandidateEvaluation & { allShots: DecisionEvaluationSlice } =>
      evaluation.allShots != null,
  )
  if (usable.length === 0) return []

  const minDisaster = Math.min(...usable.map((item) => item.allShots.surface.disaster))
  const guardrail = minDisaster + policy.disasterToleranceAboveBest
  const safe = usable
    .filter((item) => item.allShots.surface.disaster <= guardrail + 1e-9)
    .sort(compareWithinSafeSet)
  const outside = usable
    .filter((item) => item.allShots.surface.disaster > guardrail + 1e-9)
    .sort((a, b) => {
      const disasterDelta = a.allShots.surface.disaster - b.allShots.surface.disaster
      return Math.abs(disasterDelta) > 1e-9 ? disasterDelta : compareWithinSafeSet(a, b)
    })

  return [...safe, ...outside].map((item, index) => ({
    ...item,
    rank: index + 1,
    withinDisasterGuardrail: item.allShots.surface.disaster <= guardrail + 1e-9,
    decisionReason: index === 0
      ? `Within ${(policy.disasterToleranceAboveBest * 100).toFixed(0)} pts of the safest disaster rate; best success profile inside that guardrail.`
      : item.allShots.surface.disaster > guardrail + 1e-9
        ? 'Rejected by the catastrophe guardrail before success/proximity comparison.'
        : 'Safe-set alternative with a weaker success/severity/proximity profile.',
  }))
}

export const evaluateAndRankDecisionCandidates = (
  player: DecisionPlayerClubModel,
  course: DecisionCourseModel,
  candidates: DecisionCandidate[],
  live?: DecisionLiveTransform,
  policy?: DecisionRankPolicy,
) => rankDecisionCandidates(
  candidates.map((candidate) => evaluateDecisionCandidate(player, course, candidate, live)),
  policy,
)

export const decisionModelForClub = (
  models: DecisionPlayerClubModel[],
  club: Club | string,
) => models.find((model) => model.club === String(club)) ?? null
