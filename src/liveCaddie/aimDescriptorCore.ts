import { classifyPoint } from '../courseGeometry/geometry'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurfaceKind,
  GeometryConfidence,
} from '../courseGeometry/types'
import {
  buildAimShotFrame,
  chooseAimFrameInterval,
  polygonIntervalsAtForward,
  polygonIntervalsAtLateral,
  surfacePolygonsForAimFrame,
} from './aimDescriptorFrame'

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
  anchorLabel: string | null
  reason: string
  contextFacts: string[]
}

type AimDescriptorCore = Omit<AimDescriptor, 'contextFacts'>

export type BuildAimDescriptorInput = {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  aimPoint: CoursePointYds
  aimOffsetYds?: number | null
  pin?: CoursePointYds | null
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

const landmarkLabel = (kind: 'bunker' | 'water', lateralYds: number) => {
  const side = sideLabel(lateralYds)
  if (kind === 'bunker') return side === 'center' ? 'bunker' : `${side} bunker`
  return side === 'center' ? 'water' : `${side}-side water`
}

const corridorAtAim = (
  input: BuildAimDescriptorInput,
  kind: 'fairway' | 'green',
) => {
  const project = buildAimShotFrame(input.ball, input.target)
  const aim = project(input.aimPoint)
  const polygons = surfacePolygonsForAimFrame(input.hole, kind)
  const interval = chooseAimFrameInterval(
    polygonIntervalsAtForward(polygons, project, aim.forward),
    aim.lateral,
  )
  return { project, aim, polygons, interval }
}

const landmarkDescriptor = ({
  hole,
  ball,
  target,
  aimPoint,
}: BuildAimDescriptorInput): AimDescriptorCore | null => {
  const project = buildAimShotFrame(ball, target)
  const aim = project(aimPoint)
  const candidates: LandmarkCandidate[] = []

  for (const surface of hole.surfaces) {
    if (surface.kind !== 'bunker' && surface.kind !== 'water') continue
    const confidence = descriptorConfidence(surface.provenance.confidence, hole.availability[surface.kind])
    if (confidence === 'low') continue

    for (const polygon of surface.polygons) {
      const centerPoint = polygonCenter(polygon)
      const edgePoint = closestPointOnPolygon(aimPoint, polygon)
      if (!centerPoint || !edgePoint) continue

      const center = project(centerPoint)
      const edge = project(edgePoint)
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

const fairwayZoneDescriptor = (input: BuildAimDescriptorInput): AimDescriptorCore | null => {
  const classification = classifyPoint(input.hole, input.aimPoint)
  if (classification.kind !== 'fairway') return null
  const { aim, interval } = corridorAtAim(input, 'fairway')
  if (!interval || interval.width < 16) return null
  if (aim.lateral < interval.min - EPSILON || aim.lateral > interval.max + EPSILON) return null

  const confidence = descriptorConfidence(classification.confidence, input.hole.availability.fairway)
  if (confidence === 'low') return null

  const position = Math.max(0, Math.min(1, (aim.lateral - interval.min) / Math.max(EPSILON, interval.width)))
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
    reason: `Aim point is ${(position * 100).toFixed(0)}% across a ${interval.width.toFixed(1)} yd fairway corridor in the current shot frame.`,
  }
}

const greenZoneDescriptor = (input: BuildAimDescriptorInput): AimDescriptorCore | null => {
  const classification = classifyPoint(input.hole, input.aimPoint)
  if (classification.kind !== 'green') return null

  const confidence = descriptorConfidence(classification.confidence, input.hole.availability.green)
  if (confidence === 'low') return null

  const { project, aim, polygons, interval: lateralInterval } = corridorAtAim(input, 'green')
  const depthInterval = chooseAimFrameInterval(
    polygonIntervalsAtLateral(polygons, project, aim.lateral),
    aim.forward,
  )
  if (!lateralInterval || !depthInterval) return null

  const lateralPosition = Math.max(
    0,
    Math.min(1, (aim.lateral - lateralInterval.min) / Math.max(EPSILON, lateralInterval.width)),
  )
  const depthPosition = Math.max(
    0,
    Math.min(1, (aim.forward - depthInterval.min) / Math.max(EPSILON, depthInterval.width)),
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
    reason: `Aim point is ${(lateralPosition * 100).toFixed(0)}% across and ${(depthPosition * 100).toFixed(0)}% through the actual green polygon in the current shot frame.`,
  }
}

const pinOffsetDescriptor = ({
  ball,
  target,
  aimPoint,
  pin,
}: BuildAimDescriptorInput): AimDescriptorCore | null => {
  if (!pin) return null
  const project = buildAimShotFrame(ball, target)
  const aim = project(aimPoint)
  const flag = project(pin)
  const signedForwardGap = aim.forward - flag.forward
  const forwardGap = Math.abs(signedForwardGap)
  const lateralGap = flag.lateral - aim.lateral
  const absoluteDistance = distance(pin, aimPoint)
  if (forwardGap > 12 || absoluteDistance > 35) return null

  if (absoluteDistance <= 1.25) {
    return {
      text: 'Aim at the pin',
      kind: 'pin-offset',
      confidence: 'medium',
      anchorLabel: 'pin',
      reason: `Pin is ${absoluteDistance.toFixed(1)} yd from the absolute aim point.`,
    }
  }

  if (Math.abs(lateralGap) >= 1.5) {
    return {
      text: `Aim ${roundedYards(lateralGap)} yd ${lateralGap >= 0 ? 'left' : 'right'} of the pin`,
      kind: 'pin-offset',
      confidence: 'medium',
      anchorLabel: 'pin',
      reason: `Pin is ${absoluteDistance.toFixed(1)} yd from the absolute aim point and ${Math.abs(lateralGap).toFixed(1)} yd away laterally.`,
    }
  }

  if (forwardGap >= 1.25) {
    return {
      text: `Aim ${roundedYards(signedForwardGap)} yd ${signedForwardGap < 0 ? 'short of' : 'past'} the pin`,
      kind: 'pin-offset',
      confidence: 'medium',
      anchorLabel: 'pin',
      reason: `Aim point is ${forwardGap.toFixed(1)} yd ${signedForwardGap < 0 ? 'short of' : 'past'} the pin along the shot line.`,
    }
  }

  return null
}

const fairwayEdgeDescriptor = (input: BuildAimDescriptorInput): AimDescriptorCore | null => {
  const classification = classifyPoint(input.hole, input.aimPoint)
  if (classification.kind !== 'fairway') return null
  const { aim, interval } = corridorAtAim(input, 'fairway')
  if (!interval) return null
  if (aim.lateral < interval.min - EPSILON || aim.lateral > interval.max + EPSILON) return null

  const confidence = descriptorConfidence(classification.confidence, input.hole.availability.fairway)
  if (confidence === 'low') return null

  const insideLeft = aim.lateral - interval.min
  const insideRight = interval.max - aim.lateral
  const nearestSide = insideLeft <= insideRight ? 'left' : 'right'
  const insideYds = nearestSide === 'left' ? insideLeft : insideRight

  return {
    text: `Aim ${roundedYards(insideYds)} yd inside the ${nearestSide} fairway edge`,
    kind: 'fairway-edge',
    confidence,
    anchorLabel: `${nearestSide} fairway edge`,
    reason: `Nearest fairway edge is ${insideYds.toFixed(1)} yd from the absolute aim point in the current shot frame.`,
  }
}

const centerlineDescriptor = ({
  ball,
  target,
  aimPoint,
  aimOffsetYds,
}: BuildAimDescriptorInput): AimDescriptorCore => {
  const project = buildAimShotFrame(ball, target)
  const aim = project(aimPoint)
  const targetPoint = project(target)
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

const capitalize = (value: string) => value.length > 0
  ? `${value[0].toUpperCase()}${value.slice(1)}`
  : value

const relevantHazardKind = (descriptor: AimDescriptorCore): CourseSurfaceKind | null => {
  if (descriptor.kind !== 'landmark' || !descriptor.anchorLabel) return null
  if (descriptor.anchorLabel.includes('bunker')) return 'bunker'
  if (descriptor.anchorLabel.includes('water')) return 'water'
  return null
}

const hazardStartFact = (
  { hole, ball, aimPoint }: BuildAimDescriptorInput,
  descriptor: AimDescriptorCore,
) => {
  const kind = relevantHazardKind(descriptor)
  if (!kind || hole.availability[kind] === 'unavailable') return null

  let selectedPolygon: CoursePolygonYds | null = null
  let selectedAimGap = Number.POSITIVE_INFINITY
  for (const surface of hole.surfaces) {
    if (surface.kind !== kind || surface.provenance.confidence === 'low' || surface.provenance.confidence === 'unknown') continue
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

  const project = buildAimShotFrame(ball, aimPoint)
  const alongLine = chooseAimFrameInterval(
    polygonIntervalsAtLateral([selectedPolygon], project, 0),
    0,
  )
  if (!alongLine) return null
  const startYds = alongLine.min > 0 ? alongLine.min : alongLine.max > 0 ? 0 : null
  if (startYds === null || !Number.isFinite(startYds)) return null

  return `${capitalize(descriptor.anchorLabel ?? kind)} begins about ${Math.round(startYds)} yd along the recommended line.`
}

const fairwayWidthFact = (input: BuildAimDescriptorInput) => {
  if (input.hole.availability.fairway === 'unavailable') return null
  const { interval } = corridorAtAim(input, 'fairway')
  if (!interval || interval.width < 10) return null
  return `Fairway width: ${Math.round(interval.width)} yd`
}

const greenWidthFact = (input: BuildAimDescriptorInput) => {
  if (input.hole.availability.green === 'unavailable') return null
  const { interval } = corridorAtAim(input, 'green')
  if (!interval || interval.width < 8) return null
  return `Green width: ${Math.round(interval.width)} yd`
}

const greenTerrainShiftFact = ({
  hole,
  target,
  pin,
}: BuildAimDescriptorInput) => {
  if (!pin || classifyPoint(hole, target).kind !== 'green') return null
  const shiftYds = distance(target, pin)
  if (shiftYds < 0.35 || shiftYds > 5.25) return null
  return `Strategic target is ${shiftYds.toFixed(1)} yd from the pin after the green slope/edge adjustment.`
}

const buildContextFacts = (
  input: BuildAimDescriptorInput,
  descriptor: AimDescriptorCore,
) => {
  const facts: string[] = []
  // The green read now sits under the aim line in plain words (greenTargeting
  // playerRead); the old "Strategic target is N yd from the pin" fact is kept
  // only for audits.
  void greenTerrainShiftFact

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

export const buildAimDescriptor = (input: BuildAimDescriptorInput): AimDescriptor => {
  const core = isApproachLike(input)
    ? pinOffsetDescriptor(input)
      ?? greenZoneDescriptor(input)
      ?? landmarkDescriptor(input)
      ?? fairwayZoneDescriptor(input)
      ?? fairwayEdgeDescriptor(input)
      ?? centerlineDescriptor(input)
    : landmarkDescriptor(input)
      ?? fairwayZoneDescriptor(input)
      ?? fairwayEdgeDescriptor(input)
      ?? pinOffsetDescriptor(input)
      ?? greenZoneDescriptor(input)
      ?? centerlineDescriptor(input)

  return {
    ...core,
    contextFacts: buildContextFacts(input, core),
  }
}

export const buildAimContextSentence = (descriptor: AimDescriptor): string | null => {
  if (descriptor.confidence === 'low') return null
  if (descriptor.contextFacts.length > 0) {
    return descriptor.contextFacts.map((fact) => (/[.!?]$/.test(fact) ? fact : `${fact}.`)).join(' ')
  }
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
    return 'The pin is being used as the visual reference for the selected absolute aim point.'
  }
  return null
}
