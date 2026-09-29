import {
  classifyPoint,
  pointInPolygon,
  type SurfaceClassificationResult,
} from './geometry'
import type { CourseHoleGeometry, CoursePointYds } from './types'

/**
 * Decision-layer landing classification.
 *
 * Playable / penalty surface geometry remains authoritative. Course-wide
 * environment context is only consulted when the normal surface classifier
 * returns unknown. Woods and scrub then become tactical deep rough: the ball
 * may technically be playable, but for decision-making these are obstruction
 * outcomes with the same downside tier as deep rough.
 *
 * Grass context intentionally remains unknown. It is useful rendering/context
 * data, but is not precise enough to promote a miss to normal rough/fairway.
 */
export function classifyTacticalLandingPoint(
  hole: CourseHoleGeometry,
  point: CoursePointYds,
): SurfaceClassificationResult {
  const surface = classifyPoint(hole, point)
  if (surface.kind !== 'unknown') return surface

  for (const layer of hole.contextLayers ?? []) {
    if (layer.kind !== 'woods' && layer.kind !== 'scrub') continue
    if (!layer.polygons.some((polygon) => pointInPolygon(point, polygon))) continue

    return {
      kind: 'deep-rough',
      surfaceId: layer.id,
      confidence: layer.provenance.confidence,
    }
  }

  return surface
}
