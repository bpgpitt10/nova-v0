import type { NativeCourseLayout, NativePenaltyArea, NativeXYZ } from './nativeGkd'
import type { NativeRegistration } from './nativeRegistration'
import { nativeWorldToHoleLocalYds } from './nativeRegistration'
import { pointInPolygon } from './geometry'
import type { CourseHoleGeometry, CoursePointYds, CoursePolygonYds, CourseSurface } from './types'

/**
 * GSPro's own penalty areas and out-of-bounds, from the player's GKD, placed
 * on a Looper hole through the course registration.
 *
 * Why: Looper used to take water and penalty from OpenStreetMap, which draws
 * the real course, while the polygons GSPro actually penalizes with sit in the
 * GKD on the PC (Valhalla 2, 11/3: a creek missing from OSM; Looper aimed into
 * it). OSM never has out of bounds at all.
 *
 * Polygons are course-wide in GSPro world metres. For one hole, each vertex
 * is mapped to that hole's local yards and polygons that touch the hole's view
 * are kept. The GKD never leaves the PC; these polygons live in the browser.
 */

/** Yards beyond the hole's view where out-of-bounds is still modelled. */
const OB_MARGIN_YDS = 80
/** Penalty areas within this distance of the hole view are included. */
const HAZARD_MARGIN_YDS = 30

export type GkdHazardSummary = Readonly<{
  penaltyAreas: number
  innerOob: number
  /** 'boundary': outside the pOOB polygon is OB. 'region': inside it is OB. null: no polygon. */
  obMode: 'boundary' | 'region' | null
  obOnHole: boolean
}>

type Local = CoursePointYds

const bbox = (points: readonly Local[]) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

const holeExtent = (hole: CourseHoleGeometry, margin: number) => {
  const b = hole.viewBounds ?? hole.bounds
  return { minX: b.minX - margin, minY: b.minY - margin, maxX: b.maxX + margin, maxY: b.maxY + margin }
}

const overlaps = (a: ReturnType<typeof bbox>, b: ReturnType<typeof bbox>) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

const signedArea = (ring: readonly Local[]) => {
  let area = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1])
  }
  return area / 2
}

const oriented = (ring: readonly Local[], clockwise: boolean): Local[] => {
  const cw = signedArea(ring) < 0
  return cw === clockwise ? [...ring] : [...ring].reverse()
}

/**
 * One ring with holes cut out, as a single polygon: the outer ring, then a
 * zero-width bridge to each hole and back ("keyhole"). Ray-casting
 * point-in-polygon treats the result exactly as outer minus holes.
 */
export const ringWithHoles = (outer: readonly Local[], holes: readonly (readonly Local[])[]): Local[] => {
  let result = oriented(outer, false)
  for (const hole of holes) {
    if (hole.length < 3) continue
    const inner = oriented(hole, true)
    // Bridge from the outer vertex nearest the hole's first vertex.
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < result.length; i += 1) {
      const d = Math.hypot(result[i][0] - inner[0][0], result[i][1] - inner[0][1])
      if (d < bestD) { bestD = d; best = i }
    }
    result = [
      ...result.slice(0, best + 1),
      ...inner,
      inner[0],
      result[best],
      ...result.slice(best + 1),
    ]
  }
  return result
}

const toLocalRing = (
  registration: NativeRegistration,
  holeNumber: number,
  points: readonly NativeXYZ[],
): Local[] | null => {
  const ring: Local[] = []
  for (const p of points) {
    const local = nativeWorldToHoleLocalYds(registration, holeNumber, p)
    if (!local) return null
    ring.push(local)
  }
  return ring.length >= 3 ? ring : null
}

/** Is the pOOB polygon the playable boundary (outside = OB) or an OB region (inside = OB)?
 * Designers draw it around the course, so most green centres fall inside it. */
export const outOfBoundsMode = (layout: NativeCourseLayout): 'boundary' | 'region' | null => {
  const ring = layout.outOfBounds
  if (ring.length < 3) return null
  const polygon: Local[] = ring.map((p) => [p.x, p.z] as const)
  const centres = layout.holes
    .map((h) => h.greenCenter ?? (h.pins[0] ?? null))
    .filter((p): p is NativeXYZ => p !== null)
  if (centres.length === 0) return 'boundary'
  const inside = centres.filter((c) => pointInPolygon([c.x, c.z], polygon)).length
  return inside * 2 >= centres.length ? 'boundary' : 'region'
}

/** The main layout carries the hazards; an alternate layout may not. */
export const layoutWithHazards = (layouts: readonly NativeCourseLayout[]): NativeCourseLayout | null =>
  layouts.find((l) => l.penaltyAreas.length > 0 || l.outOfBounds.length >= 3) ?? layouts[0] ?? null

const greensContaining = (hole: CourseHoleGeometry, point: Local): CoursePolygonYds[] =>
  hole.surfaces
    .filter((s) => s.kind === 'green')
    .flatMap((s) => s.polygons)
    .filter((polygon) => pointInPolygon(point, polygon))

/**
 * GSPro penalty areas and OB for one hole as Looper surfaces. Penalty areas
 * that enclose a green (island greens) have the green cut out, so the green
 * still classifies as green.
 */
export const gkdHazardSurfaces = (
  layout: NativeCourseLayout,
  registration: NativeRegistration,
  hole: CourseHoleGeometry,
): { surfaces: CourseSurface[]; summary: GkdHazardSummary } => {
  const holeNumber = hole.holeNumber
  const surfaces: CourseSurface[] = []
  const near = holeExtent(hole, HAZARD_MARGIN_YDS)
  let innerOob = 0
  let penaltyCount = 0
  const pinsLocal = layout.holes
    .flatMap((h) => [...h.pins, ...(h.greenCenter ? [h.greenCenter] : [])])
    .map((p) => nativeWorldToHoleLocalYds(registration, holeNumber, p))
    .filter((p): p is Local => p !== null)

  const keyholeGreens = (ring: Local[], area: NativePenaltyArea): Local[] => {
    const enclosedPins = pinsLocal.filter((p) => pointInPolygon(p, ring))
    if (!enclosedPins.length && !area.islandGreen) return ring
    const greens = new Set<CoursePolygonYds>()
    for (const p of enclosedPins) greensContaining(hole, p).forEach((g) => greens.add(g))
    return greens.size ? ringWithHoles(ring, [...greens]) : ring
  }

  for (const area of layout.penaltyAreas) {
    const ring = toLocalRing(registration, holeNumber, area.points)
    if (!ring || !overlaps(bbox(ring), near)) continue
    const polygon = keyholeGreens(ring, area)
    if (area.innerOOB) innerOob += 1
    else penaltyCount += 1
    surfaces.push({
      id: `gkd-${area.innerOOB ? 'oob-inner' : 'penalty'}-${area.id}`,
      kind: 'penalty',
      polygons: [polygon],
      provenance: {
        source: 'gspro',
        sourceFeature: area.innerOOB ? 'GKD Hazards (innerOOB)' : 'GKD Hazards',
        sourceIds: [area.id],
        confidence: 'high',
        note: area.innerOOB
          ? 'Out of bounds inside this area, from the GSPro course file.'
          : `GSPro penalty area${area.freeDrop ? ' (free drop)' : ''}${area.dropZone ? ', drop zone' : ''}.`,
      },
    })
  }

  const obMode = outOfBoundsMode(layout)
  let obOnHole = false
  if (obMode) {
    const ring = toLocalRing(registration, holeNumber, layout.outOfBounds)
    if (ring) {
      const far = holeExtent(hole, OB_MARGIN_YDS)
      const frame: Local[] = [[far.minX, far.minY], [far.maxX, far.minY], [far.maxX, far.maxY], [far.minX, far.maxY]]
      const inFrame = ring.some(([x, y]) => x >= far.minX && x <= far.maxX && y >= far.minY && y <= far.maxY)
      if (obMode === 'region' && overlaps(bbox(ring), far)) {
        obOnHole = true
        surfaces.push({
          id: 'gkd-oob-region', kind: 'penalty', polygons: [ring],
          provenance: { source: 'gspro', sourceFeature: 'GKD pOOB', confidence: 'high', note: 'Out of bounds inside this area, from the GSPro course file.' },
        })
      } else if (obMode === 'boundary' && inFrame) {
        // Everything in the frame but outside the boundary is OB.
        obOnHole = true
        surfaces.push({
          id: 'gkd-oob', kind: 'penalty', polygons: [ringWithHoles(frame, [ring])],
          provenance: { source: 'gspro', sourceFeature: 'GKD pOOB', confidence: 'high', note: 'Out of bounds beyond the GSPro course boundary.' },
        })
      }
    }
  }

  return { surfaces, summary: { penaltyAreas: penaltyCount, innerOob, obMode, obOnHole } }
}

/** The hole with GSPro's penalty areas and OB added ahead of the map's own water/penalty. */
export const withGkdHazards = (hole: CourseHoleGeometry, surfaces: readonly CourseSurface[]): CourseHoleGeometry =>
  surfaces.length
    ? { ...hole, surfaces: [...surfaces, ...hole.surfaces.filter((s) => !s.id.startsWith('gkd-'))] }
    : hole
