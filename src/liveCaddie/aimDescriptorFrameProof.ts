import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurface,
  CourseSurfaceKind,
} from '../courseGeometry/types'
import { buildAimDescriptor } from './aimDescriptorCore'

const availability = (overrides: Partial<Record<CourseSurfaceKind, 'available' | 'partial' | 'unavailable'>> = {}) => ({
  tee: 'unavailable',
  fairway: 'unavailable',
  rough: 'unavailable',
  'deep-rough': 'unavailable',
  green: 'unavailable',
  bunker: 'unavailable',
  water: 'unavailable',
  penalty: 'unavailable',
  ...overrides,
} as const)

const surface = (id: string, kind: CourseSurfaceKind, polygon: CoursePolygonYds): CourseSurface => ({
  id,
  kind,
  polygons: [polygon],
  provenance: { source: 'manual', confidence: 'high' },
})

const hole = (
  surfaces: readonly CourseSurface[],
  availabilityOverrides: Partial<Record<CourseSurfaceKind, 'available' | 'partial' | 'unavailable'>>,
  pin?: CoursePointYds,
): CourseHoleGeometry => ({
  schemaVersion: 'looper-course-geometry-v1',
  courseId: 'aim-descriptor-proof',
  courseName: 'Aim Descriptor Proof',
  holeNumber: 1,
  coordinateSystem: { units: 'yards', origin: 'selected-tee', xAxis: 'right', yAxis: 'forward' },
  bounds: { minX: -500, maxX: 500, minY: -500, maxY: 500 },
  markers: { tee: [0, 0], pin },
  surfaces,
  availability: availability(availabilityOverrides),
  registration: { status: 'verified', targetCoordinateSystem: 'looper-hole-local-yards' },
  provenance: { geometrySource: 'deterministic-proof' },
})

const inverseShotPoint = (
  ball: CoursePointYds,
  target: CoursePointYds,
  lateral: number,
  forward: number,
): CoursePointYds => {
  const dx = target[0] - ball[0]
  const dy = target[1] - ball[1]
  const length = Math.hypot(dx, dy)
  const fx = dx / length
  const fy = dy / length
  const rx = fy
  const ry = -fx
  return [ball[0] + lateral * rx + forward * fx, ball[1] + lateral * ry + forward * fy]
}

const shotRectangle = (
  ball: CoursePointYds,
  target: CoursePointYds,
  left: number,
  right: number,
  front: number,
  back: number,
): CoursePolygonYds => [
  inverseShotPoint(ball, target, left, front),
  inverseShotPoint(ball, target, right, front),
  inverseShotPoint(ball, target, right, back),
  inverseShotPoint(ball, target, left, back),
]

const expectText = (actual: string, expected: string) => {
  if (actual !== expected) throw new Error(`Aim descriptor proof expected "${expected}" but got "${actual}"`)
}

const expectContains = (actual: readonly string[], expected: string) => {
  if (!actual.some((value) => value.includes(expected))) {
    throw new Error(`Aim descriptor proof expected context containing "${expected}" but got ${JSON.stringify(actual)}`)
  }
}

const expectKind = (actual: string, expected: string) => {
  if (actual !== expected) throw new Error(`Aim descriptor proof expected kind "${expected}" but got "${actual}"`)
}

export const runAimDescriptorShotFrameProof = () => {
  // Baseline: course axes and shot axes align.
  {
    const ball: CoursePointYds = [0, 0]
    const target: CoursePointYds = [0, 200]
    const fairway = shotRectangle(ball, target, -20, 20, 80, 220)
    const descriptor = buildAimDescriptor({
      hole: hole([surface('fairway', 'fairway', fairway)], { fairway: 'available' }),
      ball,
      target,
      aimPoint: inverseShotPoint(ball, target, 0, 150),
    })
    expectText(descriptor.text, 'Aim center fairway')
    expectContains(descriptor.contextFacts, '40 yd wide')
  }

  // Rotated 90 degrees: "right" must follow the golfer's shot frame, not global +X.
  {
    const ball: CoursePointYds = [0, 0]
    const target: CoursePointYds = [200, 0]
    const fairway = shotRectangle(ball, target, -20, 20, 80, 220)
    const descriptor = buildAimDescriptor({
      hole: hole([surface('fairway', 'fairway', fairway)], { fairway: 'available' }),
      ball,
      target,
      aimPoint: inverseShotPoint(ball, target, 15, 150),
    })
    expectText(descriptor.text, 'Aim right side fairway')
    expectContains(descriptor.contextFacts, '40 yd wide')
  }

  // Adjacent polygons are one playable corridor and must merge before zone/width language.
  {
    const ball: CoursePointYds = [0, 0]
    const target: CoursePointYds = [0, 200]
    const leftHalf = shotRectangle(ball, target, -20, 0, 80, 220)
    const rightHalf = shotRectangle(ball, target, 0, 20, 80, 220)
    const descriptor = buildAimDescriptor({
      hole: hole([
        surface('fairway-left-half', 'fairway', leftHalf),
        surface('fairway-right-half', 'fairway', rightHalf),
      ], { fairway: 'available' }),
      ball,
      target,
      aimPoint: inverseShotPoint(ball, target, 0, 150),
    })
    expectText(descriptor.text, 'Aim center fairway')
    expectContains(descriptor.contextFacts, '40 yd wide')
  }

  // Rotated approach: green front/right labels must also follow the current shot frame.
  {
    const ball: CoursePointYds = [10, -20]
    const target: CoursePointYds = [150, 120]
    const green = shotRectangle(ball, target, -15, 15, 170, 210)
    const descriptor = buildAimDescriptor({
      hole: hole([surface('green', 'green', green)], { green: 'available' }),
      ball,
      target,
      aimPoint: inverseShotPoint(ball, target, 11, 177),
      pin: null,
    })
    expectText(descriptor.text, 'Aim front-right green')
    expectContains(descriptor.contextFacts, '30 yd wide')
  }

  // Exact-pin language remains shot-frame relative on a rotated approach.
  {
    const ball: CoursePointYds = [0, 0]
    const target: CoursePointYds = [120, 120]
    const pin = inverseShotPoint(ball, target, 0, 170)
    const aimPoint = inverseShotPoint(ball, target, -8, 170)
    const descriptor = buildAimDescriptor({
      hole: hole([], {}, pin),
      ball,
      target,
      aimPoint,
      pin,
    })
    expectText(descriptor.text, 'Aim 8 yd left of the pin')
  }

  // Longitudinal pin shift should not be mislabeled as "at pin".
  {
    const ball: CoursePointYds = [0, 0]
    const target: CoursePointYds = [0, 170]
    const pin: CoursePointYds = [0, 170]
    const descriptor = buildAimDescriptor({
      hole: hole([], {}, pin),
      ball,
      target,
      aimPoint: [0, 167],
      pin,
    })
    expectText(descriptor.text, 'Aim 3 yd short of the pin')
  }

  // With no usable surfaces/pin, the fallback still describes the optimizer point geometrically.
  {
    const ball: CoursePointYds = [0, 0]
    const target: CoursePointYds = [0, 200]
    const descriptor = buildAimDescriptor({
      hole: hole([], {}),
      ball,
      target,
      aimPoint: [10, 150],
      aimOffsetYds: 10,
    })
    expectText(descriptor.text, 'Aim 10 yd right of center line')
    expectKind(descriptor.kind, 'centerline')
  }

  // Hazard context must describe an obstacle on the recommended line, not merely one nearby.
  {
    const ball: CoursePointYds = [0, 0]
    const target: CoursePointYds = [0, 220]
    const bunker = shotRectangle(ball, target, -8, 8, 185, 205)
    const descriptor = buildAimDescriptor({
      hole: hole([surface('center-bunker', 'bunker', bunker)], { bunker: 'available' }),
      ball,
      target,
      aimPoint: inverseShotPoint(ball, target, 0, 180),
    })
    expectKind(descriptor.kind, 'landmark')
    expectContains(descriptor.contextFacts, 'along the recommended line')
  }

  return true
}
