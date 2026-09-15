import type {
  CourseContextLayer,
  CoursePointYds,
  CoursePolygonYds,
} from './types'

const ENVIRONMENT_PACKAGE_URL =
  'https://raw.githubusercontent.com/bpgpitt10/nova-v0/course-geometry-package-v1/public/course-geometry/greywolf-v1.json'

const ENVIRONMENT_KINDS = new Set(['woods', 'scrub', 'grass_context'])

type RawPoint = readonly [number, number]

type RawGeometry = {
  type: string
  coordinates?: unknown
}

type RawFeature = {
  id: string
  kind: string
  role: string
  geometry: RawGeometry
  osmId?: number
  sourceTags?: Record<string, string>
}

type RawHole = {
  number: number
  anchors: {
    selectedTee: { coursePoint: RawPoint }
    targetGreen: { coursePoint: RawPoint }
  }
  view: {
    featureIds: string[]
  }
}

type RawPackage = {
  features: RawFeature[]
  holes: RawHole[]
}

let environmentPromise: Promise<readonly CourseContextLayer[]> | null = null

const isRawPoint = (value: unknown): value is RawPoint =>
  Array.isArray(value) &&
  value.length >= 2 &&
  typeof value[0] === 'number' &&
  Number.isFinite(value[0]) &&
  typeof value[1] === 'number' &&
  Number.isFinite(value[1])

const toHoleLocal = (point: RawPoint, hole: RawHole): CoursePointYds => {
  const tee = hole.anchors.selectedTee.coursePoint
  const green = hole.anchors.targetGreen.coursePoint
  const deltaX = green[0] - tee[0]
  const deltaY = green[1] - tee[1]
  const length = Math.hypot(deltaX, deltaY)
  if (length <= Number.EPSILON) return [0, 0]

  const forwardX = deltaX / length
  const forwardY = deltaY / length
  const rightX = forwardY
  const rightY = -forwardX
  const x = point[0] - tee[0]
  const y = point[1] - tee[1]
  return [x * rightX + y * rightY, x * forwardX + y * forwardY]
}

const ringsToPolygon = (rings: unknown, hole: RawHole): CoursePolygonYds | null => {
  if (!Array.isArray(rings) || !Array.isArray(rings[0])) return null
  const points = rings[0]
    .filter(isRawPoint)
    .map((point) => toHoleLocal(point, hole))
  return points.length >= 3 ? points : null
}

const polygonsForFeature = (feature: RawFeature, hole: RawHole): CoursePolygonYds[] => {
  const coordinates = feature.geometry.coordinates
  if (feature.geometry.type === 'Polygon') {
    const polygon = ringsToPolygon(coordinates, hole)
    return polygon ? [polygon] : []
  }
  if (feature.geometry.type === 'MultiPolygon' && Array.isArray(coordinates)) {
    return coordinates.flatMap((rings) => {
      const polygon = ringsToPolygon(rings, hole)
      return polygon ? [polygon] : []
    })
  }
  return []
}

const contextKind = (kind: string): CourseContextLayer['kind'] | null => {
  if (kind === 'woods') return 'woods'
  if (kind === 'scrub') return 'scrub'
  if (kind === 'grass_context') return 'grass-context'
  return null
}

const loadEnvironment = async (): Promise<readonly CourseContextLayer[]> => {
  try {
    const response = await fetch(ENVIRONMENT_PACKAGE_URL, { cache: 'force-cache' })
    if (!response.ok) return []

    const payload = await response.json() as RawPackage
    if (!Array.isArray(payload.features) || !Array.isArray(payload.holes)) return []

    const hole = payload.holes.find((candidate) => candidate.number === 1)
    if (!hole || !Array.isArray(hole.view?.featureIds)) return []

    const requestedIds = new Set(hole.view.featureIds)
    return payload.features.flatMap((feature): CourseContextLayer[] => {
      if (!requestedIds.has(feature.id) || !ENVIRONMENT_KINDS.has(feature.kind)) return []
      const kind = contextKind(feature.kind)
      if (!kind) return []
      const polygons = polygonsForFeature(feature, hole)
      if (polygons.length === 0) return []

      return [{
        id: feature.id,
        kind,
        polygons,
        provenance: {
          source: 'osm',
          sourceFeature: feature.kind,
          sourceIds: feature.osmId == null ? undefined : [feature.osmId],
          confidence: 'high',
          note: 'Approved Greywolf environment pilot geometry from course-geometry-package-v1.',
        },
      }]
    })
  } catch (error) {
    console.warn('[Greywolf geometry] vegetation context unavailable; continuing with playable surfaces only.', error)
    return []
  }
}

export const loadGreywolfHoleOneContext = (): Promise<readonly CourseContextLayer[]> => {
  environmentPromise ??= loadEnvironment()
  return environmentPromise
}
