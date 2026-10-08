import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceKind,
} from '../courseGeometry/types'
import type { AimCandidateEvaluation } from './aimOptimization'

const BACK_OF_BALL_BUFFER_YDS = 20
const PAST_GREEN_BUFFER_YDS = 24
const MIN_FORWARD_WINDOW_YDS = 140
const MAX_NORMAL_HALF_WIDTH_YDS = 130

const framingKinds = new Set<CourseSurfaceKind>([
  'tee',
  'fairway',
  'green',
  'bunker',
  'water',
  'penalty',
])

const greenPoints = (hole: CourseHoleGeometry): CoursePointYds[] =>
  hole.surfaces
    .filter((surface) => surface.kind === 'green')
    .flatMap((surface) => surface.polygons.flatMap((polygon) => [...polygon]))

/**
 * Live Caddie framing follows the player's progress through the hole:
 * - from the tee, the whole hole through the full green is visible;
 * - after every shot, ground >20 yd behind the ball can fall away;
 * - the entire green plus a small destination buffer always remains visible.
 *
 * Context/rough polygons do not drive zoom because large background polygons
 * should not make the playable hole microscopic. They are still rendered when
 * they intersect the resulting viewport.
 */
export const buildTacticalMapBounds = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  target: CoursePointYds,
  pinEstimate: CoursePointYds | null,
  candidate: AimCandidateEvaluation | null,
) => {
  const destinationGreenPoints = greenPoints(hole)
  const maxCarryRadius = candidate?.probabilityContours.reduce(
    (maximum, contour) => Math.max(maximum, contour.carryRadiusYds),
    0,
  ) ?? 0
  const maxLateralRadius = candidate?.probabilityContours.reduce(
    (maximum, contour) => Math.max(maximum, contour.lateralRadiusYds),
    0,
  ) ?? 0

  const focusPoints: CoursePointYds[] = [
    ball,
    target,
    ...destinationGreenPoints,
  ]
  if (pinEstimate) focusPoints.push(pinEstimate)
  if (candidate) focusPoints.push(candidate.aimPoint, candidate.meanLanding)

  const minY = ball[1] - BACK_OF_BALL_BUFFER_YDS
  const destinationTopY = Math.max(
    target[1],
    pinEstimate?.[1] ?? Number.NEGATIVE_INFINITY,
    ...destinationGreenPoints.map((point) => point[1]),
  )
  const candidateTopY = candidate
    ? candidate.meanLanding[1] + maxCarryRadius + 16
    : Number.NEGATIVE_INFINITY
  const maxY = Math.max(
    minY + MIN_FORWARD_WINDOW_YDS,
    destinationTopY + PAST_GREEN_BUFFER_YDS,
    candidateTopY,
  )

  let referenceMinX = Math.min(...focusPoints.map((point) => point[0])) - maxLateralRadius
  let referenceMaxX = Math.max(...focusPoints.map((point) => point[0])) + maxLateralRadius

  // Let actual playable geometry describe doglegs and hazards inside the active
  // ball-to-green window. Deliberately ignore rough/context here: those often
  // contain very large polygons whose only effect would be excessive zoom-out.
  const surfaceWindowMinY = minY - 12
  const surfaceWindowMaxY = maxY + 12
  for (const surface of hole.surfaces) {
    if (!framingKinds.has(surface.kind)) continue
    for (const polygon of surface.polygons) {
      for (const [x, y] of polygon) {
        if (y < surfaceWindowMinY || y > surfaceWindowMaxY) continue
        referenceMinX = Math.min(referenceMinX, x)
        referenceMaxX = Math.max(referenceMaxX, x)
      }
    }
  }

  const centerX = (referenceMinX + referenceMaxX) / 2
  const desiredHalfWidth = Math.max(
    58,
    (referenceMaxX - referenceMinX) / 2 + 20,
  )
  const focusMinX = Math.min(...focusPoints.map((point) => point[0])) - maxLateralRadius
  const focusMaxX = Math.max(...focusPoints.map((point) => point[0])) + maxLateralRadius
  const minimumFocusHalfWidth = Math.max(
    centerX - focusMinX,
    focusMaxX - centerX,
  ) + 12
  const halfWidth = Math.max(
    minimumFocusHalfWidth,
    Math.min(MAX_NORMAL_HALF_WIDTH_YDS, desiredHalfWidth),
  )

  return {
    minX: centerX - halfWidth,
    maxX: centerX + halfWidth,
    minY,
    maxY,
  }
}
