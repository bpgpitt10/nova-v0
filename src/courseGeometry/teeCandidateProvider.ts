import {
  getCourseCatalogEntry,
  type CourseId,
} from './courseCatalog'
import type {
  CoursePointYds,
  CoursePolygonYds,
  CourseTeeCandidate,
} from './types'

const MAX_RUNTIME_TEE_REBASE_YDS = 140

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const stringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : []

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

const centroid = (polygon: CoursePolygonYds): CoursePointYds => {
  const totals = polygon.reduce(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]] as [number, number],
    [0, 0],
  )
  return polygon.length ? [totals[0] / polygon.length, totals[1] / polygon.length] : [0, 0]
}

const pointSegmentDistance = (
  point: CoursePointYds,
  a: CoursePointYds,
  b: CoursePointYds,
) => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const denominator = dx * dx + dy * dy
  if (denominator <= 1e-12) return Math.hypot(point[0] - a[0], point[1] - a[1])
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator))
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy))
}

const pointInPolygon = (point: CoursePointYds, polygon: CoursePolygonYds) => {
  let inside = false
  let j = polygon.length - 1
  for (let i = 0; i < polygon.length; i += 1) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (
      ((yi > point[1]) !== (yj > point[1]))
      && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || 1e-12) + xi
    ) inside = !inside
    j = i
  }
  return inside
}

const polygonDistanceToOrigin = (polygon: CoursePolygonYds) => {
  const origin: CoursePointYds = [0, 0]
  if (pointInPolygon(origin, polygon)) return 0
  let best = Number.POSITIVE_INFINITY
  for (let index = 0; index < polygon.length; index += 1) {
    best = Math.min(
      best,
      pointSegmentDistance(origin, polygon[index], polygon[(index + 1) % polygon.length]),
    )
  }
  return best
}

const translatePoint = (point: CoursePointYds, anchor: CoursePointYds): CoursePointYds => [
  point[0] - anchor[0],
  point[1] - anchor[1],
]

const translatePolygon = (polygon: CoursePolygonYds, anchor: CoursePointYds): CoursePolygonYds =>
  polygon.map((point) => translatePoint(point, anchor))

const sourceTags = (value: unknown) => {
  const raw = record(value)
  const tags: Record<string, string> = {}
  for (const [key, tagValue] of Object.entries(raw)) {
    if (typeof tagValue === 'string' || typeof tagValue === 'number' || typeof tagValue === 'boolean') {
      tags[key] = String(tagValue)
    }
  }
  return Object.keys(tags).length ? tags : undefined
}

const parseCandidate = (value: unknown): CourseTeeCandidate | null => {
  const raw = record(value)
  const coursePoint = parsePoint(raw.coursePoint)
  if (!coursePoint) return null
  const sourceLatLon = parsePoint(raw.sourceLatLon)
  const polygons = parsePolygons(raw.polygons)
  const teeToGreen = finite(raw.teeToGreenCentroidYards) ? raw.teeToGreenCentroidYards : undefined
  const startGap = finite(raw.startPolygonGapYards) ? raw.startPolygonGapYards : undefined
  const routeGap = finite(raw.currentRouteGapYards) ? raw.currentRouteGapYards : undefined
  const teeAliases = stringArray(raw.teeAliases)
  return {
    ...(typeof raw.osmId === 'string' || typeof raw.osmId === 'number' ? { osmId: raw.osmId } : {}),
    ...(text(raw.osmType) ? { osmType: text(raw.osmType) } : {}),
    ...(text(raw.teeSet) ? { teeSet: text(raw.teeSet) } : {}),
    ...(teeAliases.length ? { teeAliases } : {}),
    ...(text(raw.name) ? { name: text(raw.name) } : {}),
    ...(text(raw.ref) ? { ref: text(raw.ref) } : {}),
    ...(text(raw.color) ? { color: text(raw.color) } : {}),
    ...(text(raw.label) ? { label: text(raw.label) } : {}),
    ...(sourceTags(raw.sourceTags) ? { sourceTags: sourceTags(raw.sourceTags) } : {}),
    ...(sourceLatLon ? { sourceLatLon: [sourceLatLon[0], sourceLatLon[1]] as const } : {}),
    coursePoint,
    ...(teeToGreen != null ? { teeToGreenCentroidYards: teeToGreen } : {}),
    ...(startGap != null ? { startPolygonGapYards: startGap } : {}),
    ...(routeGap != null ? { currentRouteGapYards: routeGap } : {}),
    ...(typeof raw.selectedAnchor === 'boolean' ? { selectedAnchor: raw.selectedAnchor } : {}),
    ...(polygons.length ? { polygons } : {}),
  }
}

const rebaseAnchorForRouteStartPackage = (hole: Record<string, unknown>): CoursePointYds | null => {
  const frame = record(hole.coordinateFrame)
  if (frame.origin !== 'osm-hole-route-start') return null
  const surfaces = record(hole.surfaces)
  const teePolygons = parsePolygons(surfaces.tee)
  const selected = teePolygons
    .map((polygon) => ({ polygon, distance: polygonDistanceToOrigin(polygon) }))
    .sort((left, right) => left.distance - right.distance)[0]
  if (!selected || !Number.isFinite(selected.distance) || selected.distance > MAX_RUNTIME_TEE_REBASE_YDS) {
    return null
  }
  return centroid(selected.polygon)
}

const loadGenericCandidates = async (courseId: CourseId, holeNumber: number) => {
  const entry = getCourseCatalogEntry(courseId)
  if (!entry.staticPackageUrl) return []
  const response = await fetch(entry.staticPackageUrl, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`${entry.name} tee metadata returned ${response.status}.`)
  const payload = record(await response.json())
  const holes = record(payload.holes)
  const hole = record(holes[String(holeNumber)])
  const rawCandidates = Array.isArray(hole.teeCandidates) ? hole.teeCandidates : []
  const candidates = rawCandidates.flatMap((raw): CourseTeeCandidate[] => {
    const candidate = parseCandidate(raw)
    return candidate ? [candidate] : []
  })
  const anchor = rebaseAnchorForRouteStartPackage(hole)
  if (!anchor) return candidates
  return candidates.map((candidate): CourseTeeCandidate => ({
    ...candidate,
    coursePoint: translatePoint(candidate.coursePoint, anchor),
    ...(candidate.polygons
      ? { polygons: candidate.polygons.map((polygon) => translatePolygon(polygon, anchor)) }
      : {}),
  }))
}


export const loadCourseTeeCandidates = async (
  courseId: CourseId,
  holeNumber: number,
): Promise<readonly CourseTeeCandidate[]> => {
  return loadGenericCandidates(courseId, holeNumber)
}
