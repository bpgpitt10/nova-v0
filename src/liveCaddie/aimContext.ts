import {
  fairwayCorridorAtForwardY,
  surfaceIntervalsAtForwardY,
} from '../courseGeometry/geometry'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurfaceKind,
} from '../courseGeometry/types'
import type { AimDescriptor } from './aimDescriptor'

export type AimContextInput = {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  aimPoint: CoursePointYds
}

const EPSILON = 1e-9

const distance = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(a[0] - b[0], a[1] - b[1])

const closestPointOnSegment = (
  point: CoursePointYds,
  start: CoursePointYds,
  end: CoursePointYds,
): CoursePointYds => {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= EPSILON) return start
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared,
    ),
  )
  return [start[0] + t * dx, start[1] + t * dy]
}

const closestPointOnPolygon = (
  point: CoursePointYds,
  polygon: CoursePolygonYds,
): CoursePointYds | null => {
  if (polygon.length === 0) return null
  let best = polygon[0]
  let bestDistance = distance(point, best)
  for (let index = 0; index < polygon.length; index += 1) {
    const candidate = closestPointOnSegment(
      point,
      polygon[index],
      polygon[(index + 1) % polygon.length],
    )
    const candidateDistance = distance(point, candidate)
    if (candidateDistance < bestDistance) {
      best = candidate
      bestDistance = candidateDistance
    }
  }
  return best
}

const relevantHazardKind = (descriptor: AimDescriptor): CourseSurfaceKind | null => {
  if (descriptor.kind !== 'landmark' || !descriptor.anchorLabel) return null
  if (descriptor.anchorLabel.includes('bunker')) return 'bunker'
  if (descriptor.anchorLabel.includes('water')) return 'water'
  return null
}

const capitalize = (value: string) => value.length > 0
  ? `${value[0].toUpperCase()}${value.slice(1)}`
  : value

const hazardStartFact = (
  { hole, ball, aimPoint }: AimContextInput,
  descriptor: AimDescriptor,
) => {
  const kind = relevantHazardKind(descriptor)
  if (!kind || hole.availability[kind] === 'unavailable') return null

  let selectedPolygon: CoursePolygonYds | null = null
  let selectedAimGap = Number.POSITIVE_INFINITY

  for (const surface of hole.surfaces) {
    if (surface.kind !== kind || surface.provenance.confidence === 'low' || surface.provenance.confidence === 'unknown') {
      continue
    }
    for (const polygon of surface.polygons) {
      const nearestToAim = closestPointOnPolygon(aimPoint, polygon)
      if (!nearestToAim) continue
      const aimGap = distance(aimPoint, nearestToAim)
      if (aimGap < selectedAimGap) {
        selectedAimGap = aimGap
        selectedPolygon = polygon
      }
    }
  }

  if (!selectedPolygon || selectedAimGap > 40) return null
  const nearestToBall = closestPointOnPolygon(ball, selectedPolygon)
  if (!nearestToBall) return null
  const startYds = distance(ball, nearestToBall)
  if (!Number.isFinite(startYds) || startYds <= 0) return null

  const label = descriptor.anchorLabel ?? kind
  return `${capitalize(label)} begins about ${Math.round(startYds)} yd from the ball.`
}

const fairwayWidthFact = ({ hole, aimPoint }: AimContextInput) => {
  if (hole.availability.fairway === 'unavailable') return null
  const corridor = fairwayCorridorAtForwardY(hole, aimPoint[1], aimPoint[0])
  if (!corridor || corridor.widthYds < 10) return null
  return `Fairway is ${Math.round(corridor.widthYds)} yd wide at this landing depth.`
}

const greenWidthFact = ({ hole, aimPoint }: AimContextInput) => {
  if (hole.availability.green === 'unavailable') return null
  const intervals = surfaceIntervalsAtForwardY(hole, aimPoint[1], ['green'])
  const relevant = intervals.find(
    (interval) => aimPoint[0] >= interval.min - EPSILON && aimPoint[0] <= interval.max + EPSILON,
  )
  if (!relevant || relevant.width < 8) return null
  return `Green is ${Math.round(relevant.width)} yd wide on this line.`
}

/**
 * Pick at most two measured facts that explain the already-selected aim point.
 * Facts never alter ranking or aim geometry. They are intended for shadow-mode
 * validation before any player-facing copy is changed.
 */
export const buildAimContextFacts = (
  input: AimContextInput,
  descriptor: AimDescriptor,
): string[] => {
  const facts: string[] = []

  if (descriptor.kind === 'green-zone' || descriptor.kind === 'pin-offset') {
    const green = greenWidthFact(input)
    if (green) facts.push(green)
  } else {
    const fairway = fairwayWidthFact(input)
    if (fairway) facts.push(fairway)
  }

  const hazard = hazardStartFact(input, descriptor)
  if (hazard) facts.push(hazard)

  return facts.slice(0, 2)
}
