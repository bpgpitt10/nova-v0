import { getCourseCatalogEntry, type CourseId } from './courseCatalog'
import type {
  CourseContextKind,
  CourseContextLayer,
  CourseContourLine,
  CourseCoordinateOrigin,
  CourseGeometryBounds,
  CourseGeometryProvenance,
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseRegistration,
  CourseSurface,
  CourseSurfaceKind,
  CourseTerrainGrid,
} from './types'

const SURFACE_KINDS = new Set<CourseSurfaceKind>([
  'tee', 'fairway', 'rough', 'deep-rough', 'green', 'bunker', 'water', 'penalty',
])
const CONTEXT_KINDS = new Set<CourseContextKind>(['woods', 'scrub', 'grass-context'])
const FETCH_RETRY_DELAYS_MS = [0, 300, 900] as const

type RawBounds = { minX?: unknown; maxX?: unknown; minY?: unknown; maxY?: unknown }

type RawLayer = {
  id?: unknown
  kind?: unknown
  polygons?: unknown
  sourceFeature?: unknown
  sourceIds?: unknown
  confidence?: unknown
  note?: unknown
}

type RawContour = {
  elevationFt?: unknown
  points?: unknown
}

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

type RawHole = {
  holeNumber?: unknown
  par?: unknown
  statedYardageYds?: unknown
  coordinateSystem?: { origin?: unknown }
  bounds?: RawBounds
  viewBounds?: RawBounds
  markers?: { tee?: unknown; pin?: unknown }
  surfaces?: unknown
  contextLayers?: unknown
  contours?: unknown
  terrain?: RawTerrain
  registration?: unknown
}

type RawPackage = {
  schemaVersion?: unknown
  courseId?: unknown
  courseName?: unknown
  location?: unknown
  provenance?: unknown
  terrainProvenance?: unknown
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

const parseBounds = (value: RawBounds | undefined): CourseGeometryBounds | null => {
  if (
    !value ||
    !finite(value.minX) || !finite(value.maxX) ||
    !finite(value.minY) || !finite(value.maxY)
  ) return null
  return {
    minX: value.minX,
    maxX: value.maxX,
    minY: value.minY,
    maxY: value.maxY,
  }
}

const parsePolygon = (value: unknown): CoursePolygonYds | null => {
  if (!Array.isArray(value)) return null
  const points = value.flatMap((candidate): CoursePointYds[] => {
    const parsed = parsePoint(candidate)
    return parsed ? [parsed] : []
  })
  return points.length >= 3 ? points : null
}

const parsePolygons = (value: unknown): CoursePolygonYds[] =>
  Array.isArray(value)
    ? value.flatMap((candidate): CoursePolygonYds[] => {
        const parsed = parsePolygon(candidate)
        return parsed ? [parsed] : []
      })
    : []

const parseSourceIds = (value: unknown): readonly (string | number)[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const ids = value.filter((candidate): candidate is string | number =>
    typeof candidate === 'string' || finite(candidate),
  )
  return ids.length ? ids : undefined
}

const parseConfidence = (value: unknown) =>
  value === 'high' || value === 'medium' || value === 'low' || value === 'unknown'
    ? value
    : 'high'

const parseCoordinateOrigin = (value: unknown): CourseCoordinateOrigin =>
  value === 'osm-hole-route-start' ? value : 'selected-tee'

const parseSurface = (raw: RawLayer): CourseSurface | null => {
  if (typeof raw.id !== 'string' || !SURFACE_KINDS.has(raw.kind as CourseSurfaceKind)) return null
  const parsedPolygons = parsePolygons(raw.polygons)
  if (!parsedPolygons.length) return null
  const kind = raw.kind as CourseSurfaceKind
  return {
    id: raw.id,
    kind,
    polygons: parsedPolygons,
    provenance: {
      source: 'osm',
      sourceFeature: typeof raw.sourceFeature === 'string' ? raw.sourceFeature : `golf=${kind}`,
      sourceIds: parseSourceIds(raw.sourceIds),
      confidence: parseConfidence(raw.confidence),
      note: typeof raw.note === 'string' ? raw.note : undefined,
    },
  }
}

const parseContext = (raw: RawLayer): CourseContextLayer | null => {
  if (typeof raw.id !== 'string' || !CONTEXT_KINDS.has(raw.kind as CourseContextKind)) return null
  const parsedPolygons = parsePolygons(raw.polygons)
  if (!parsedPolygons.length) return null
  const kind = raw.kind as CourseContextKind
  return {
    id: raw.id,
    kind,
    polygons: parsedPolygons,
    provenance: {
      source: 'osm',
      sourceFeature: typeof raw.sourceFeature === 'string' ? raw.sourceFeature : kind,
      sourceIds: parseSourceIds(raw.sourceIds),
      confidence: parseConfidence(raw.confidence),
      note: typeof raw.note === 'string' ? raw.note : undefined,
    },
  }
}

const parseContours = (value: unknown, courseName: string, holeNumber: number): CourseContourLine[] => {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw new Error(`${courseName} Hole ${holeNumber} contours were present but malformed.`)
  }

  return value.map((candidate, index): CourseContourLine => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`${courseName} Hole ${holeNumber} contour ${index + 1} was malformed.`)
    }
    const raw = candidate as RawContour
    if (!finite(raw.elevationFt) || !Array.isArray(raw.points)) {
      throw new Error(`${courseName} Hole ${holeNumber} contour ${index + 1} was incomplete.`)
    }
    const points = raw.points.map((point, pointIndex) => {
      const parsed = parsePoint(point)
      if (!parsed) {
        throw new Error(
          `${courseName} Hole ${holeNumber} contour ${index + 1} point ${pointIndex + 1} was invalid.`,
        )
      }
      return parsed
    })
    if (points.length < 2) {
      throw new Error(`${courseName} Hole ${holeNumber} contour ${index + 1} had fewer than two points.`)
    }
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
    throw new Error(
      `This browser does not support DecompressionStream required for ${courseName} Hole ${holeNumber} LiDAR terrain.`,
    )
  }

  let binary: string
  try {
    binary = atob(valuesBase64)
  } catch {
    throw new Error(`${courseName} Hole ${holeNumber} terrain values were not valid base64.`)
  }

  const compressed = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    compressed[index] = binary.charCodeAt(index)
  }

  let buffer: ArrayBuffer
  try {
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'))
    buffer = await new Response(stream).arrayBuffer()
  } catch {
    throw new Error(`${courseName} Hole ${holeNumber} terrain grid could not be decompressed.`)
  }

  if (buffer.byteLength !== expectedValues * 2) {
    throw new Error(
      `${courseName} Hole ${holeNumber} terrain decoded ${buffer.byteLength} bytes; expected ${expectedValues * 2}.`,
    )
  }

  // Static-package terrain uses the same proven wire format as Greywolf:
  // deflated little-endian uint16 values, decoded explicitly for portability.
  const view = new DataView(buffer)
  const values = new Uint16Array(expectedValues)
  for (let index = 0; index < expectedValues; index += 1) {
    values[index] = view.getUint16(index * 2, true)
  }
  return values
}

const parseTerrain = async (
  raw: RawTerrain | undefined,
  courseName: string,
  holeNumber: number,
): Promise<CourseTerrainGrid | null> => {
  if (raw == null) return null

  if (
    raw.source !== 'lidar-dem'
    || !finite(raw.sourceResolutionMeters)
    || raw.sourceResolutionMeters <= 0
    || !finite(raw.runtimeSpacingYds)
    || raw.runtimeSpacingYds <= 0
    || raw.interpolation !== 'bilinear'
    || !finite(raw.minX)
    || !finite(raw.minY)
    || !positiveInteger(raw.width)
    || !positiveInteger(raw.height)
    || !finite(raw.elevationOffsetFt)
    || !finite(raw.nodata)
    || raw.compression !== 'deflate'
    || typeof raw.valuesBase64 !== 'string'
    || raw.valuesBase64.length === 0
  ) {
    throw new Error(`${courseName} Hole ${holeNumber} LiDAR terrain was present but incomplete or invalid.`)
  }

  const values = await decodeDeflateUint16(
    raw.valuesBase64,
    raw.width * raw.height,
    courseName,
    holeNumber,
  )

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

const parseRegistration = (value: unknown): CourseRegistration => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const status = raw.status === 'verified' || raw.status === 'approximate' || raw.status === 'unavailable'
    ? raw.status
    : 'approximate'
  const method = raw.method === 'course-wide-similarity' || raw.method === 'hole-local' || raw.method === 'manual' || raw.method === 'other'
    ? raw.method
    : 'hole-local'
  return {
    status,
    method,
    sourceCoordinateSystem: typeof raw.sourceCoordinateSystem === 'string'
      ? raw.sourceCoordinateSystem
      : 'cached OSM package -> local yards',
    targetCoordinateSystem: 'looper-hole-local-yards',
    note: typeof raw.note === 'string' ? raw.note : undefined,
  }
}

const parseProvenance = (value: unknown): CourseGeometryProvenance => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    geometrySource: typeof raw.geometrySource === 'string'
      ? raw.geometrySource
      : 'Pre-generated OpenStreetMap course package',
    attribution: typeof raw.attribution === 'string' ? raw.attribution : '© OpenStreetMap contributors',
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : 'https://www.openstreetmap.org',
    copyrightUrl: typeof raw.copyrightUrl === 'string' ? raw.copyrightUrl : 'https://www.openstreetmap.org/copyright',
    license: typeof raw.license === 'string' ? raw.license : 'Open Database License (ODbL)',
    licenseUrl: typeof raw.licenseUrl === 'string' ? raw.licenseUrl : 'https://opendatacommons.org/licenses/odbl/1-0/',
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null,
    sourceBaseTimestamp: typeof raw.sourceBaseTimestamp === 'string' ? raw.sourceBaseTimestamp : null,
    sourceElementIdsComplete: typeof raw.sourceElementIdsComplete === 'boolean'
      ? raw.sourceElementIdsComplete
      : undefined,
    note: typeof raw.note === 'string' ? raw.note : undefined,
  }
}

const wait = (delayMs: number) =>
  delayMs <= 0 ? Promise.resolve() : new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))

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
      if (payload.courseId !== courseId) {
        throw new Error(`${entry.name} package course id did not match ${courseId}.`)
      }
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
  const raw = (payload.holes as Record<string, RawHole>)[String(holeNumber)]
  const courseName = typeof payload.courseName === 'string'
    ? payload.courseName
    : getCourseCatalogEntry(courseId).name
  if (!raw) throw new Error(`${courseName} Hole ${holeNumber} was not packaged.`)

  const bounds = parseBounds(raw.bounds)
  if (!bounds) {
    throw new Error(`${courseName} Hole ${holeNumber} has invalid bounds.`)
  }
  const viewBounds = parseBounds(raw.viewBounds)

  const tee = parsePoint(raw.markers?.tee)
  const pin = parsePoint(raw.markers?.pin)
  if (!tee) throw new Error(`${courseName} Hole ${holeNumber} has no tee/origin anchor.`)

  const surfaces = (Array.isArray(raw.surfaces) ? raw.surfaces as RawLayer[] : [])
    .flatMap((candidate): CourseSurface[] => {
      const parsed = parseSurface(candidate)
      return parsed ? [parsed] : []
    })
  const contextLayers = (Array.isArray(raw.contextLayers) ? raw.contextLayers as RawLayer[] : [])
    .flatMap((candidate): CourseContextLayer[] => {
      const parsed = parseContext(candidate)
      return parsed ? [parsed] : []
    })
  const contours = parseContours(raw.contours, courseName, holeNumber)
  const terrain = await parseTerrain(raw.terrain, courseName, holeNumber)
  const available = (kind: CourseSurfaceKind) =>
    surfaces.some((surface) => surface.kind === kind) ? 'available' as const : 'unavailable' as const

  return {
    schemaVersion: 'looper-course-geometry-v1',
    courseId,
    courseName,
    location: typeof payload.location === 'string' ? payload.location : getCourseCatalogEntry(courseId).location,
    holeNumber: finiteInteger(raw.holeNumber) ? raw.holeNumber : holeNumber,
    par: finiteInteger(raw.par) ? raw.par : undefined,
    statedYardageYds: finite(raw.statedYardageYds) ? raw.statedYardageYds : undefined,
    coordinateSystem: {
      units: 'yards',
      origin: parseCoordinateOrigin(raw.coordinateSystem?.origin),
      xAxis: 'right',
      yAxis: 'forward',
    },
    bounds,
    ...(viewBounds ? { viewBounds } : {}),
    markers: { tee, ...(pin ? { pin } : {}) },
    surfaces,
    ...(contextLayers.length ? { contextLayers } : {}),
    ...(contours.length ? { contours } : {}),
    ...(terrain ? { terrain } : {}),
    availability: {
      tee: available('tee'),
      fairway: available('fairway'),
      rough: available('rough'),
      'deep-rough': 'unavailable',
      green: available('green'),
      bunker: available('bunker'),
      water: available('water'),
      penalty: 'unavailable',
    },
    registration: parseRegistration(raw.registration),
    provenance: parseProvenance(payload.provenance),
  }
}

export const loadPackagedCourseHoleGeometry = (
  courseId: CourseId,
  holeNumber: number,
): Promise<CourseHoleGeometry> => {
  const normalizedHole = Math.max(1, Math.min(18, Math.round(holeNumber)))
  const key = `${courseId}:${normalizedHole}`
  const existing = holeCache.get(key)
  if (existing) return existing

  const promise = loadPackage(courseId)
    .then((payload) => parseHole(courseId, payload, normalizedHole))
    .catch((error) => {
      holeCache.delete(key)
      throw error
    })
  holeCache.set(key, promise)
  return promise
}
