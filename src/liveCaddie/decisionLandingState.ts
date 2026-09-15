import { TACTICAL_SURFACE_SEMANTICS } from '../courseGeometry/semantics'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import type { SurfaceClassificationResult } from '../courseGeometry/geometry'

export type DecisionLandingObstruction = 'none' | 'woods-or-scrub' | 'unknown'

/**
 * Exact post-shot geometric state retained for later value models such as
 * strokes gained. Tactical buckets remain useful summaries, but downstream
 * evaluators should not need to reconstruct the raw landing state from them.
 *
 * For penalty outcomes, distanceToPinYds is the raw splash/crossing-point
 * distance only. The eventual SG evaluator must model relief/drop location
 * before treating that distance as the next-shot state.
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
  tacticalSeverity: number
}

const distance = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(a[0] - b[0], a[1] - b[1])

export const buildDecisionLandingState = (
  hole: CourseHoleGeometry,
  landing: CoursePointYds,
  classification: SurfaceClassificationResult,
): DecisionLandingState => {
  const semantics = TACTICAL_SURFACE_SEMANTICS[classification.kind]
  const penalty = classification.kind === 'water' || classification.kind === 'penalty'
  const obstruction: DecisionLandingObstruction = classification.kind === 'deep-rough'
    ? 'woods-or-scrub'
    : classification.kind === 'unknown'
      ? 'unknown'
      : 'none'

  return {
    landing,
    surface: classification.kind,
    surfaceId: classification.surfaceId,
    surfaceConfidence: classification.confidence,
    distanceToPinYds: hole.markers.pin ? distance(landing, hole.markers.pin) : null,
    penaltyStrokeCount: penalty ? 1 : 0,
    requiresRelief: penalty,
    obstruction,
    tacticalSeverity: semantics.severity,
  }
}
