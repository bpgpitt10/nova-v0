import { TACTICAL_SURFACE_SEMANTICS } from '../courseGeometry/semantics'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import type { SurfaceClassificationResult } from '../courseGeometry/geometry'
import { tacticalKindNear, unknownGroundAt, type UnknownGround } from '../courseGeometry/tacticalClassification'

export type DecisionLandingObstruction = 'none' | 'woods-or-scrub' | 'unknown'

/**
 * Exact post-shot geometric state retained for later value models such as
 * strokes gained. Tactical buckets remain useful summaries, but downstream
 * evaluators should not need to reconstruct the raw landing state from them.
 *
 * For penalty outcomes, `landing` is the splash point (for display), but
 * distanceToPinYds is measured from the relief point when one is supplied:
 * where the ball last crossed into the hazard, backed off a yard
 * (carryAwareLanding.penaltyReliefPoint). Without it, the splash distance.
 */
export type DecisionLandingState = {
  landing: CoursePointYds
  surface: CourseSurfaceClassification
  surfaceId: string | null
  surfaceConfidence: SurfaceClassificationResult['confidence']
  distanceToPinYds: number | null
  penaltyStrokeCount: 0 | 1
  requiresRelief: boolean
  obstruction: DecisionLandingObstruction
  /** For unmapped landings: grass (valued as rough) or other (valued as deep rough). */
  unknownGround?: UnknownGround | null
  /** Out of bounds (GSPro's OB from the course file). The player chooses, as
   * in real golf: rehit (one stroke, replayed from where the shot was played;
   * distanceToPinYds is then the replay distance and replaySurface its lie) or
   * drop (two strokes, near where the ball went out, on the fairway side:
   * dropDistanceToPinYds and dropSurface). */
  outOfBounds?: boolean
  replaySurface?: CourseSurfaceClassification | null
  dropDistanceToPinYds?: number | null
  dropSurface?: 'fairway' | 'rough'
  tacticalSeverity: number
}

const distance = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(a[0] - b[0], a[1] - b[1])

export const buildDecisionLandingState = (
  hole: CourseHoleGeometry,
  landing: CoursePointYds,
  classification: SurfaceClassificationResult,
  pinOverride?: CoursePointYds | null,
  /** Where the shot is played from: an out-of-bounds outcome is replayed from here. */
  replayFrom?: CoursePointYds | null,
  /** Water/penalty only: where relief is taken. Ignored for other surfaces. */
  reliefPoint?: CoursePointYds | null,
): DecisionLandingState => {
  const semantics = TACTICAL_SURFACE_SEMANTICS[classification.kind]
  const penalty = classification.kind === 'water' || classification.kind === 'penalty'
  const outOfBounds = Boolean(replayFrom && classification.surfaceId?.startsWith('gkd-oob'))
  const obstruction: DecisionLandingObstruction = classification.kind === 'deep-rough'
    ? 'woods-or-scrub'
    : classification.kind === 'unknown'
      ? 'unknown'
      : 'none'
  const pin = pinOverride ?? hole.markers.pin ?? null

  return {
    landing,
    surface: classification.kind,
    surfaceId: classification.surfaceId,
    surfaceConfidence: classification.confidence,
    distanceToPinYds: pin
      ? distance(outOfBounds ? replayFrom! : penalty && reliefPoint ? reliefPoint : landing, pin)
      : null,
    penaltyStrokeCount: penalty ? 1 : 0,
    requiresRelief: penalty,
    obstruction,
    unknownGround: classification.kind === 'unknown' ? unknownGroundAt(hole, landing) : null,
    ...(outOfBounds ? {
      outOfBounds: true,
      replaySurface: tacticalKindNear(hole, replayFrom!),
      dropDistanceToPinYds: pin ? distance(landing, pin) : null,
      dropSurface: hole.surfaces.some((surface) => surface.kind === 'fairway') ? 'fairway' as const : 'rough' as const,
    } : {}),
    tacticalSeverity: semantics.severity,
  }
}
