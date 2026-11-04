import type { CoursePointYds } from './types'
import { coursePackageBaseUrl } from './courseCatalog'

export type GreenDetailSector = {
  id: string
  row: 'front' | 'middle' | 'back'
  column: 'left' | 'center' | 'right'
  boundsYds: readonly [number, number, number, number]
  sampleCount: number
  meanElevationFt?: number
  minElevationFt?: number
  maxElevationFt?: number
  elevationRangeFt?: number
  deltaFromGreenMeanFt?: number
  planeSlopePercent?: number
  downhillLocalUnit?: readonly [right: number, forward: number]
  downhillBearingDeg?: number
}

export type CourseGreenDetail = {
  holeNumber: number
  greenBoundsYds: readonly [minRight: number, maxRight: number, minForward: number, maxForward: number]
  greenSampleCount: number
  greenSummary: {
    sampleCount: number
    meanElevationFt: number
    minElevationFt: number
    maxElevationFt: number
    elevationRangeFt: number
    planeSlopePercent: number
    downhillLocalUnit: readonly [right: number, forward: number]
    downhillBearingDeg: number
  }
  sectors: readonly GreenDetailSector[]
  grid: {
    minX: number
    minY: number
    spacingYds: number
    width: number
    height: number
    elevationOffsetFt: number
    nodata: number
    values: Uint16Array
  }
}

type RawGrid = {
  minX?: unknown
  minY?: unknown
  spacingYds?: unknown
  width?: unknown
  height?: unknown
  elevationOffsetFt?: unknown
  compression?: unknown
  valuesBase64?: unknown
}

type RawHole = {
  greenBoundsYds?: unknown
  greenSampleCount?: unknown
  greenSummary?: unknown
  sectors?: unknown
  grid?: RawGrid
}

type RawPackage = {
  schemaVersion?: unknown
  courseId?: unknown
  runtimeTerrain?: { nodata?: unknown }
  holes?: Record<string, RawHole>
}

const SUPPORTED_GREEN_DETAIL_SCHEMAS = new Set([
  'looper-course-green-detail-v1',
  'looper-greywolf-green-detail-v1',
])

const packagePromises = new Map<string, Promise<RawPackage | null>>()
const holeCache = new Map<string, Promise<CourseGreenDetail | null>>()

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const positiveInteger = (value: unknown): value is number =>
  finite(value) && Number.isInteger(value) && value > 0

const numericTuple = <T extends number>(value: unknown, length: T): number[] | null => {
  if (!Array.isArray(value) || value.length !== length || !value.every(finite)) return null
  return value as number[]
}

const normalizedSlug = (courseSlug: string) => courseSlug.trim().toLowerCase()

const greenDetailUrl = (courseSlug: string) =>
  `${coursePackageBaseUrl(normalizedSlug(courseSlug))}green-detail-v1.json`

const fetchPackage = async (courseSlug: string): Promise<RawPackage | null> => {
  const slug = normalizedSlug(courseSlug)
  if (!slug) return null
  try {
    const response = await fetch(greenDetailUrl(slug), { cache: 'no-cache' })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Green detail package returned ${response.status}.`)
    const payload = await response.json() as RawPackage
    if (!SUPPORTED_GREEN_DETAIL_SCHEMAS.has(String(payload.schemaVersion)) || !payload.holes) {
      throw new Error(`Green detail package for ${slug} has an unsupported schema.`)
    }
    return payload
  } catch (error) {
    packagePromises.delete(slug)
    console.warn(`[Course green detail] ${slug} package unavailable.`, error)
    return null
  }
}

const loadPackage = (courseSlug: string) => {
  const slug = normalizedSlug(courseSlug)
  const cached = packagePromises.get(slug)
  if (cached) return cached
  const pending = fetchPackage(slug)
  packagePromises.set(slug, pending)
  return pending
}

const decodeDeflateUint16 = async (valuesBase64: string, expectedValues: number) => {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser does not support DecompressionStream required for green detail terrain.')
  }
  const binary = atob(valuesBase64)
  const compressed = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) compressed[index] = binary.charCodeAt(index)
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'))
  const buffer = await new Response(stream).arrayBuffer()
  if (buffer.byteLength !== expectedValues * 2) {
    throw new Error(`Green detail decoded ${buffer.byteLength} bytes; expected ${expectedValues * 2}.`)
  }
  const view = new DataView(buffer)
  const values = new Uint16Array(expectedValues)
  for (let index = 0; index < expectedValues; index += 1) {
    values[index] = view.getUint16(index * 2, true)
  }
  return values
}

const parseSector = (value: unknown): GreenDetailSector | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const bounds = numericTuple(record.boundsYds, 4)
  if (
    typeof record.id !== 'string'
    || !['front', 'middle', 'back'].includes(String(record.row))
    || !['left', 'center', 'right'].includes(String(record.column))
    || !bounds
    || !finite(record.sampleCount)
  ) return null
  const downhill = numericTuple(record.downhillLocalUnit, 2)
  return {
    id: record.id,
    row: record.row as GreenDetailSector['row'],
    column: record.column as GreenDetailSector['column'],
    boundsYds: bounds as unknown as GreenDetailSector['boundsYds'],
    sampleCount: record.sampleCount,
    ...(finite(record.meanElevationFt) ? { meanElevationFt: record.meanElevationFt } : {}),
    ...(finite(record.minElevationFt) ? { minElevationFt: record.minElevationFt } : {}),
    ...(finite(record.maxElevationFt) ? { maxElevationFt: record.maxElevationFt } : {}),
    ...(finite(record.elevationRangeFt) ? { elevationRangeFt: record.elevationRangeFt } : {}),
    ...(finite(record.deltaFromGreenMeanFt) ? { deltaFromGreenMeanFt: record.deltaFromGreenMeanFt } : {}),
    ...(finite(record.planeSlopePercent) ? { planeSlopePercent: record.planeSlopePercent } : {}),
    ...(downhill ? { downhillLocalUnit: downhill as unknown as readonly [number, number] } : {}),
    ...(finite(record.downhillBearingDeg) ? { downhillBearingDeg: record.downhillBearingDeg } : {}),
  }
}

const parseSummary = (value: unknown): CourseGreenDetail['greenSummary'] | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const downhill = numericTuple(record.downhillLocalUnit, 2)
  if (
    !finite(record.sampleCount)
    || !finite(record.meanElevationFt)
    || !finite(record.minElevationFt)
    || !finite(record.maxElevationFt)
    || !finite(record.elevationRangeFt)
    || !finite(record.planeSlopePercent)
    || !downhill
    || !finite(record.downhillBearingDeg)
  ) return null
  return {
    sampleCount: record.sampleCount,
    meanElevationFt: record.meanElevationFt,
    minElevationFt: record.minElevationFt,
    maxElevationFt: record.maxElevationFt,
    elevationRangeFt: record.elevationRangeFt,
    planeSlopePercent: record.planeSlopePercent,
    downhillLocalUnit: downhill as unknown as readonly [number, number],
    downhillBearingDeg: record.downhillBearingDeg,
  }
}

const decodeHole = async (
  payload: RawPackage,
  holeNumber: number,
): Promise<CourseGreenDetail | null> => {
  const raw = payload.holes?.[String(holeNumber)]
  const grid = raw?.grid
  const bounds = numericTuple(raw?.greenBoundsYds, 4)
  const summary = parseSummary(raw?.greenSummary)
  const nodata = payload.runtimeTerrain?.nodata
  if (
    !raw || !grid || !bounds || !summary || !finite(raw.greenSampleCount)
    || !finite(grid.minX) || !finite(grid.minY) || !finite(grid.spacingYds) || grid.spacingYds <= 0
    || !positiveInteger(grid.width) || !positiveInteger(grid.height)
    || !finite(grid.elevationOffsetFt) || grid.compression !== 'deflate'
    || typeof grid.valuesBase64 !== 'string' || !finite(nodata)
  ) return null

  const values = await decodeDeflateUint16(grid.valuesBase64, grid.width * grid.height)
  const sectors = Array.isArray(raw.sectors)
    ? raw.sectors.flatMap((value): GreenDetailSector[] => {
        const parsed = parseSector(value)
        return parsed ? [parsed] : []
      })
    : []
  return {
    holeNumber,
    greenBoundsYds: bounds as unknown as CourseGreenDetail['greenBoundsYds'],
    greenSampleCount: raw.greenSampleCount,
    greenSummary: summary,
    sectors,
    grid: {
      minX: grid.minX,
      minY: grid.minY,
      spacingYds: grid.spacingYds,
      width: grid.width,
      height: grid.height,
      elevationOffsetFt: grid.elevationOffsetFt,
      nodata,
      values,
    },
  }
}

export const loadCourseGreenDetail = (
  courseSlug: string,
  holeNumber: number,
): Promise<CourseGreenDetail | null> => {
  const slug = normalizedSlug(courseSlug)
  const normalizedHole = Math.max(1, Math.min(18, Math.round(holeNumber)))
  if (!slug) return Promise.resolve(null)
  const cacheKey = `${slug}:${normalizedHole}`
  const cached = holeCache.get(cacheKey)
  if (cached) return cached
  const pending = loadPackage(slug)
    .then((payload) => payload ? decodeHole(payload, normalizedHole) : null)
    .catch((error) => {
      holeCache.delete(cacheKey)
      console.warn(`[Course green detail] ${slug} H${normalizedHole} could not be decoded.`, error)
      return null
    })
  holeCache.set(cacheKey, pending)
  return pending
}

const encodedElevation = (detail: CourseGreenDetail, row: number, column: number) => {
  const encoded = detail.grid.values[row * detail.grid.width + column]
  if (encoded == null || encoded === detail.grid.nodata) return null
  return detail.grid.elevationOffsetFt + encoded / 10
}

export const sampleCourseGreenElevation = (
  detail: CourseGreenDetail,
  point: CoursePointYds,
): number | null => {
  const { grid } = detail
  if (grid.width < 2 || grid.height < 2) return null
  const x = (point[0] - grid.minX) / grid.spacingYds
  const y = (point[1] - grid.minY) / grid.spacingYds
  if (x < 0 || y < 0 || x > grid.width - 1 || y > grid.height - 1) return null
  const c0 = Math.min(Math.floor(x), grid.width - 2)
  const r0 = Math.min(Math.floor(y), grid.height - 2)
  const dx = x - c0
  const dy = y - r0
  const z00 = encodedElevation(detail, r0, c0)
  const z10 = encodedElevation(detail, r0, c0 + 1)
  const z01 = encodedElevation(detail, r0 + 1, c0)
  const z11 = encodedElevation(detail, r0 + 1, c0 + 1)
  if (z00 == null || z10 == null || z01 == null || z11 == null) return null
  const top = z00 * (1 - dx) + z10 * dx
  const bottom = z01 * (1 - dx) + z11 * dx
  return top * (1 - dy) + bottom * dy
}

export const courseGreenSectorAtPoint = (
  detail: CourseGreenDetail,
  point: CoursePointYds,
): GreenDetailSector | null => detail.sectors.find((sector) => {
  const [minX, maxX, minY, maxY] = sector.boundsYds
  return point[0] >= minX && point[0] <= maxX && point[1] >= minY && point[1] <= maxY
}) ?? null
