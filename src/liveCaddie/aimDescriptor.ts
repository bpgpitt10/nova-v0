import {
  classifyPoint,
  fairwayCorridorAtForwardY,
  surfaceIntervalsAtForwardY,
  surfaceIntervalsAtRightX,
} from '../courseGeometry/geometry'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  GeometryConfidence,
} from '../courseGeometry/types'

export type AimDescriptorKind =
  | 'landmark'
  | 'fairway-zone'
  | 'green-zone'
  | 'pin-offset'
  | 'fairway-edge'
  | 'centerline'

export type AimDescriptorConfidence = 'high' | 'medium' | 'low'

export type AimDescriptor = {
  text: string
  kind: AimDescriptorKind
  confidence: AimDescriptorConfidence
  /** Optional human-recognizable object used to express the same absolute aim point. */
  anchorLabel: string | null
  /** Debug-only reason retained for shadow-mode validation. */
  reason: string
}

export type BuildAimDescriptorInput = {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  aimPoint: CoursePointYds
  /** Existing optimizer offset. Used only as a deterministic final fallback. */
  aimOffsetYds?: number | null
  /** Optional pin/flag estimate. It is never allowed to alter the recommended aim point. */
  pin?: CoursePointYds | null
}

type ShotFramePoint = {
  lateral: number
  forward: number
}

type LandmarkCandidate = {
  text: string
  anchorLabel: string
  confidence: AimDescriptorConfidence
  score: number
  reason: string
}

const EPSILON = 1e-9

const distance = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(b[0] - a[0], b[1] - a[1])

const unitFromTo = (from: CoursePointYds, to: CoursePointYds): CoursePointYds => {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy)
  return length > EPSILON ? [dx / length, dy / length] : [0, 1]
}

const shotFrame = (ball: CoursePointYds, target: CoursePointYds) => {
  const forward = unitFromTo(ball, target)
  const right: CoursePointYds = [forward[1], -forward[0]]
  return (point: CoursePointYds): ShotFramePoint => {
    const dx = point[0] - ball[0]
    const dy = point[1] - ball[1]
    return {
      lateral: dx * right[0] + dy * right[1],
      forward: dx * forward[0] + dy * forward[1],
    }
  }
}

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
  let best: CoursePointYds = polygon[0]
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

const polygonCenter = (polygon: CoursePolygonYds): CoursePointYds | null => {
  if (polygon.length === 0) return null
  const sum = polygon.reduce(
    (acc, point) => [acc[0] + point[0], acc[1] + point[1]] as [number, number],
    [0, 0] as [number, number],
  )
  return [sum[0] / polygon.length, sum[1] / polygon.length]
}

const descriptorConfidence = (
  confidence: GeometryConfidence,
  availability: 'available' | 'partial' | 'unavailable' = 'available',
): AimDescriptorConfidence => {
  if (availability === 'unavailable' || confidence === 'low' || confidence === 'unknown') return 'low'
  if (availability === 'partial' || confidence === 'medium') return 'medium'
  return 'high'
}

const roundedYards = (value: number) => Math.max(1, Math.round(Math.abs(value)))

const sideLabel = (lateralYds: number) => {
  if (lateralYds < -4) return 'left'
  if (lateralYds > 4) return 'right'
  return 'center'
}

const landmarkLabel = (
  kind: 'bunker' | 'water',
  lateralYds: number,
) => {
  const side = sideLabel(lateralYds)
  if (kind === 'bunker') return side === 'center' ? 'bunker' : `${side} bunker`
  return side === 'center' ? 'water' : `${side}-side water`
}

const chooseRelevantInterval = (
  intervals: ReturnType<typeof surfaceIntervalsAtForwardY>,
  reference: number,
) => {
  if (intervals.length === 0) return null
  const intervalDistance = (min: number, max: number) => {
    if (reference < min) return min - reference
    if (reference > max) return reference - max
    return 0
  }
  return [...intervals].sort((a, b) => {
    const delta = intervalDistance(a.min, a.max) - intervalDistance(b.min, b.max)
    if (Math.abs(delta) > EPSILON) return delta
    return b.width - a.width
  })[0]
}

const landmarkDescriptor = ({
  hole,
  ball,
  target,
  aimPoint,
}: BuildAimDescriptorInput): AimDescriptor | null => {
  const toShotFrame = shotFrame(ball, target)
  const aim = toShotFrame(aimPoint)
  const candidates: LandmarkCandidate[] = []

  for (const surface of hole.surfaces) {
    if (surface.kind !== 'bunker' && surface.kind !== 'water') continue
    const confidence = descriptorConfidence(
      surface.provenance.confidence,
      hole.availability[surface.kind],
    )
    if (confidence === 'low') continue

    for (const polygon of surface.polygons) {
      const centerPoint = polygonCenter(polygon)
      const edgePoint = closestPointOnPolygon(aimPoint, polygon)
      if (!centerPoint || !edgePoint) continue

      const center = toShotFrame(centerPoint)
      const edge = toShotFrame(edgePoint)
      const absoluteDistance = distance(aimPoint, edgePoint)
      const lateralGap = edge.lateral - aim.lateral
      const forwardGap = Math.abs(edge.forward - aim.forward)

      if (center.forward < 10 || center.forward > aim.forward + 55) continue
      if (absoluteDistance > 34 || forwardGap > 30 || Math.abs(lateralGap) > 26) continue

      const anchorLabel = landmarkLabel(surface.kind, center.lateral)
      const relation = lateralGap >= 0 ? 'left' : 'right'
      const nearEdge = Math.abs(lateralGap) <= 2.5
      const text = nearEdge
        ? `Aim at the ${relation} edge of the ${anchorLabel}`
        : `Aim ${roundedYards(lateralGap)} yd ${relation} of the ${anchorLabel}`
      const importanceBonus = surface.kind === 'water' ? -2 : 0
      const confidencePenalty = confidence === 'medium' ? 4 : 0
      const score = absoluteDistance + forwardGap * 0.35 + confidencePenalty + importanceBonus

      candidates.push({
        text,
        anchorLabel,
        confidence,
        score,
        reason: `${surface.kind} ${surface.id} is ${absoluteDistance.toFixed(1)} yd from the absolute aim point at a ${forwardGap.toFixed(1)} yd depth difference.`,
      })
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.score - b.score)
  const best = candidates[0]
  const second = candidates[1]

  if (second && second.score - best.score < 4 && second.anchorLabel === best.anchorLabel) return null

  return {
    text: best.text,
    kind: 'landmark',
    confidence: best.confidence,
    anchorLabel: best.anchorLabel,
    reason: best.reason,
  }
}

const fairwayZoneDescriptor = ({
  hole,
  aimPoint,
}: BuildAimDescriptorInput): AimDescriptor | null => {
  const classification = classifyPoint(hole, aimPoint)
  if (classification.kind !== 'fairway') return null
  const corridor = fairwayCorridorAtForwardY(hole, aimPoint[1], aimPoint[0])
  if (!corridor || corridor.widthYds < 16) return null

  const confidence = descriptorConfidence(
    classification.confidence,
    hole.availability.fairway,
  )
  if (confidence === 'low') return null

  const position = Math.max(
    0,
    Math.min(1, (aimPoint[0] - corridor.leftEdgeYds) / Math.max(EPSILON, corridor.widthYds)),
  )
  const zone = position < 0.18
    ? 'left side'
    : position < 0.40
      ? 'left-center'
      : position <= 0.60
        ? 'center'
        : position <= 0.82
          ? 'right-center'
          : 'right side'

  return {
    text: `Aim ${zone} fairway`,
    kind: 'fairway-zone',
    confidence,
    anchorLabel: 'fairway',
    reason: `Aim point is ${(position * 100).toFixed(0)}% across a ${corridor.widthYds.toFixed(1)} yd fairway corridor.`,
  }
}

const greenZoneDescriptor = ({
  hole,
  aimPoint,
}: BuildAimDescriptorInput): AimDescriptor | null => {
  const classification = classifyPoint(hole, aimPoint)
  if (classification.kind !== 'green') return null

  const confidence = descriptorConfidence(
    classification.confidence,
    hole.availability.green,
  )
  if (confidence === 'low') return null

  const lateralInterval = chooseRelevantInterval(
    surfaceIntervalsAtForwardY(hole, aimPoint[1], ['green']),
    aimPoint[0],
  )
  const depthIntervals = surfaceIntervalsAtRightX(hole, aimPoint[0], ['green'])
  const depthInterval = depthIntervals.length === 0
    ? null
    : [...depthIntervals].sort((a, b) => {
        const aDistance = aimPoint[1] < a.min ? a.min - aimPoint[1] : aimPoint[1] > a.max ? aimPoint[1] - a.max : 0
        const bDistance = aimPoint[1] < b.min ? b.min - aimPoint[1] : aimPoint[1] > b.max ? aimPoint[1] - b.max : 0
        return aDistance - bDistance
      })[0]
  if (!lateralInterval || !depthInterval) return null

  const lateralPosition = Math.max(
    0,
    Math.min(1, (aimPoint[0] - lateralInterval.min) / Math.max(EPSILON, lateralInterval.width)),
  )
  const depthPosition = Math.max(
    0,
    Math.min(1, (aimPoint[1] - depthInterval.min) / Math.max(EPSILON, depthInterval.width)),
  )

  const lateral = lateralPosition < 0.34 ? 'left' : lateralPosition > 0.66 ? 'right' : 'center'
  const depth = depthPosition < 0.30 ? 'front' : depthPosition > 0.70 ? 'back' : 'middle'
  const zone = depth === 'middle'
    ? lateral === 'center' ? 'center' : `${lateral}-center`
    : lateral === 'center' ? `${depth}-center` : `${depth}-${lateral}`

  return {
    text: `Aim ${zone} green`,
    kind: 'green-zone',
    confidence,
    anchorLabel: 'green',
    reason: `Aim point is ${(lateralPosition * 100).toFixed(0)}% across and ${(depthPosition * 100).toFixed(0)}% through the local green section.`,
  }
}

const pinOffsetDescriptor = ({
  ball,
  target,
  aimPoint,
  pin,
}: BuildAimDescriptorInput): AimDescriptor | null => {
  if (!pin) return null
  const toShotFrame = shotFrame(ball, target)
  const aim = toShotFrame(aimPoint)
  const flag = toShotFrame(pin)
  const forwardGap = Math.abs(flag.forward - aim.forward)
  const lateralGap = flag.lateral - aim.lateral
  const absoluteDistance = distance(pin, aimPoint)
  if (forwardGap > 12 || absoluteDistance > 35) return null

  if (absoluteDistance <= 2.5) {
    return {
      text: 'Aim at the pin',
      kind: 'pin-offset',
      confidence: 'medium',
      anchorLabel: 'pin',
      reason: `Pin is ${absoluteDistance.toFixed(1)} yd from the absolute aim point.`,
    }
  }

  if (Math.abs(lateralGap) < 1.5) return null

  return {
    text: `Aim ${roundedYards(lateralGap)} yd ${lateralGap >= 0 ? 'left' : 'right'} of the pin`,
    kind: 'pin-offset',
    confidence: 'medium',
    anchorLabel: 'pin',
    reason: `Pin is ${absoluteDistance.toFixed(1)} yd from the absolute aim point and ${Math.abs(lateralGap).toFixed(1)} yd away laterally.`,
  }
}

const fairwayEdgeDescriptor = ({
  hole,
  aimPoint,
}: BuildAimDescriptorInput): AimDescriptor | null => {
  const corridor = fairwayCorridorAtForwardY(hole, aimPoint[1], aimPoint[0])
  if (!corridor) return null
  if (aimPoint[0] < corridor.leftEdgeYds || aimPoint[0] > corridor.rightEdgeYds) return null

  const classification = classifyPoint(hole, aimPoint)
  const confidence = descriptorConfidence(
    classification.confidence,
    hole.availability.fairway,
  )
  if (confidence === 'low') return null

  const insideLeft = aimPoint[0] - corridor.leftEdgeYds
  const insideRight = corridor.rightEdgeYds - aimPoint[0]
  const nearestSide = insideLeft <= insideRight ? 'left' : 'right'
  const insideYds = nearestSide === 'left' ? insideLeft : insideRight

  return {
    text: `Aim ${roundedYards(insideYds)} yd inside the ${nearestSide} fairway edge`,
    kind: 'fairway-edge',
    confidence,
    anchorLabel: `${nearestSide} fairway edge`,
    reason: `Nearest fairway edge is ${insideYds.toFixed(1)} yd from the absolute aim point.`,
  }
}

const centerlineDescriptor = ({
  ball,
  target,
  aimPoint,
  aimOffsetYds,
}: BuildAimDescriptorInput): AimDescriptor => {
  const toShotFrame = shotFrame(ball, target)
  const aim = toShotFrame(aimPoint)
  const targetPoint = toShotFrame(target)
  const resolvedOffset = typeof aimOffsetYds === 'number' && Number.isFinite(aimOffsetYds)
    ? aimOffsetYds
    : aim.lateral - targetPoint.lateral

  if (Math.abs(resolvedOffset) < 0.75) {
    return {
      text: 'Aim center line',
      kind: 'centerline',
      confidence: 'high',
      anchorLabel: 'center line',
      reason: 'No higher-confidence landmark, zone, pin or edge descriptor was available.',
    }
  }

  return {
    text: `Aim ${roundedYards(resolvedOffset)} yd ${resolvedOffset < 0 ? 'left' : 'right'} of center line`,
    kind: 'centerline',
    confidence: 'high',
    anchorLabel: 'center line',
    reason: 'No higher-confidence landmark, zone, pin or edge descriptor was available.',
  }
}

const isApproachLike = ({
  hole,
  ball,
  target,
  aimPoint,
  pin,
}: BuildAimDescriptorInput) => {
  if (classifyPoint(hole, aimPoint).kind === 'green') return true
  if (classifyPoint(hole, target).kind === 'green') return true
  if (!pin) return false
  return distance(aimPoint, pin) <= 60 && distance(ball, pin) <= 260
}

/**
 * Convert an already-selected absolute aim point into player-facing language.
 * This layer is descriptive only: it never changes club ranking, aim ranking,
 * the recommended coordinate, or GSPro execution.
 *
 * Tee/long-shot precedence:
 * 1) meaningful visible hazard landmark,
 * 2) recognizable fairway zone,
 * 3) fairway edge,
 * 4) pin only when genuinely nearby,
 * 5) geometric center-line fallback.
 *
 * Approach/par-3 precedence:
 * 1) pin offset when it accurately describes the same depth,
 * 2) green zone,
 * 3) meaningful visible hazard landmark,
 * 4) fairway/edge fallbacks,
 * 5) geometric center-line fallback.
 */
export const buildAimDescriptor = (input: BuildAimDescriptorInput): AimDescriptor => {
  if (isApproachLike(input)) {
    return pinOffsetDescriptor(input)
      ?? greenZoneDescriptor(input)
      ?? landmarkDescriptor(input)
      ?? fairwayZoneDescriptor(input)
      ?? fairwayEdgeDescriptor(input)
      ?? centerlineDescriptor(input)
  }

  return landmarkDescriptor(input)
    ?? fairwayZoneDescriptor(input)
    ?? fairwayEdgeDescriptor(input)
    ?? pinOffsetDescriptor(input)
    ?? greenZoneDescriptor(input)
    ?? centerlineDescriptor(input)
}

/**
 * Context is intentionally selected separately from the short aim command.
 * Low-confidence geometry is never promoted into an explanatory sentence.
 */
export const buildAimContextSentence = (descriptor: AimDescriptor): string | null => {
  if (descriptor.confidence === 'low') return null
  if (descriptor.kind === 'landmark' && descriptor.anchorLabel) {
    return `Use the ${descriptor.anchorLabel} as the visual reference for the line.`
  }
  if (descriptor.kind === 'fairway-zone') {
    return 'The recommended line sits in a stable fairway corridor.'
  }
  if (descriptor.kind === 'green-zone') {
    return 'The recommendation is anchored to a safe section of the green rather than the flag alone.'
  }
  if (descriptor.kind === 'pin-offset') {
    return 'The pin is being used only as a visual reference for the same recommended aim point.'
  }
  return null
}
