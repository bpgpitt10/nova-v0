import { getCourseCatalogEntry, type CourseId } from './courseCatalog'
import type { CourseTerrainGrid } from './types'

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

type RawTerrainHole = {
  grid?: RawTerrainGrid
}

type RawTerrainPackage = {
  schemaVersion?: unknown
  courseId?: unknown
  source?: {
    extractionResolutionMeters?: unknown
    sourceResolutionMeters?: unknown
  }
  runtimeTerrain?: {
    interpolation?: unknown
    nodata?: unknown
    note?: unknown
  }
  holes?: Record<string, RawTerrainHole>
}

const packageCache = new Map<string, Promise<RawTerrainPackage | null>>()
const holeCache = new Map<string, Promise<CourseTerrainGrid | null>>()

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const integer = (value: unknown): value is number =>
  finite(value) && Number.isInteger(value) && value > 0

const fetchTerrainPackage = async (
  courseId: string,
  url: string,
): Promise<RawTerrainPackage | null> => {
  try {
    const response = await fetch(url, { cache: 'force-cache' })
    if (!response.ok) {
      throw new Error(`Terrain package returned ${response.status}.`)
    }
    const payload = await response.json() as RawTerrainPackage
    if (
      payload.schemaVersion !== 'looper-course-terrain-v1' ||
      payload.courseId !== courseId ||
      !payload.holes
    ) {
      throw new Error('Terrain package did not match the expected course terrain contract.')
    }
    return payload
  } catch (error) {
    packageCache.delete(url)
    console.warn(`[Course terrain] ${courseId} terrain package unavailable; continuing without direct terrain.`, error)
    return null
  }
}

const loadTerrainPackage = (
  courseId: string,
  url: string,
): Promise<RawTerrainPackage | null> => {
  const existing = packageCache.get(url)
  if (existing) return existing
  const promise = fetchTerrainPackage(courseId, url)
  packageCache.set(url, promise)
  return promise
}

const decodeDeflateUint16 = async (
  valuesBase64: string,
  expectedValues: number,
): Promise<Uint16Array> => {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser does not support DecompressionStream required for cached course terrain.')
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
      `Terrain grid decoded ${buffer.byteLength} bytes; expected ${expectedValues * 2}.`,
    )
  }

  const view = new DataView(buffer)
  const values = new Uint16Array(expectedValues)
  for (let index = 0; index < expectedValues; index += 1) {
    values[index] = view.getUint16(index * 2, true)
  }
  return values
}

const decodeHole = async (
  courseId: string,
  payload: RawTerrainPackage,
  holeNumber: number,
): Promise<CourseTerrainGrid | null> => {
  const grid = payload.holes?.[String(holeNumber)]?.grid
  const sourceResolutionMeters = payload.source?.sourceResolutionMeters ?? payload.source?.extractionResolutionMeters
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
    console.warn(`[Course terrain] ${courseId} hole ${holeNumber} terrain package was incomplete.`)
    return null
  }

  try {
    const values = await decodeDeflateUint16(grid.valuesBase64, grid.width * grid.height)
    return {
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
        : 'Compact cached browser terrain grid derived from an official bare-earth DEM source.',
    }
  } catch (error) {
    console.warn(`[Course terrain] ${courseId} hole ${holeNumber} terrain could not be decoded.`, error)
    return null
  }
}

export const loadCourseHoleTerrain = (
  courseId: CourseId,
  holeNumber: number,
): Promise<CourseTerrainGrid | null> => {
  const course = getCourseCatalogEntry(courseId)
  if (!course.staticTerrainUrl) return Promise.resolve(null)

  const normalized = Math.max(1, Math.min(18, Math.round(holeNumber)))
  const key = `${courseId}:${normalized}`
  const existing = holeCache.get(key)
  if (existing) return existing

  const promise = loadTerrainPackage(courseId, course.staticTerrainUrl).then((payload) =>
    payload ? decodeHole(courseId, payload, normalized) : null,
  )
  holeCache.set(key, promise)
  return promise
}
