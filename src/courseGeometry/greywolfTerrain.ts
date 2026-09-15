import type {
  CourseContourLine,
  CoursePointYds,
  CourseTerrainGrid,
} from './types'

const TERRAIN_PACKAGE_URL = '/course-geometry/greywolf-terrain-v1.json'

type RawTerrainGrid = {
  minX?: unknown
  minY?: unknown
  spacingYds?: unknown
  width?: unknown
  height?: unknown
  elevationOffsetFt?: unknown
  compression?: unknown
  valuesBase64?: unknown
}

type RawContour = {
  elevationFt?: unknown
  points?: unknown
}

type RawTerrainHole = {
  grid?: RawTerrainGrid
  contours?: RawContour[]
}

type RawTerrainPackage = {
  schemaVersion?: unknown
  source?: {
    sourceResolutionMeters?: unknown
  }
  runtimeTerrain?: {
    interpolation?: unknown
    nodata?: unknown
    note?: unknown
  }
  holes?: Record<string, RawTerrainHole>
}

export type GreywolfHoleTerrain = {
  terrain: CourseTerrainGrid
  contours: readonly CourseContourLine[]
}

let packagePromise: Promise<RawTerrainPackage | null> | null = null
const holeCache = new Map<number, Promise<GreywolfHoleTerrain | null>>()

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const integer = (value: unknown): value is number =>
  finite(value) && Number.isInteger(value) && value > 0

const fetchTerrainPackage = async (): Promise<RawTerrainPackage | null> => {
  try {
    const response = await fetch(TERRAIN_PACKAGE_URL, { cache: 'force-cache' })
    if (!response.ok) {
      throw new Error(`Greywolf terrain package returned ${response.status}.`)
    }
    const payload = await response.json() as RawTerrainPackage
    if (payload.schemaVersion !== 'looper-greywolf-terrain-v1' || !payload.holes) {
      throw new Error('Greywolf terrain package did not match looper-greywolf-terrain-v1.')
    }
    return payload
  } catch (error) {
    // A transient network/CDN failure should not poison the terrain package forever.
    packagePromise = null
    console.warn('[Greywolf geometry] LiDAR terrain package unavailable; continuing without direct terrain.', error)
    return null
  }
}

const loadTerrainPackage = (): Promise<RawTerrainPackage | null> => {
  packagePromise ??= fetchTerrainPackage()
  return packagePromise
}

const decodeDeflateUint16 = async (
  valuesBase64: string,
  expectedValues: number,
): Promise<Uint16Array> => {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser does not support DecompressionStream required for Greywolf LiDAR terrain.')
  }

  const binary = atob(valuesBase64)
  const compressed = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    compressed[index] = binary.charCodeAt(index)
  }

  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  const buffer = await new Response(stream).arrayBuffer()
  if (buffer.byteLength !== expectedValues * 2) {
    throw new Error(
      `Greywolf terrain grid decoded ${buffer.byteLength} bytes; expected ${expectedValues * 2}.`,
    )
  }

  // The compiler writes little-endian uint16 values. Decode explicitly rather
  // than relying on the browser host's native endianness.
  const view = new DataView(buffer)
  const values = new Uint16Array(expectedValues)
  for (let index = 0; index < expectedValues; index += 1) {
    values[index] = view.getUint16(index * 2, true)
  }
  return values
}

const parsePoint = (value: unknown): CoursePointYds | null => {
  if (!Array.isArray(value) || value.length < 2) return null
  return finite(value[0]) && finite(value[1]) ? [value[0], value[1]] : null
}

const parseContours = (raw: RawContour[] | undefined): CourseContourLine[] => {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((contour): CourseContourLine[] => {
    if (!finite(contour.elevationFt) || !Array.isArray(contour.points)) return []
    const points = contour.points.flatMap((value): CoursePointYds[] => {
      const point = parsePoint(value)
      return point ? [point] : []
    })
    return points.length >= 2
      ? [{ elevationFt: contour.elevationFt, points }]
      : []
  })
}

const decodeHole = async (
  payload: RawTerrainPackage,
  holeNumber: number,
): Promise<GreywolfHoleTerrain | null> => {
  const rawHole = payload.holes?.[String(holeNumber)]
  const grid = rawHole?.grid
  const sourceResolutionMeters = payload.source?.sourceResolutionMeters
  const nodata = payload.runtimeTerrain?.nodata

  if (
    !grid ||
    !finite(grid.minX) ||
    !finite(grid.minY) ||
    !finite(grid.spacingYds) ||
    grid.spacingYds <= 0 ||
    !integer(grid.width) ||
    !integer(grid.height) ||
    !finite(grid.elevationOffsetFt) ||
    grid.compression !== 'deflate' ||
    typeof grid.valuesBase64 !== 'string' ||
    !finite(sourceResolutionMeters) ||
    !finite(nodata)
  ) {
    console.warn(`[Greywolf geometry] Hole ${holeNumber} LiDAR terrain package was incomplete.`)
    return null
  }

  try {
    const values = await decodeDeflateUint16(grid.valuesBase64, grid.width * grid.height)
    return {
      terrain: {
        source: 'lidar-dem',
        sourceResolutionMeters,
        runtimeSpacingYds: grid.spacingYds,
        interpolation: 'bilinear',
        minX: grid.minX,
        minY: grid.minY,
        width: grid.width,
        height: grid.height,
        elevationOffsetFt: grid.elevationOffsetFt,
        nodata,
        values,
        note: typeof payload.runtimeTerrain?.note === 'string'
          ? payload.runtimeTerrain.note
          : 'Browser terrain grid derived from the official BC 1 m bare-earth DEM.',
      },
      contours: parseContours(rawHole?.contours),
    }
  } catch (error) {
    console.warn(`[Greywolf geometry] Hole ${holeNumber} LiDAR terrain could not be decoded.`, error)
    return null
  }
}

export const loadGreywolfHoleTerrain = (holeNumber: number): Promise<GreywolfHoleTerrain | null> => {
  const normalized = Math.max(1, Math.min(18, Math.round(holeNumber)))
  const existing = holeCache.get(normalized)
  if (existing) return existing

  const promise = loadTerrainPackage().then((payload) =>
    payload ? decodeHole(payload, normalized) : null,
  )
  holeCache.set(normalized, promise)
  return promise
}
