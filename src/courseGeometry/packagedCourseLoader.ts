import { getCourseCatalogEntry, type CourseId } from './courseCatalog'
import type {
  CourseContextKind,
  CourseContextLayer,
  CourseCoordinateOrigin,
  CourseGeometryProvenance,
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseRegistration,
  CourseSurface,
  CourseSurfaceKind,
} from './types'

const SURFACE_KINDS = new Set<CourseSurfaceKind>([
  'tee', 'fairway', 'rough', 'deep-rough', 'green', 'bunker', 'water', 'penalty',
])
const CONTEXT_KINDS = new Set<CourseContextKind>(['woods', 'scrub', 'grass-context'])
const FETCH_RETRY_DELAYS_MS = [0, 300, 900] as const

type RawLayer = {
  id?: unknown
  kind?: unknown
  polygons?: unknown
  sourceFeature?: unknown
  sourceIds?: unknown
  confidence?: unknown
  note?: unknown
}

type RawHole = {
  holeNumber?: unknown
  par?: unknown
  statedYardageYds?: unknown
  coordinateSystem?: { origin?: unknown }
  bounds?: { minX?: unknown; maxX?: unknown; minY?: unknown; maxY?: unknown }
  markers?: { tee?: unknown; pin?: unknown }
  surfaces?: unknown
  contextLayers?: unknown
  registration?: unknown
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

const parsePoint = (value: unknown): CoursePointYds | null =>
  Array.isArray(value) && value.length >= 2 && finite(value[0]) && finite(value[1])
    ? [value[0], value[1]]
    : null

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

const parseHole = (courseId: CourseId, payload: RawPackage, holeNumber: number): CourseHoleGeometry => {
  if (!payload.holes || typeof payload.holes !== 'object') {
    throw new Error(`${String(payload.courseName ?? courseId)} package did not include holes.`)
  }
  const raw = (payload.holes as Record<string, RawHole>)[String(holeNumber)]
  if (!raw) throw new Error(`${String(payload.courseName ?? courseId)} Hole ${holeNumber} was not packaged.`)

  const rawBounds = raw.bounds
  if (
    !rawBounds ||
    !finite(rawBounds.minX) || !finite(rawBounds.maxX) ||
    !finite(rawBounds.minY) || !finite(rawBounds.maxY)
  ) {
    throw new Error(`${String(payload.courseName ?? courseId)} Hole ${holeNumber} has invalid bounds.`)
  }
  const bounds = {
    minX: rawBounds.minX,
    maxX: rawBounds.maxX,
    minY: rawBounds.minY,
    maxY: rawBounds.maxY,
  }

  const tee = parsePoint(raw.markers?.tee)
  const pin = parsePoint(raw.markers?.pin)
  if (!tee) throw new Error(`${String(payload.courseName ?? courseId)} Hole ${holeNumber} has no tee/origin anchor.`)

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
  const available = (kind: CourseSurfaceKind) =>
    surfaces.some((surface) => surface.kind === kind) ? 'available' as const : 'unavailable' as const

  return {
    schemaVersion: 'looper-course-geometry-v1',
    courseId,
    courseName: typeof payload.courseName === 'string' ? payload.courseName : getCourseCatalogEntry(courseId).name,
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
    markers: { tee, ...(pin ? { pin } : {}) },
    surfaces,
    ...(contextLayers.length ? { contextLayers } : {}),
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
