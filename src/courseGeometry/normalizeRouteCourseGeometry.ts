import type {
  CourseGeometryBounds,
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
} from './types'

const MAX_RUNTIME_TEE_REBASE_YDS = 140

const centroid = (polygon: CoursePolygonYds): CoursePointYds => {
  if (polygon.length === 0) return [0, 0]
  const [x, y] = polygon.reduce(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]] as [number, number],
    [0, 0],
  )
  return [x / polygon.length, y / polygon.length]
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
  if (polygon.length < 3) return false
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
    const next = (index + 1) % polygon.length
    best = Math.min(best, pointSegmentDistance(origin, polygon[index], polygon[next]))
  }
  return best
}

const translatePoint = (point: CoursePointYds, anchor: CoursePointYds): CoursePointYds => [
  point[0] - anchor[0],
  point[1] - anchor[1],
]

const translatePolygon = (polygon: CoursePolygonYds, anchor: CoursePointYds): CoursePolygonYds =>
  polygon.map((point) => translatePoint(point, anchor))

const translateBounds = (bounds: CourseGeometryBounds, anchor: CoursePointYds): CourseGeometryBounds => ({
  minX: bounds.minX - anchor[0],
  maxX: bounds.maxX - anchor[0],
  minY: bounds.minY - anchor[1],
  maxY: bounds.maxY - anchor[1],
})

/**
 * Automated route packages were historically authored in an OSM hole-route-start
 * frame. That point is not guaranteed to be the playable tee and can be tens of
 * yards away from the actual mapped tee complex. Greywolf, by contrast, uses a
 * selected-tee origin. Normalize route packages to the same runtime contract so
 * [0,0] means the playable tee before Live Caddie or the decision engine sees it.
 *
 * This is intentionally a translation only. The package's x/right and y/forward
 * axes remain unchanged, so surfaces, LiDAR, contours, hazards and the pin stay in
 * one coordinate frame. The nearest tee polygon to the route start is used only
 * when it is plausibly part of the same hole.
 */
export const normalizeRouteCourseGeometry = (
  geometry: CourseHoleGeometry,
): CourseHoleGeometry => {
  if (geometry.coordinateSystem.origin !== 'osm-hole-route-start') return geometry

  const teePolygons = geometry.surfaces
    .filter((surface) => surface.kind === 'tee')
    .flatMap((surface) => surface.polygons)

  if (teePolygons.length === 0) return geometry

  const ranked = teePolygons
    .map((polygon) => ({
      polygon,
      distance: polygonDistanceToOrigin(polygon),
      center: centroid(polygon),
    }))
    .sort((left, right) => left.distance - right.distance)

  const selected = ranked[0]
  if (!selected || !Number.isFinite(selected.distance) || selected.distance > MAX_RUNTIME_TEE_REBASE_YDS) {
    return geometry
  }

  const anchor = selected.center
  const rebaseDistance = Math.hypot(anchor[0], anchor[1])
  if (rebaseDistance < 0.05) {
    return {
      ...geometry,
      coordinateSystem: { ...geometry.coordinateSystem, origin: 'selected-tee' },
      markers: { ...geometry.markers, tee: [0, 0] },
      registration: {
        ...geometry.registration,
        note: `${geometry.registration.note ?? ''} Runtime origin confirmed against the nearest mapped tee polygon.`.trim(),
      },
    }
  }

  return {
    ...geometry,
    coordinateSystem: { ...geometry.coordinateSystem, origin: 'selected-tee' },
    bounds: translateBounds(geometry.bounds, anchor),
    ...(geometry.viewBounds ? { viewBounds: translateBounds(geometry.viewBounds, anchor) } : {}),
    markers: {
      tee: [0, 0],
      ...(geometry.markers.pin ? { pin: translatePoint(geometry.markers.pin, anchor) } : {}),
    },
    surfaces: geometry.surfaces.map((surface) => ({
      ...surface,
      polygons: surface.polygons.map((polygon) => translatePolygon(polygon, anchor)),
    })),
    ...(geometry.contextLayers ? {
      contextLayers: geometry.contextLayers.map((layer) => ({
        ...layer,
        polygons: layer.polygons.map((polygon) => translatePolygon(polygon, anchor)),
      })),
    } : {}),
    ...(geometry.contours ? {
      contours: geometry.contours.map((contour) => ({
        ...contour,
        points: contour.points.map((point) => translatePoint(point, anchor)),
      })),
    } : {}),
    ...(geometry.terrain ? {
      terrain: {
        ...geometry.terrain,
        minX: geometry.terrain.minX - anchor[0],
        minY: geometry.terrain.minY - anchor[1],
      },
    } : {}),
    registration: {
      ...geometry.registration,
      status: 'approximate',
      method: 'hole-local',
      sourceCoordinateSystem: 'cached OSM golf=hole route -> nearest mapped tee -> local yards',
      targetCoordinateSystem: 'looper-hole-local-yards',
      note: `${geometry.registration.note ?? ''} Runtime rebased ${rebaseDistance.toFixed(1)} yd to the nearest mapped tee centroid so [0,0] matches the playable tee contract.`.trim(),
    },
  }
}
