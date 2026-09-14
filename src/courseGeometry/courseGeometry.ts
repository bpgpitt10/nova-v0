import type {
  CourseFeatureKind,
  CourseGeometryFeature,
  CourseGeometryPackage,
  CourseHole,
  CoursePoint,
  HoleRenderFeature,
  HoleRenderModel,
  ShotObstructionAssessment,
} from './types'

const PACKAGE_URL = '/course-geometry/greywolf-v1.json?revision=environment-pilot-v1'

let packagePromise: Promise<CourseGeometryPackage> | null = null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export function validateCourseGeometryPackage(value: unknown): asserts value is CourseGeometryPackage {
  if (!isRecord(value) || value.schemaVersion !== 'looper.course_geometry_package.v1') {
    throw new Error('Unsupported course geometry package')
  }
  if (!Array.isArray(value.features) || !Array.isArray(value.holes) || value.holes.length !== 18) {
    throw new Error('Course geometry package is incomplete')
  }
  const holeOne = value.holes.find(
    (candidate) => isRecord(candidate) && candidate.number === 1,
  )
  const holeOneQuality =
    isRecord(holeOne) && isRecord(holeOne.quality) ? holeOne.quality : null
  if (
    value.generatorVersion !== 'course-geometry-compiler-v1.1' ||
    holeOneQuality?.environmentPilotActive !== true ||
    typeof holeOneQuality?.environmentFeatureCount !== 'number'
  ) {
    throw new Error('Course geometry package is stale; reload the latest preview')
  }
  const integration = isRecord(value.integrationContract) ? value.integrationContract : null
  const wind = integration && isRecord(integration.wind) ? integration.wind : null
  if (
    integration?.strategyAuthority !== false ||
    integration?.activation !== 'render-and-strategy-shadow-only' ||
    wind?.source !== 'gspro-screen-wind-panel' ||
    wind?.requiredForLiveDecisionSnapshot !== true ||
    wind?.failurePolicy !== 'unavailable-never-assume-calm' ||
    wind?.embeddedInStaticGeometry !== false
  ) {
    throw new Error('Course geometry package violates the live-state boundary')
  }
}

export function loadCourseGeometryPackage(): Promise<CourseGeometryPackage> {
  packagePromise ??= fetch(PACKAGE_URL, { cache: 'no-cache' }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Course geometry package failed to load (${response.status})`)
    }
    const payload: unknown = await response.json()
    validateCourseGeometryPackage(payload)
    return payload
  })
  return packagePromise
}

function toHoleLocal(point: CoursePoint, hole: CourseHole): CoursePoint {
  const tee = hole.anchors.selectedTee.coursePoint
  const green = hole.anchors.targetGreen.coursePoint
  const deltaX = green[0] - tee[0]
  const deltaY = green[1] - tee[1]
  const length = Math.hypot(deltaX, deltaY)
  if (length <= Number.EPSILON) {
    throw new Error(`Hole ${hole.number} has collapsed tee/green anchors`)
  }
  const forwardX = deltaX / length
  const forwardY = deltaY / length
  const rightX = forwardY
  const rightY = -forwardX
  const x = point[0] - tee[0]
  const y = point[1] - tee[1]
  return [x * rightX + y * rightY, x * forwardX + y * forwardY]
}

function polygonsForFeature(feature: CourseGeometryFeature, hole: CourseHole): CoursePoint[][][] {
  if (feature.geometry.type === 'Polygon') {
    return [
      feature.geometry.coordinates.map((ring) => ring.map((point) => toHoleLocal(point, hole))),
    ]
  }
  if (feature.geometry.type === 'MultiPolygon') {
    return feature.geometry.coordinates.map((polygon) =>
      polygon.map((ring) => ring.map((point) => toHoleLocal(point, hole))),
    )
  }
  return []
}

const renderedKinds = new Set(['rough', 'fairway', 'green', 'bunker', 'water', 'tee', 'woods', 'scrub', 'grass_context'])

export function buildHoleRenderModel(
  coursePackage: CourseGeometryPackage,
  holeNumber: number,
): HoleRenderModel {
  const hole = coursePackage.holes.find((candidate) => candidate.number === holeNumber)
  if (!hole) {
    throw new Error(`Course package has no Hole ${holeNumber}`)
  }
  const featureById = new Map(coursePackage.features.map((feature) => [feature.id, feature]))
  const features = hole.view.featureIds.flatMap<HoleRenderFeature>((featureId) => {
    const feature = featureById.get(featureId)
    if (!feature || !renderedKinds.has(feature.kind)) return []
    const polygons = polygonsForFeature(feature, hole)
    return polygons.length > 0 ? [{ id: feature.id, kind: feature.kind, role: feature.role, polygons }] : []
  })
  const counts: HoleRenderModel['counts'] = {
    rough: 0,
    fairway: 0,
    green: 0,
    bunker: 0,
    water: 0,
    tee: 0,
  }
  for (const feature of features) {
    if (feature.kind in counts) counts[feature.kind as keyof typeof counts] += 1
  }
  return {
    hole,
    bounds: hole.view.clipBounds,
    tee: [0, 0],
    targetGreen: toHoleLocal(hole.anchors.targetGreen.coursePoint, hole),
    route: hole.route.geometry.coordinates.map((point) => toHoleLocal(point, hole)),
    features,
    counts,
  }
}


function pointInRing(point: CoursePoint, ring: readonly CoursePoint[]): boolean {
  const [x, y] = point
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index]
    const [xj, yj] = ring[previous]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi) {
      inside = !inside
    }
  }
  return inside
}

function featureContainsPoint(feature: HoleRenderFeature, point: CoursePoint): boolean {
  return feature.polygons.some(
    (polygon) =>
      polygon.length > 0 &&
      pointInRing(point, polygon[0]) &&
      !polygon.slice(1).some((inner) => pointInRing(point, inner)),
  )
}

function orientation(a: CoursePoint, b: CoursePoint, c: CoursePoint): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function onSegment(a: CoursePoint, b: CoursePoint, point: CoursePoint): boolean {
  const epsilon = 1e-8
  return Math.abs(orientation(a, b, point)) <= epsilon &&
    point[0] >= Math.min(a[0], b[0]) - epsilon &&
    point[0] <= Math.max(a[0], b[0]) + epsilon &&
    point[1] >= Math.min(a[1], b[1]) - epsilon &&
    point[1] <= Math.max(a[1], b[1]) + epsilon
}

function segmentsIntersect(a: CoursePoint, b: CoursePoint, c: CoursePoint, d: CoursePoint): boolean {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  if ((abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0)) return true
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)
}

function featureIntersectsLine(feature: HoleRenderFeature, start: CoursePoint, target: CoursePoint): boolean {
  if (featureContainsPoint(feature, start) || featureContainsPoint(feature, target)) return true
  return feature.polygons.some((polygon) =>
    polygon.some((ring) =>
      ring.some((point, index) => index > 0 && segmentsIntersect(start, target, ring[index - 1], point)),
    ),
  )
}

const liePriority: CourseFeatureKind[] = ['green', 'tee', 'bunker', 'fairway', 'rough', 'water']

export function assessDirectShotObstruction(
  model: HoleRenderModel,
  ball: CoursePoint,
  target: CoursePoint = model.targetGreen,
): ShotObstructionAssessment {
  const lieSurface =
    liePriority.find((kind) =>
      model.features.some(
        (feature) =>
          feature.role === 'surface' && feature.kind === kind && featureContainsPoint(feature, ball),
      ),
    ) ?? null
  const obstructions = model.features.filter((feature) => feature.role === 'obstruction')
  const containing = obstructions.filter((feature) => featureContainsPoint(feature, ball))
  const blocking = obstructions.filter((feature) => featureIntersectsLine(feature, ball, target))
  return {
    mode: 'shadow-centerline-only',
    lieSurface,
    vegetationKinds: [...new Set(containing.map((feature) => feature.kind))],
    startsInsideVegetation: containing.length > 0,
    directLineCrossesVegetation: blocking.length > 0,
    blockingFeatureIds: blocking.map((feature) => feature.id),
  }
}
