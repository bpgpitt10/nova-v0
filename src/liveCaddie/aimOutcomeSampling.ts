import { tacticalKindNear } from '../courseGeometry/tacticalClassification'
import { TACTICAL_SURFACE_SEMANTICS } from '../courseGeometry/semantics'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import { penaltyReliefPoint, resolveCarryAwareLanding } from './carryAwareLanding'
import {
  buildDecisionLandingState,
  type DecisionLandingState,
} from './decisionLandingState'

export const MODELED_AIM_SAMPLE_COUNT = 2048

export type AimSurfaceDistribution = {
  bySurface: Partial<Record<CourseSurfaceClassification, number>>
  preferred: number
  rough: number
  trouble: number
  penalty: number
  unknown: number
}

export type ModeledAimSample = {
  /** Airborne touchdown point. */
  carryLanding: CoursePointYds
  /**
   * Where the ball finishes: the rest point after rollout (scaled by surface and
   * slope when a roll model is applied), unless it touched down in, or rolled
   * into, water / penalty / bunker (carryAwareLanding).
   */
  landing: CoursePointYds
  /** Rest point if no hazard stopped the rollout. */
  unobstructedLanding?: CoursePointYds
  /** The player's stock rollout for this sample, before any surface/slope scaling. */
  stockRollYds?: number
  /** The flight ran into trees: right after launch, or on the way down. The landing is where it hit. */
  flightTag?: 'trees-early' | 'trees-late'
  kind: CourseSurfaceClassification
  /** Exact geometric state retained for later SG/value evaluation. */
  state: DecisionLandingState
}

/** Where the ball first meets the ground, and where it comes to rest. */
export type LandingResolution = Readonly<{ touchdown: CoursePointYds; rest: CoursePointYds }>

export type LandingTransform = ((
  carryLanding: CoursePointYds,
  baselineLanding: CoursePointYds,
) => CoursePointYds) & {
  /**
   * Touchdown and rest together. The roll model's touchdown can be short of the
   * carry point (a ball flying into the face of a hill), and hazard capture has
   * to start from where the ball really comes down.
   */
  resolve?: (carryLanding: CoursePointYds, baselineLanding: CoursePointYds) => LandingResolution
}

export const resolveLanding = (
  transform: LandingTransform | undefined,
  carryLanding: CoursePointYds,
  baselineLanding: CoursePointYds,
): LandingResolution => {
  if (!transform) return { touchdown: carryLanding, rest: baselineLanding }
  if (transform.resolve) return transform.resolve(carryLanding, baselineLanding)
  return { touchdown: carryLanding, rest: transform(carryLanding, baselineLanding) }
}

export type AimProbabilityContour = {
  probability: 0.5 | 0.8 | 0.95
  carryRadiusYds: number
  lateralRadiusYds: number
}

type StandardizedSample = {
  carryZ: number
  lateralZ: number
  radius: number
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

const halton = (index: number, base: number) => {
  let result = 0
  let fraction = 1 / base
  let value = index
  while (value > 0) {
    result += fraction * (value % base)
    value = Math.floor(value / base)
    fraction /= base
  }
  return result
}

const buildStandardizedSamples = (): StandardizedSample[] => {
  const halfCount = MODELED_AIM_SAMPLE_COUNT / 2
  const samples: StandardizedSample[] = []

  for (let index = 1; index <= halfCount; index += 1) {
    // Deterministic low-discrepancy uniforms transformed through Box-Muller.
    // Mirroring every point makes the finite cloud exactly centered at zero.
    const u1 = Math.max(1e-12, halton(index, 2))
    const u2 = halton(index, 3)
    const radius = Math.sqrt(-2 * Math.log(u1))
    const theta = 2 * Math.PI * u2
    const carryZ = radius * Math.cos(theta)
    const lateralZ = radius * Math.sin(theta)
    const standardizedRadius = Math.hypot(carryZ, lateralZ)

    samples.push({ carryZ, lateralZ, radius: standardizedRadius })
    samples.push({ carryZ: -carryZ, lateralZ: -lateralZ, radius: standardizedRadius })
  }

  return samples
}

const STANDARDIZED_SAMPLES = buildStandardizedSamples()

/** The deterministic standard-normal pairs behind every modeled cloud (read-only). */
export const standardizedAimSamples = (): readonly StandardizedSample[] => STANDARDIZED_SAMPLES

/**
 * One simulated shot, already in live conditions: touchdown distance, rest
 * distance and offline (yards right of the aim line). Supplied when the core
 * is built from the player's own shots (empiricalShotCore) instead of the
 * bell curve around Stock.
 */
export type ShotDraw = {
  carryYds: number
  totalYds: number
  offlineYds: number
}
const SORTED_RADII = STANDARDIZED_SAMPLES.map((sample) => sample.radius).sort((a, b) => a - b)

const sampledQuantile = (probability: number) => {
  const index = Math.max(
    0,
    Math.min(SORTED_RADII.length - 1, Math.ceil(probability * SORTED_RADII.length) - 1),
  )
  return SORTED_RADII[index]
}

const CONTOUR_RADII = {
  0.5: sampledQuantile(0.5),
  0.8: sampledQuantile(0.8),
  0.95: sampledQuantile(0.95),
} as const

const summarizeSurfaceKinds = (
  samples: readonly ModeledAimSample[],
): AimSurfaceDistribution => {
  const counts: Partial<Record<CourseSurfaceClassification, number>> = {}
  samples.forEach((sample) => {
    counts[sample.kind] = (counts[sample.kind] ?? 0) + 1
  })

  const denominator = Math.max(1, samples.length)
  const bySurface: Partial<Record<CourseSurfaceClassification, number>> = {}
  Object.entries(counts).forEach(([kind, count]) => {
    bySurface[kind as CourseSurfaceClassification] = count / denominator
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

  return { bySurface, preferred, rough, trouble, penalty, unknown }
}

/**
 * Trees in the flight path (spec: claude/spec-long-shot-engine.md, piece 3).
 * Only the landing used to be classified, so a drive through the trees 25 yd
 * ahead, or one coming down through a tree line short of the fairway, counted
 * as landing clean.
 * - Launch: points 12, 24 and 36 yd along the flight. The ball is below tree
 *   height there for every club, so 2 of the 3 in woods = blocked (one woods
 *   point alone is usually an outline brushing the line).
 * - Descent: 8 and 16 yd before touchdown, where the ball is under 15 yd high
 *   (d × tan(descent) < 15): woods there = it came down through the trees.
 * Woods = what the tactical classifier calls deep rough (mapped woods/scrub);
 * mapped surfaces (tee, fairway, rough) are never woods.
 */
const LAUNCH_CHECK_YDS = [12, 24, 36] as const
const DESCENT_CHECK_YDS = [8, 16] as const
const TREE_HEIGHT_YDS = 15

export const flightBlockedAt = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  carryLanding: CoursePointYds,
  descentDeg: number | null,
): { point: CoursePointYds; tag: 'trees-early' | 'trees-late' } | null => {
  const dx = carryLanding[0] - ball[0]
  const dy = carryLanding[1] - ball[1]
  const carry = Math.hypot(dx, dy)
  if (carry < 50) return null
  const ux = dx / carry, uy = dy / carry
  const at = (d: number): CoursePointYds => [ball[0] + ux * d, ball[1] + uy * d]
  const woods = (p: CoursePointYds) => tacticalKindNear(hole, p) === 'deep-rough'
  const early = LAUNCH_CHECK_YDS.filter((d) => d < carry - 10).map((d) => ({ d, hit: woods(at(d)) }))
  if (early.filter((e) => e.hit).length >= 2) {
    return { point: at(early.find((e) => e.hit)!.d), tag: 'trees-early' }
  }
  if (typeof descentDeg === 'number' && descentDeg > 0) {
    const tan = Math.tan((descentDeg * Math.PI) / 180)
    for (const back of [...DESCENT_CHECK_YDS].reverse()) {
      if (back * tan >= TREE_HEIGHT_YDS || back > carry - 40) continue
      const p = at(carry - back)
      if (woods(p)) return { point: p, tag: 'trees-late' }
    }
  }
  return null
}

export const sampleModeledAimDistribution = ({
  hole,
  ball,
  aimPoint,
  carryMeanYds,
  totalMeanYds,
  lateralMeanYds,
  carrySigmaYds,
  totalSigmaYds,
  lateralSigmaYds,
  pinLocalYds,
  landingTransform,
  flightCheck,
  shotDraws,
}: {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  aimPoint: CoursePointYds
  carryMeanYds: number
  /** Resting-distance mean. Falls back to carry when total is unavailable. */
  totalMeanYds?: number | null
  lateralMeanYds: number
  carrySigmaYds: number | null | undefined
  /** Resting-distance variability. Falls back to carry sigma when unavailable. */
  totalSigmaYds?: number | null
  lateralSigmaYds: number | null | undefined
  /** Exact live pin when available; falls back to the imported geometry marker. */
  pinLocalYds?: CoursePointYds | null
  /** Optional destination-terrain transform applied after baseline rollout. */
  landingTransform?: LandingTransform
  /** Check the flight against woods right after launch and on the way down (spec piece 3). */
  flightCheck?: Readonly<{ descentDeg: number | null }> | null
  /**
   * The player's own shot shape (empiricalShotCore). When present these draws
   * replace the bell curve; carry/lateral sigmas still size the map's rings.
   */
  shotDraws?: readonly ShotDraw[] | null
}): {
  distribution: AimSurfaceDistribution
  meanCarryLanding: CoursePointYds
  meanLanding: CoursePointYds
  samples: ModeledAimSample[]
  probabilityContours: AimProbabilityContour[]
} | null => {
  if (
    typeof carrySigmaYds !== 'number' ||
    !Number.isFinite(carrySigmaYds) ||
    carrySigmaYds <= 0 ||
    typeof lateralSigmaYds !== 'number' ||
    !Number.isFinite(lateralSigmaYds) ||
    lateralSigmaYds <= 0
  ) {
    return null
  }

  const forward = unit(vector(ball, aimPoint))
  const right = rightOf(forward)
  const resolvedTotalMean =
    typeof totalMeanYds === 'number' && Number.isFinite(totalMeanYds)
      ? Math.max(carryMeanYds, totalMeanYds)
      : carryMeanYds
  const resolvedTotalSigma =
    typeof totalSigmaYds === 'number' && Number.isFinite(totalSigmaYds) && totalSigmaYds > 0
      ? totalSigmaYds
      : carrySigmaYds
  const draws: readonly ShotDraw[] = shotDraws && shotDraws.length > 0
    ? shotDraws
    : STANDARDIZED_SAMPLES.map(({ carryZ, lateralZ }) => {
        const carry = Math.max(0, carryMeanYds + carryZ * carrySigmaYds)
        // Use the same longitudinal quantile for carry and total so the modeled
        // rollout does not invent an independent second source of shot-length noise.
        return {
          carryYds: carry,
          totalYds: Math.max(carry, resolvedTotalMean + carryZ * resolvedTotalSigma),
          offlineYds: lateralMeanYds + lateralZ * lateralSigmaYds,
        }
      })
  const average = (pick: (draw: ShotDraw) => number) =>
    draws.reduce((sum, draw) => sum + pick(draw), 0) / draws.length
  const centerCarry = shotDraws?.length ? average((draw) => draw.carryYds) : carryMeanYds
  const centerTotal = shotDraws?.length ? average((draw) => draw.totalYds) : resolvedTotalMean
  const centerOffline = shotDraws?.length ? average((draw) => draw.offlineYds) : lateralMeanYds
  const meanCarryLanding = addScaled(ball, forward, centerCarry, right, centerOffline)
  const baselineMeanLanding = addScaled(ball, forward, centerTotal, right, centerOffline)
  const meanLanding = landingTransform
    ? landingTransform(meanCarryLanding, baselineMeanLanding)
    : baselineMeanLanding

  const samples = draws.map(({ carryYds: carry, totalYds: total, offlineYds: offline }): ModeledAimSample => {
    const carryLanding = addScaled(ball, forward, carry, right, offline)
    const baselineLanding = addScaled(ball, forward, total, right, offline)
    const blocked = flightCheck ? flightBlockedAt(hole, ball, carryLanding, flightCheck.descentDeg) : null
    if (blocked) {
      const classification = { kind: 'deep-rough' as const, surfaceId: null, confidence: 'medium' as const }
      return {
        carryLanding,
        landing: blocked.point,
        stockRollYds: total - carry,
        flightTag: blocked.tag,
        kind: classification.kind,
        state: buildDecisionLandingState(hole, blocked.point, classification, pinLocalYds),
      }
    }
    const { touchdown, rest } = resolveLanding(landingTransform, carryLanding, baselineLanding)
    const { landing, classification } = resolveCarryAwareLanding(hole, touchdown, rest)
    const relief = classification.kind === 'water' || classification.kind === 'penalty'
      ? penaltyReliefPoint(hole, ball, landing)
      : null
    return {
      carryLanding,
      landing,
      unobstructedLanding: rest,
      stockRollYds: total - carry,
      kind: classification.kind,
      state: buildDecisionLandingState(hole, landing, classification, pinLocalYds, ball, relief),
    }
  })

  const probabilityContours: AimProbabilityContour[] = [0.5, 0.8, 0.95].map(
    (probability) => {
      const radius = CONTOUR_RADII[probability as keyof typeof CONTOUR_RADII]
      return {
        probability: probability as AimProbabilityContour['probability'],
        carryRadiusYds: radius * resolvedTotalSigma,
        lateralRadiusYds: radius * lateralSigmaYds,
      }
    },
  )

  return {
    distribution: summarizeSurfaceKinds(samples),
    meanCarryLanding,
    meanLanding,
    samples,
    probabilityContours,
  }
}
