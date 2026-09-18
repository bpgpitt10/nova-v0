import { getCourseCatalogEntry, type CourseId } from './courseCatalog'
import type {
  CourseContextKind,
  CourseContextLayer,
  CourseContourLine,
  CourseGeometryBounds,
  CourseGeometryProvenance,
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurface,
  CourseSurfaceKind,
  CourseTerrainGrid,
} from './types'

const SURFACE_KINDS: readonly CourseSurfaceKind[] = [
  'tee', 'fairway', 'rough', 'deep-rough', 'green', 'bunker', 'water', 'penalty',
]
const CONTEXT_KINDS: readonly CourseContextKind[] = ['woods', 'scrub', 'grass-context']
const FETCH_RETRY_DELAYS_MS = [0, 300, 900] as const

type RawBounds = { minX?: unknown; maxX?: unknown; minY?: unknown; maxY?: unknown }
type RawContour = { elevationFt?: unknown; points?: unknown }
type RawTerrain = {
  source?: unknown
  sourceResolutionMeters?: unknown
  runtimeSpacingYds?: unknown
  interpolation?: unknown
  minX?: unknown
  minY?: unknown
  width?: unknown
  height?: unknown
  elevationOffsetFt?: unknown
  nodata?: unknown
  compression?: unknown
  valuesBase64?: unknown
  note?: unknown
}
type RawRouteHole = {
  hole?: unknown
  par?: unknown
  referenceYards?: unknown
  coordinateFrame?: { origin?: unknown }
  viewBounds?: RawBounds
  surfaces?: unknown
  context?: unknown
  contours?: unknown
  terrain?: RawTerrain
}
type RawPackage = {
  schemaVersion?: unknown
  courseId?: unknown
  courseName?: unknown
  location?: unknown
  provenance?: unknown
  holes?: unknown
}

const packageCache = new Map<CourseId, Promise<RawPackage>>()
const holeCache = new Map<string, Promise<CourseHoleGeometry>>()

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const finiteInteger = (value: unknown): value is number => finite(value) && Number.isInteger(value)
const positiveInteger = (value: unknown): value is number => finiteInteger(value) && value > 0

const parsePoint = (value: unknown): CoursePointYds | null =>
  Array.isArray(value) && value.length >= 2 && finite(value[0]) && finite(value[1])
    ? [value[0], value[1]]
    : null

const parsePolygon = (value: unknown): CoursePolygonYds | null => {
  if (!Array.isArray(value)) return null
  const points = value.flatMap((candidate): CoursePointYds[] => {
    const point = parsePoint(candidate)
    return point ? [point] : []
  })
  return points.length >= 3 ? points : null
}

const parsePolygons = (value: unknown): CoursePolygonYds[] =>
  Array.isArray(value)
    ? value.flatMap((candidate): CoursePolygonYds[] => {
        const polygon = parsePolygon(candidate)
        return polygon ? [polygon] : []
      })
    : []

const parseRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const parseBounds = (value: RawBounds | undefined): CourseGeometryBounds | null => {
  if (
    !value ||
    !finite(value.minX) || !finite(value.maxX) ||
    !finite(value.minY) || !finite(value.maxY)
  ) return null
  return { minX: value.minX, maxX: value.maxX, minY: value.minY, maxY: value.maxY }
}

const boundsFromSurfaces = (surfaces: readonly CourseSurface[]): CourseGeometryBounds | null => {
  let minX = 0
  let maxX = 0
  let minY = 0
  let maxY = 0
  let found = false

  for (const surface of surfaces) {
    for (const polygon of surface.polygons) {
      for (const [x, y] of polygon) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        if (!found) {
          minX = Math.min(0, x)
          maxX = Math.max(0, x)
          minY = Math.min(0, y)
          maxY = Math.max(0, y)
          found = true
        } else {
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y)
        }
      }
    }
  }

  return found ? { minX, maxX, minY, maxY } : null
}

const centroid = (polygon: CoursePolygonYds): CoursePointYds => {
  const [x, y] = polygon.reduce(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]] as [number, number],
    [0, 0],
  )
  return polygon.length > 0 ? [x / polygon.length, y / polygon.length] : [0, 0]
}

const parseSurfaces = (
  courseId: CourseId,
  holeNumber: number,
  value: unknown,
): CourseSurface[] => {
  const raw = parseRecord(value)
  return SURFACE_KINDS.flatMap((kind): CourseSurface[] => {
    const polygons = parsePolygons(raw[kind])
    if (!polygons.length) return []
    return [{
      id: `${courseId}-h${String(holeNumber).padStart(2, '0')}-${kind}`,
      kind,
      polygons,
      provenance: {
        source: 'osm',
        sourceFeature: kind === 'water' ? 'cached OSM water geometry' : `golf=${kind}`,
        confidence: 'high',
        note: 'Compiled from the cached OSM golf=hole route package.',
      },
    }]
  })
}

const parseContextLayers = (
  courseId: CourseId,
  holeNumber: number,
  value: unknown,
): CourseContextLayer[] => {
  const raw = parseRecord(value)
  return CONTEXT_KINDS.flatMap((kind): CourseContextLayer[] => {
    const polygons = parsePolygons(raw[kind])
    if (!polygons.length) return []
    return [{
      id: `${courseId}-h${String(holeNumber).padStart(2, '0')}-${kind}`,
      kind,
      polygons,
      provenance: {
        source: 'osm',
        sourceFeature: `cached OSM ${kind} context`,
        confidence: 'high',
        note: 'Compiled from the cached OSM golf=hole route package.',
      },
    }]
  })
}

const parseContours = (value: unknown, courseName: string, holeNumber: number): CourseContourLine[] => {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${courseName} Hole ${holeNumber} contours were malformed.`)
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`${courseName} Hole ${holeNumber} contour ${index + 1} was malformed.`)
    }
    const raw = candidate as RawContour
    if (!finite(raw.elevationFt) || !Array.isArray(raw.points)) {
      throw new Error(`${courseName} Hole ${holeNumber} contour ${index + 1} was incomplete.`)
    }
    const points = raw.points.map((candidatePoint, pointIndex) => {
      const point = parsePoint(candidatePoint)
      if (!point) throw new Error(`${courseName} Hole ${holeNumber} contour ${index + 1} point ${pointIndex + 1} was invalid.`)
      return point
    })
    if (points.length < 2) throw new Error(`${courseName} Hole ${holeNumber} contour ${index + 1} had fewer than two points.`)
    return { elevationFt: raw.elevationFt, points }
  })
}

const decodeDeflateUint16 = async (
  valuesBase64: string,
  expectedValues: number,
  courseName: string,
  holeNumber: number,
): Promise<Uint16Array> => {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(`This browser does not support DecompressionStream required for ${courseName} Hole ${holeNumber} LiDAR terrain.`)
  }
  let binary: string
  try {
    binary = atob(valuesBase64)
  } catch {
    throw new Error(`${courseName} Hole ${holeNumber} terrain values were not valid base64.`)
  }
  const compressed = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) compressed[index] = binary.charCodeAt(index)
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'))
  const buffer = await new Response(stream).arrayBuffer()
  if (buffer.byteLength !== expectedValues * 2) {
    throw new Error(`${courseName} Hole ${holeNumber} terrain decoded ${buffer.byteLength} bytes; expected ${expectedValues * 2}.`)
  }
  const view = new DataView(buffer)
  const values = new Uint16Array(expectedValues)
  for (let index = 0; index < expectedValues; index += 1) values[index] = view.getUint16(index * 2, true)
  return values
}

const parseTerrain = async (
  raw: RawTerrain | undefined,
  courseName: string,
  holeNumber: number,
): Promise<CourseTerrainGrid | null> => {
  if (raw == null) return null
  if (
    raw.source !== 'lidar-dem' ||
    !finite(raw.sourceResolutionMeters) || raw.sourceResolutionMeters <= 0 ||
    !finite(raw.runtimeSpacingYds) || raw.runtimeSpacingYds <= 0 ||
    raw.interpolation !== 'bilinear' ||
    !finite(raw.minX) || !finite(raw.minY) ||
    !positiveInteger(raw.width) || !positiveInteger(raw.height) ||
    !finite(raw.elevationOffsetFt) || !finite(raw.nodata) ||
    raw.compression !== 'deflate' ||
    typeof raw.valuesBase64 !== 'string' || raw.valuesBase64.length === 0
  ) {
    throw new Error(`${courseName} Hole ${holeNumber} LiDAR terrain was present but invalid.`)
  }
  const values = await decodeDeflateUint16(raw.valuesBase64, raw.width * raw.height, courseName, holeNumber)
  return {
    source: 'lidar-dem',
    sourceResolutionMeters: raw.sourceResolutionMeters,
    runtimeSpacingYds: raw.runtimeSpacingYds,
    interpolation: 'bilinear',
    minX: raw.minX,
    minY: raw.minY,
    width: raw.width,
    height: raw.height,
    elevationOffsetFt: raw.elevationOffsetFt,
    nodata: raw.nodata,
    values,
    note: typeof raw.note === 'string' ? raw.note : undefined,
  }
}

const parseProvenance = (value: unknown): CourseGeometryProvenance => {
  const raw = parseRecord(value)
  return {
    geometrySource: typeof raw.geometrySource === 'string' ? raw.geometrySource : 'Cached OpenStreetMap course geometry',
    attribution: typeof raw.attribution === 'string' ? raw.attribution : '© OpenStreetMap contributors',
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : 'https://www.openstreetmap.org',
    copyrightUrl: typeof raw.copyrightUrl === 'string' ? raw.copyrightUrl : 'https://www.openstreetmap.org/copyright',
    license: typeof raw.license === 'string' ? raw.license : 'Open Database License (ODbL)',
    licenseUrl: typeof raw.licenseUrl === 'string' ? raw.licenseUrl : 'https://opendatacommons.org/licenses/odbl/1-0/',
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null,
    sourceBaseTimestamp: typeof raw.sourceBaseTimestamp === 'string' ? raw.sourceBaseTimestamp : null,
    sourceElementIdsComplete: typeof raw.sourceElementIdsComplete === 'boolean' ? raw.sourceElementIdsComplete : undefined,
    note: typeof raw.note === 'string' ? raw.note : undefined,
  }
}

const wait = (delayMs: number) =>
  delayMs <= 0 ? Promise.resolve() : new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs))

const fetchPackage = async (courseId: CourseId): Promise<RawPackage> => {
  const entry = getCourseCatalogEntry(courseId)
  if (!entry.staticPackageUrl) throw new Error(`${entry.name} does not use a generic static package.`)
  let lastError: unknown = null
  for (const delayMs of FETCH_RETRY_DELAYS_MS) {
    await wait(delayMs)
    try {
      const response = await fetch(entry.staticPackageUrl, { cache: 'force-cache' })
      if (!response.ok) throw new Error(`${entry.name} package returned ${response.status}.`)
      const payload = await response.json() as RawPackage
      if (payload.schemaVersion !== 'looper-static-course-package-v1') {
        throw new Error(`${entry.name} package schema was not looper-static-course-package-v1.`)
      }
      if (payload.courseId !== courseId) throw new Error(`${entry.name} package course id did not match ${courseId}.`)
      return payload
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${entry.name} package could not be loaded.`)
}

const loadPackage = (courseId: CourseId) => {
  const existing = packageCache.get(courseId)
  if (existing) return existing
  const promise = fetchPackage(courseId).catch((error) => {
    packageCache.delete(courseId)
    throw error
  })
  packageCache.set(courseId, promise)
  return promise
}

const parseHole = async (
  courseId: CourseId,
  payload: RawPackage,
  holeNumber: number,
): Promise<CourseHoleGeometry> => {
  if (!payload.holes || typeof payload.holes !== 'object') {
    throw new Error(`${String(payload.courseName ?? courseId)} package did not include holes.`)
  }
  const raw = (payload.holes as Record<string, RawRouteHole>)[String(holeNumber)]
  const courseName = typeof payload.courseName === 'string' ? payload.courseName : getCourseCatalogEntry(courseId).name
  if (!raw) throw new Error(`${courseName} Hole ${holeNumber} was not packaged.`)

  const surfaces = parseSurfaces(courseId, holeNumber, raw.surfaces)
  if (!surfaces.length) throw new Error(`${courseName} Hole ${holeNumber} has no playable surface geometry.`)
  const bounds = boundsFromSurfaces(surfaces)
  if (!bounds) throw new Error(`${courseName} Hole ${holeNumber} could not derive playable bounds.`)
  const viewBounds = parseBounds(raw.viewBounds)
  const contextLayers = parseContextLayers(courseId, holeNumber, raw.context)
  const contours = parseContours(raw.contours, courseName, holeNumber)
  const terrain = await parseTerrain(raw.terrain, courseName, holeNumber)
  const greenPolygons = surfaces.find((surface) => surface.kind === 'green')?.polygons ?? []
  const pin = greenPolygons
    .map((polygon) => centroid(polygon))
    .sort((left, right) => right[1] - left[1])[0]
  const available = (kind: CourseSurfaceKind) =>
    surfaces.some((surface) => surface.kind === kind) ? 'available' as const : 'unavailable' as const
  const origin = raw.coordinateFrame?.origin === 'osm-hole-route-start'
    ? 'osm-hole-route-start' as const
    : 'selected-tee' as const

  return {
    schemaVersion: 'looper-course-geometry-v1',
    courseId,
    courseName,
    location: typeof payload.location === 'string' ? payload.location : getCourseCatalogEntry(courseId).location,
    holeNumber: finiteInteger(raw.hole) ? raw.hole : holeNumber,
    par: finiteInteger(raw.par) ? raw.par : undefined,
    statedYardageYds: finite(raw.referenceYards) ? raw.referenceYards : undefined,
    coordinateSystem: { units: 'yards', origin, xAxis: 'right', yAxis: 'forward' },
    bounds,
    ...(viewBounds ? { viewBounds } : {}),
    markers: { tee: [0, 0], ...(pin ? { pin } : {}) },
    surfaces,
    ...(contextLayers.length ? { contextLayers } : {}),
    ...(contours.length ? { contours } : {}),
    ...(terrain ? { terrain } : {}),
    availability: {
      tee: available('tee'),
      fairway: available('fairway'),
      rough: available('rough'),
      'deep-rough': available('deep-rough'),
      green: available('green'),
      bunker: available('bunker'),
      water: available('water'),
      penalty: available('penalty'),
    },
    registration: {
      status: 'approximate',
      method: 'hole-local',
      sourceCoordinateSystem: 'cached OSM golf=hole route -> local yards',
      targetCoordinateSystem: 'looper-hole-local-yards',
      note: 'Hole-local frame is anchored to the cached OSM golf=hole route start and heading.',
    },
    provenance: parseProvenance(payload.provenance),
  }
}

export const loadRoutePackagedCourseHoleGeometry = async (
  courseId: CourseId,
  holeNumber: number,
): Promise<CourseHoleGeometry> => {
  const normalized = Math.max(1, Math.min(18, Math.round(holeNumber)))
  const key = `${courseId}:${normalized}`
  const existing = holeCache.get(key)
  if (existing) return existing
  const promise = loadPackage(courseId)
    .then((payload) => parseHole(courseId, payload, normalized))
    .catch((error) => {
      holeCache.delete(key)
      throw error
    })
  holeCache.set(key, promise)
  return promise
}
