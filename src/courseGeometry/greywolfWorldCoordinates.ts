import type { CoursePointYds } from './types'

const METERS_TO_YARDS = 1.0936132983377078
const WORLD_ROTATION_DEG = 0.5319220319046369
const GREYWOLF_LOCAL_GEOMETRY_BASE = '/course-geometry/greywolf/local-geometry'

type HoleAnchorArtifact = {
  anchors?: {
    selected_tee_latlon?: unknown
    target_green_latlon?: unknown
  }
}

export type GsproWorldPoint = {
  x: number
  z: number
}

const holeForwardCache = new Map<number, Promise<readonly [east: number, north: number]>>()

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const latLonPair = (value: unknown): readonly [number, number] | null => {
  if (!Array.isArray(value) || value.length < 2) return null
  const lat = finite(value[0]) ? value[0] : null
  const lon = finite(value[1]) ? value[1] : null
  return lat == null || lon == null ? null : [lat, lon]
}

const loadHoleForwardEastNorth = (holeNumber: number) => {
  const existing = holeForwardCache.get(holeNumber)
  if (existing) return existing

  const promise = fetch(`${GREYWOLF_LOCAL_GEOMETRY_BASE}/greywolf-hole-${String(holeNumber).padStart(2, '0')}.json`)
    .then((response) => {
      if (!response.ok) throw new Error(`Greywolf H${holeNumber} anchor package returned ${response.status}.`)
      return response.json() as Promise<HoleAnchorArtifact>
    })
    .then((raw): readonly [number, number] => {
      const tee = latLonPair(raw.anchors?.selected_tee_latlon)
      const green = latLonPair(raw.anchors?.target_green_latlon)
      if (!tee || !green) throw new Error(`Greywolf H${holeNumber} anchor package did not include tee/green coordinates.`)
      const meanLatRad = ((tee[0] + green[0]) / 2) * Math.PI / 180
      const east = (green[1] - tee[1]) * Math.cos(meanLatRad)
      const north = green[0] - tee[0]
      const length = Math.hypot(east, north)
      if (length <= 1e-12) throw new Error(`Greywolf H${holeNumber} tee/green bearing was degenerate.`)
      return [east / length, north / length]
    })
    .catch((error) => {
      holeForwardCache.delete(holeNumber)
      throw error
    })

  holeForwardCache.set(holeNumber, promise)
  return promise
}

const worldDeltaToEastNorthYards = (dx: number, dz: number) => {
  const radians = WORLD_ROTATION_DEG * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    east: METERS_TO_YARDS * (cos * dx - sin * dz),
    north: METERS_TO_YARDS * (sin * dx + cos * dz),
  }
}

/**
 * Convert a GSPro/Unity world X/Z point into the same right/forward local-yard
 * frame used by the cached Greywolf OSM geometry. This is the proven transform
 * already used by live shot placement, factored out so tee/pin anchors from
 * output_log can share it.
 */
export const gsproWorldPointToGreywolfLocal = async (
  point: GsproWorldPoint,
  teeWorld: GsproWorldPoint,
  holeNumber: number,
): Promise<CoursePointYds> => {
  const forward = await loadHoleForwardEastNorth(holeNumber)
  const delta = worldDeltaToEastNorthYards(point.x - teeWorld.x, point.z - teeWorld.z)
  const rightEast = forward[1]
  const rightNorth = -forward[0]
  const rightYds = delta.east * rightEast + delta.north * rightNorth
  const forwardYds = delta.east * forward[0] + delta.north * forward[1]
  return [rightYds, forwardYds]
}
