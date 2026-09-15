import type {
  CourseContextLayer,
  CoursePointYds,
  CoursePolygonYds,
} from './types'

const ENVIRONMENT_PACKAGE_URL = '/course-geometry/greywolf/environment-v1.json'

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

let packagePromise: Promise<RawPackage> | null = null
const environmentByHole = new Map<number, Promise<readonly CourseContextLayer[]>>()

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

const fetchEnvironmentPackage = async (): Promise<RawPackage> => {
  const response = await fetch(ENVIRONMENT_PACKAGE_URL, { cache: 'force-cache' })
  if (!response.ok) {
    throw new Error(`Greywolf environment package returned ${response.status}.`)
  }

  const payload = await response.json() as RawPackage
  if (!Array.isArray(payload.features) || !Array.isArray(payload.holes)) {
    throw new Error('Greywolf environment package did not contain features and holes arrays.')
  }
  return payload
}

const loadEnvironmentPackage = (): Promise<RawPackage> => {
  if (!packagePromise) {
    packagePromise = fetchEnvironmentPackage().catch((error) => {
      // Never preserve a failed fetch as a successful empty package. The next
      // caller gets a fresh attempt, while this caller sees the real failure.
      packagePromise = null
      console.warn('[Greywolf geometry] vegetation context package failed to load.', error)
      throw error
    })
  }
  return packagePromise
}

const loadEnvironment = async (holeNumber: number): Promise<readonly CourseContextLayer[]> => {
  const payload = await loadEnvironmentPackage()
  const hole = payload.holes.find((candidate) => candidate.number === holeNumber)
  if (!hole) {
    throw new Error(`Greywolf environment package is missing Hole ${holeNumber}.`)
  }
  if (!Array.isArray(hole.view?.featureIds)) {
    throw new Error(`Greywolf environment package Hole ${holeNumber} is missing view.featureIds.`)
  }

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
        note: 'Greywolf environment geometry cached with the canonical course branch.',
      },
    }]
  })
}

export const loadGreywolfHoleContext = (holeNumber: number): Promise<readonly CourseContextLayer[]> => {
  const normalized = Math.max(1, Math.min(18, Math.round(holeNumber)))
  const existing = environmentByHole.get(normalized)
  if (existing) return existing

  const promise = loadEnvironment(normalized).catch((error) => {
    // A failed context load must not poison the per-hole cache. The canonical
    // course adapter will also drop its hole cache and retry cleanly.
    environmentByHole.delete(normalized)
    throw error
  })
  environmentByHole.set(normalized, promise)
  return promise
}

// Compatibility alias while older proof screens still refer to the Hole 1-specific name.
export const loadGreywolfHoleOneContext = (): Promise<readonly CourseContextLayer[]> =>
  loadGreywolfHoleContext(1)
