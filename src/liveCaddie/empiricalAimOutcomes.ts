import { classifyTacticalLandingPoint } from '../courseGeometry/tacticalClassification'
import { TACTICAL_SURFACE_SEMANTICS } from '../courseGeometry/semantics'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import {
  isShotSourceIncluded,
  isSystemOldExcludedSession,
  sessionAgeInDays,
  sizeWeightForShotCount,
  timeWeightForAgeDays,
} from '../lib/historicalModel'
import {
  resolveShotVariantId,
  STOCK_SHOT_VARIANT_ID,
} from '../lib/shotVariants'
import type { SavedSession, Shot } from '../types'
import type { AimSurfaceDistribution } from './aimOutcomeSampling'

export type EmpiricalAimLandingSample = {
  carryLanding: CoursePointYds
  /** Resting/final position; falls back to carry when historical total is unavailable. */
  landing: CoursePointYds
  kind: CourseSurfaceClassification
  /** Normalized historical weight. All sample weights sum to 1. */
  weight: number
}

export type EmpiricalAimSurfaceDistribution = AimSurfaceDistribution & {
  samples: EmpiricalAimLandingSample[]
}

export type WeightedEmpiricalStockShot = {
  shot: Shot
  weight: number
}

export const buildWeightedEmpiricalStockShots = (
  sessions: SavedSession[],
  club: string,
  nowMs: number,
): WeightedEmpiricalStockShot[] => {
  const weighted: WeightedEmpiricalStockShot[] = []

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

export const evaluateEmpiricalAimDistribution = (
  hole: CourseHoleGeometry,
  weightedShots: WeightedEmpiricalStockShot[],
  ball: CoursePointYds,
  aimPoint: CoursePointYds,
  carryAdjustmentYds = 0,
  lateralAdjustmentYds = 0,
): EmpiricalAimSurfaceDistribution | null => {
  if (weightedShots.length === 0) return null

  const forward = unit(vector(ball, aimPoint))
  const right = rightOf(forward)
  const weights: Partial<Record<CourseSurfaceClassification, number>> = {}
  const rawSamples: Array<Omit<EmpiricalAimLandingSample, 'weight'> & { rawWeight: number }> = []
  let totalWeight = 0

  weightedShots.forEach(({ shot, weight }) => {
    if (
      typeof shot.carryYards !== 'number' ||
      !Number.isFinite(shot.carryYards) ||
      typeof shot.offlineYards !== 'number' ||
      !Number.isFinite(shot.offlineYards)
    ) {
      return
    }

    // Preserve the observed all-shot shape, including mishits. Live wind/elevation
    // translates the airborne distance; historical carry-to-total rollout remains
    // attached to the shot until destination-surface rollout physics are validated.
    const carry = Math.max(0, shot.carryYards + carryAdjustmentYds)
    const observedTotal =
      typeof shot.totalYards === 'number' && Number.isFinite(shot.totalYards)
        ? Math.max(shot.carryYards, shot.totalYards)
        : shot.carryYards
    const total = Math.max(carry, observedTotal + carryAdjustmentYds)
    const offline = shot.offlineYards + lateralAdjustmentYds
    const carryLanding = addScaled(ball, forward, carry, right, offline)
    const landing = addScaled(ball, forward, total, right, offline)
    const kind = classifyTacticalLandingPoint(hole, landing).kind
    weights[kind] = (weights[kind] ?? 0) + weight
    rawSamples.push({ carryLanding, landing, kind, rawWeight: weight })
    totalWeight += weight
  })

  if (totalWeight <= 0) return null

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

  const samples = rawSamples.map(({ carryLanding, landing, kind, rawWeight }) => ({
    carryLanding,
    landing,
    kind,
    weight: rawWeight / totalWeight,
  }))

  return { bySurface, preferred, rough, trouble, penalty, unknown, samples }
}