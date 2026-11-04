import {
  classifyPoint,
  pointInPolygon,
  type SurfaceClassificationResult,
} from './geometry'
import type { CourseHoleGeometry, CoursePointYds } from './types'

/**
 * Decision-layer landing classification.
 *
 * Playable / penalty surface geometry remains authoritative. Course-wide
 * environment context is only consulted when the normal surface classifier
 * returns unknown. Woods and scrub then become tactical deep rough: the ball
 * may technically be playable, but for decision-making these are obstruction
 * outcomes with the same downside tier as deep rough.
 *
 * Grass context intentionally remains unknown. It is useful rendering/context
 * data, but is not precise enough to promote a miss to normal rough/fairway.
 */
/**
 * Woods/scrub context comes from LiDAR canopy and can be thousands of
 * vertices per hole (Royal New Kent 3: 1,934), tested for every one of the
 * ~25k landing samples per club. A 0.5-yd raster per layer (scanline fill,
 * built once) answers the same question in one lookup; this is broad tactical
 * context (deep-rough tier), so half a yard at its edge does not matter.
 */
type LayerRaster = { minX: number; minY: number; width: number; height: number; cells: Uint8Array }
const RASTER_YDS = 0.5
const MAX_RASTER_CELLS = 4_000_000
const rasters = new WeakMap<readonly (readonly CoursePointYds[])[], LayerRaster | null>()

const buildRaster = (polygons: readonly (readonly CoursePointYds[])[]): LayerRaster | null => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const polygon of polygons) {
    for (const [x, y] of polygon) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) return null
  const width = Math.ceil((maxX - minX) / RASTER_YDS) + 1
  const height = Math.ceil((maxY - minY) / RASTER_YDS) + 1
  if (width * height > MAX_RASTER_CELLS) return null
  const cells = new Uint8Array(width * height)
  const crossings: number[] = []
  for (const polygon of polygons) {
    if (polygon.length < 3) continue
    let pMinY = Infinity, pMaxY = -Infinity
    for (const [, y] of polygon) { if (y < pMinY) pMinY = y; if (y > pMaxY) pMaxY = y }
    const rowStart = Math.max(0, Math.floor((pMinY - minY) / RASTER_YDS))
    const rowEnd = Math.min(height - 1, Math.ceil((pMaxY - minY) / RASTER_YDS))
    for (let row = rowStart; row <= rowEnd; row += 1) {
      const y = minY + row * RASTER_YDS
      crossings.length = 0
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [ax, ay] = polygon[j]
        const [bx, by] = polygon[i]
        if ((ay > y) !== (by > y)) crossings.push(ax + ((y - ay) * (bx - ax)) / (by - ay))
      }
      crossings.sort((p, q) => p - q)
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((crossings[k] - minX) / RASTER_YDS))
        const c1 = Math.min(width - 1, Math.floor((crossings[k + 1] - minX) / RASTER_YDS))
        const offset = row * width
        for (let c = c0; c <= c1; c += 1) cells[offset + c] = 1
      }
    }
  }
  return { minX, minY, width, height, cells }
}

const insideContextLayer = (polygons: readonly (readonly CoursePointYds[])[], point: CoursePointYds) => {
  let raster = rasters.get(polygons)
  if (raster === undefined) {
    raster = buildRaster(polygons)
    rasters.set(polygons, raster)
  }
  if (!raster) return polygons.some((polygon) => pointInPolygon(point, polygon as CoursePointYds[]))
  const col = Math.round((point[0] - raster.minX) / RASTER_YDS)
  const row = Math.round((point[1] - raster.minY) / RASTER_YDS)
  if (col < 0 || row < 0 || col >= raster.width || row >= raster.height) return false
  return raster.cells[row * raster.width + col] === 1
}

export function classifyTacticalLandingPoint(
  hole: CourseHoleGeometry,
  point: CoursePointYds,
): SurfaceClassificationResult {
  const surface = classifyPoint(hole, point)
  if (surface.kind !== 'unknown') return surface

  for (const layer of hole.contextLayers ?? []) {
    if (layer.kind !== 'woods' && layer.kind !== 'scrub') continue
    if (!insideContextLayer(layer.polygons, point)) continue

    return {
      kind: 'deep-rough',
      surfaceId: layer.id,
      confidence: layer.provenance.confidence,
    }
  }

  return surface
}

/**
 * What unmapped ground most likely is. On loaded courses a large share of the
 * hole is unmapped (Valhalla 2: ~75% of a ±45-yd corridor); about half of that
 * lies on ESA WorldCover grass (rough, native grass), the rest between
 * LiDAR-detected trees inside WorldCover tree cover. Measured 3 Nov 2026.
 * - 'grass': inside a landcover-grass context layer
 * - 'other': the hole has landcover grass mapped, and this point isn't in it
 * - 'no-landcover': the hole has no landcover layer: no evidence either way
 */
export type UnknownGround = 'grass' | 'other' | 'no-landcover'

export function unknownGroundAt(hole: CourseHoleGeometry, point: CoursePointYds): UnknownGround {
  const grass = (hole.contextLayers ?? []).filter((layer) => layer.kind === 'landcover-grass')
  if (!grass.length) return 'no-landcover'
  return grass.some((layer) => insideContextLayer(layer.polygons, point)) ? 'grass' : 'other'
}

// Tactical surface at 1-yd resolution, per hole: the engine asks about the
// same neighbourhood thousands of times per recommendation (roll surface,
// flight checks). Not for the landing classification itself, which stays exact.
const quantizedKinds = new WeakMap<CourseHoleGeometry, Map<number, SurfaceClassificationResult['kind']>>()

export function tacticalKindNear(hole: CourseHoleGeometry, point: CoursePointYds): SurfaceClassificationResult['kind'] {
  let cache = quantizedKinds.get(hole)
  if (!cache) {
    cache = new Map()
    quantizedKinds.set(hole, cache)
  }
  const qx = Math.round(point[0]), qy = Math.round(point[1])
  const key = (qx + 4096) * 8192 + (qy + 4096)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const kind = classifyTacticalLandingPoint(hole, [qx, qy]).kind
  cache.set(key, kind)
  return kind
}
