import type {
  CourseGeometryFeature,
  CourseGeometryPackage,
  CourseHole,
  CoursePoint,
  HoleRenderFeature,
  HoleRenderModel,
} from './types'

const PACKAGE_URL = '/course-geometry/greywolf-v1.json'

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
  packagePromise ??= fetch(PACKAGE_URL, { cache: 'force-cache' }).then(async (response) => {
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

const renderedKinds = new Set(['rough', 'fairway', 'green', 'bunker', 'water', 'tee'])

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
    return polygons.length > 0 ? [{ id: feature.id, kind: feature.kind, polygons }] : []
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
