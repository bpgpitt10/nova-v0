import { greywolfHole01Geometry } from './greywolfHole01'
import { loadGreywolfHoleContext } from './greywolfEnvironment'
import { loadGreywolfHoleTerrain } from './greywolfTerrain'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurface,
  CourseSurfaceKind,
} from './types'

type RawPoint = {
  right_yards?: unknown
  forward_yards?: unknown
}

type RawFeature = {
  osm_id?: string | number | null
  golf?: string | null
  polygon?: RawPoint[]
}

type RawGreywolfHole = {
  course?: string
  anchors?: {
    tee_to_green_centroid_yards?: number
  }
  bounds?: {
    min_right_yards?: number
    max_right_yards?: number
    min_forward_yards?: number
    max_forward_yards?: number
  }
  features?: Partial<Record<'tee' | 'fairway' | 'rough' | 'green' | 'bunker' | 'water', RawFeature[]>>
}

const RAW_BASE = '/course-geometry/greywolf/local-geometry'

const kindOrder = ['tee', 'fairway', 'rough', 'green', 'bunker', 'water'] as const
const FETCH_RETRY_DELAYS_MS = [0, 300, 900] as const

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const polygonFromRaw = (polygon: RawPoint[] | undefined): CoursePolygonYds | null => {
  if (!polygon) return null
  const points = polygon.flatMap((point): CoursePointYds[] =>
    finite(point.right_yards) && finite(point.forward_yards)
      ? [[point.right_yards, point.forward_yards]]
      : [],
  )
  return points.length >= 3 ? points : null
}

const centroid = (polygon: CoursePolygonYds): CoursePointYds => {
  if (polygon.length === 0) return [0, 0]
  const [x, y] = polygon.reduce(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]] as [number, number],
    [0, 0],
  )
  return [x / polygon.length, y / polygon.length]
}

const sourceFeatureFor = (kind: CourseSurfaceKind) => {
  switch (kind) {
    case 'water':
      return 'OSM water geometry'
    default:
      return `golf=${kind}`
  }
}

const surfaceFromRaw = (
  holeNumber: number,
  kind: CourseSurfaceKind,
  features: RawFeature[] | undefined,
): CourseSurface | null => {
  if (!features || features.length === 0) return null
  const polygons = features.flatMap((feature) => {
    const polygon = polygonFromRaw(feature.polygon)
    return polygon ? [polygon] : []
  })
  if (polygons.length === 0) return null

  return {
    id: `greywolf-h${String(holeNumber).padStart(2, '0')}-${kind}`,
    kind,
    polygons,
    provenance: {
      source: 'osm',
      sourceFeature: sourceFeatureFor(kind),
      sourceIds: features.flatMap((feature) =>
        feature.osm_id == null ? [] : [feature.osm_id],
      ),
      confidence: 'high',
      note: 'Pre-generated Greywolf local-yard OSM course package cached with the canonical course branch.',
    },
  }
}

const parseHole = (holeNumber: number, raw: RawGreywolfHole): CourseHoleGeometry => {
  const surfaces = kindOrder.flatMap((kind) => {
    const surface = surfaceFromRaw(holeNumber, kind, raw.features?.[kind])
    return surface ? [surface] : []
  })
  const green = surfaces.find((surface) => surface.kind === 'green')?.polygons[0]
  const pin = green ? centroid(green) : undefined
  const bounds = raw.bounds

  if (
    !bounds ||
    !finite(bounds.min_right_yards) ||
    !finite(bounds.max_right_yards) ||
    !finite(bounds.min_forward_yards) ||
    !finite(bounds.max_forward_yards)
  ) {
    throw new Error(`Greywolf Hole ${holeNumber} geometry did not include valid bounds.`)
  }

  const availability = {
    tee: surfaces.some((surface) => surface.kind === 'tee') ? 'available' : 'unavailable',
    fairway: surfaces.some((surface) => surface.kind === 'fairway') ? 'available' : 'unavailable',
    rough: surfaces.some((surface) => surface.kind === 'rough') ? 'available' : 'unavailable',
    'deep-rough': 'unavailable',
    green: surfaces.some((surface) => surface.kind === 'green') ? 'available' : 'unavailable',
    bunker: surfaces.some((surface) => surface.kind === 'bunker') ? 'available' : 'unavailable',
    water: surfaces.some((surface) => surface.kind === 'water') ? 'available' : 'unavailable',
    penalty: 'unavailable',
  } as const

  return {
    schemaVersion: 'looper-course-geometry-v1',
    courseId: 'greywolf-panorama-bc',
    courseName: raw.course ?? 'Greywolf Golf Course',
    location: 'Panorama, BC',
    holeNumber,
    statedYardageYds: raw.anchors?.tee_to_green_centroid_yards,
    coordinateSystem: {
      units: 'yards',
      origin: 'selected-tee',
      xAxis: 'right',
      yAxis: 'forward',
    },
    bounds: {
      minX: bounds.min_right_yards,
      maxX: bounds.max_right_yards,
      minY: bounds.min_forward_yards,
      maxY: bounds.max_forward_yards,
    },
    markers: {
      tee: [0, 0],
      ...(pin ? { pin } : {}),
    },
    surfaces,
    availability,
    registration: {
      status: 'verified',
      method: 'course-wide-similarity',
      sourceCoordinateSystem: 'Greywolf OSM course registration -> selected-tee local yards',
      targetCoordinateSystem: 'looper-hole-local-yards',
      residualsMeters: {
        mean: 2.3293518340982975,
        median: 2.502103872679028,
        max: 4.583575624766918,
      },
      validation: {
        testedEndpoints: 40,
        exactSurfaceMatches: 38,
        endpointsWithin2m: 40,
      },
      note: 'Loaded from the proven Greywolf all-hole local geometry package.',
    },
    provenance: {
      geometrySource: 'Greywolf pre-generated OSM local geometry package',
      attribution: '© OpenStreetMap contributors',
      sourceUrl: 'https://www.openstreetmap.org',
      copyrightUrl: 'https://www.openstreetmap.org/copyright',
      license: 'Open Database License (ODbL)',
      licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
      note:
        'Runtime geometry is served from the canonical course cache; OSM is queried only during package generation/refresh.',
    },
  }
}

const cache = new Map<number, Promise<CourseHoleGeometry>>()

const wait = (delayMs: number) =>
  delayMs <= 0 ? Promise.resolve() : new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))

const fetchRawHole = async (holeNumber: number): Promise<RawGreywolfHole> => {
  let lastError: unknown = null

  for (const delayMs of FETCH_RETRY_DELAYS_MS) {
    await wait(delayMs)
    try {
      const response = await fetch(`${RAW_BASE}/greywolf-hole-${String(holeNumber).padStart(2, '0')}.json`, { cache: 'force-cache' })
      if (!response.ok) {
        throw new Error(`Greywolf Hole ${holeNumber} package returned ${response.status}.`)
      }
      return await response.json() as RawGreywolfHole
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Greywolf Hole ${holeNumber} package could not be loaded.`)
}

const attachSupplementalGeometry = async (
  holeNumber: number,
  geometry: CourseHoleGeometry,
): Promise<CourseHoleGeometry> => {
  const [contextLayers, terrainData] = await Promise.all([
    loadGreywolfHoleContext(holeNumber),
    loadGreywolfHoleTerrain(holeNumber),
  ])

  return {
    ...geometry,
    ...(contextLayers.length > 0 ? { contextLayers } : {}),
    ...(terrainData
      ? {
          terrain: terrainData.terrain,
          contours: terrainData.contours.length > 0
            ? terrainData.contours
            : geometry.contours,
        }
      : {}),
  }
}

const loadHole = async (holeNumber: number): Promise<CourseHoleGeometry> => {
  const geometry = holeNumber === 1
    ? greywolfHole01Geometry
    : parseHole(holeNumber, await fetchRawHole(holeNumber))
  return attachSupplementalGeometry(holeNumber, geometry)
}

export const loadGreywolfHoleGeometryAdapter = (holeNumber: number): Promise<CourseHoleGeometry> => {
  const normalized = Math.max(1, Math.min(18, Math.round(holeNumber)))
  const existing = cache.get(normalized)
  if (existing) return existing

  const promise = loadHole(normalized)
    .catch((error) => {
      cache.delete(normalized)
      throw error
    })

  cache.set(normalized, promise)
  return promise
}
