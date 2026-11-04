import { effectiveGreenCenter, nativeHole, type NativeCourseLayout } from './nativeGkd'
import type { NativeRegistration } from './nativeRegistration'
import { nativeWorldToHoleLocalYds } from './nativeRegistration'
import { pointInPolygon } from './geometry'
import type { CourseHoleGeometry, CoursePointYds, CoursePolygonYds, CourseSurface } from './types'

/**
 * The hole's green anchored to GSPro's green (spec: claude/spec-green-anchored-to-gkd.md).
 *
 * OpenStreetMap greens often include the apron or approach (Royal New Kent 3,
 * 11/3: 56 yd deep where GSPro's green is a small teardrop). The GKD gives
 * the green centre and the pins, all on the putting surface. v1 rule:
 * translate the OSM green onto GSPro's centre (3–25 yd shifts), clip it to a
 * disk sized by the pin spread, never lose a pin, and keep the rest of the
 * OSM green as apron (fairway). Everything downstream reads hole.surfaces,
 * so classification, the map, front/middle/back and the green read follow.
 */

export type GreenAnchorStatus =
  | 'anchored'
  | 'unanchored' // GKD centre more than 25 yd from the OSM green: left alone
  | 'no-osm-green' // no OSM green within 60 yd of GSPro's centre
  | 'no-gkd-green' // the GKD has no centre or pins for this hole

export type GreenAnchorSummary = Readonly<{
  status: GreenAnchorStatus
  shiftYds: number | null
  radiusYds: number | null
  pins: number
  /** The anchored green is a disk (the OSM outline was unusable or lost a pin). */
  disk: boolean
  /** Share of the anchored green outside the packaged green-detail grid (0–1). */
  outsideDetail: number | null
}>

type Pt = CoursePointYds

const MAX_GREEN_SEARCH_YDS = 60
const MIN_SHIFT_YDS = 3
const MAX_SHIFT_YDS = 25
const RADIUS_MIN_YDS = 14
const RADIUS_MAX_YDS = 28
const RADIUS_NO_PINS_YDS = 22
const RADIUS_GROW_LIMIT_YDS = 34
/** A pin this close to the green's edge counts as on it (registration error ~1–2 yd). */
const PIN_EDGE_TOLERANCE_YDS = 3
const CIRCLE_POINTS = 48

const area = (ring: readonly Pt[]) => {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return Math.abs(a / 2)
}

const centroid = (ring: readonly Pt[]): Pt => {
  let a = 0, cx = 0, cy = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
    a += cross
    cx += (ring[j][0] + ring[i][0]) * cross
    cy += (ring[j][1] + ring[i][1]) * cross
  }
  if (Math.abs(a) < 1e-9) {
    return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length]
  }
  return [cx / (3 * a), cy / (3 * a)]
}

export const circleRing = (c: Pt, r: number, n = CIRCLE_POINTS): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as const
  })

/** Sutherland–Hodgman: subject (any simple polygon) clipped to a convex counter-clockwise clipper. */
export const clipToConvex = (subject: readonly Pt[], clipper: readonly Pt[]): Pt[] => {
  let output: Pt[] = [...subject]
  for (let i = 0; i < clipper.length && output.length; i += 1) {
    const a = clipper[i]
    const b = clipper[(i + 1) % clipper.length]
    const inside = (p: Pt) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0
    const cross = (p: Pt, q: Pt): Pt => {
      const dx1 = q[0] - p[0], dy1 = q[1] - p[1]
      const dx2 = b[0] - a[0], dy2 = b[1] - a[1]
      const den = dx1 * dy2 - dy1 * dx2
      if (Math.abs(den) < 1e-12) return q
      const t = ((a[0] - p[0]) * dy2 - (a[1] - p[1]) * dx2) / den
      return [p[0] + t * dx1, p[1] + t * dy1]
    }
    const input = output
    output = []
    for (let k = 0; k < input.length; k += 1) {
      const cur = input[k]
      const prev = input[(k + input.length - 1) % input.length]
      if (inside(cur)) {
        if (!inside(prev)) output.push(cross(prev, cur))
        output.push(cur)
      } else if (inside(prev)) {
        output.push(cross(prev, cur))
      }
    }
  }
  return output
}

const distanceToSegment = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

const onGreen = (p: Pt, ring: readonly Pt[]) => {
  if (pointInPolygon(p, ring)) return true
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (distanceToSegment(p, ring[j], ring[i]) <= PIN_EDGE_TOLERANCE_YDS) return true
  }
  return false
}

/** Share of a polygon outside a rectangle [minX, maxX, minY, maxY], by 1-yd sampling. */
export const greenShareOutsideDetail = (ring: readonly Pt[], bounds: readonly [number, number, number, number]) => {
  const [minX, maxX, minY, maxY] = bounds
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1])
  let inside = 0, outside = 0
  for (let x = Math.floor(Math.min(...xs)); x <= Math.max(...xs); x += 1) {
    for (let y = Math.floor(Math.min(...ys)); y <= Math.max(...ys); y += 1) {
      if (!pointInPolygon([x, y], ring)) continue
      if (x < minX || x > maxX || y < minY || y > maxY) outside += 1
      else inside += 1
    }
  }
  return inside + outside ? outside / (inside + outside) : 0
}

const unchanged = (status: GreenAnchorStatus, pins = 0, shiftYds: number | null = null) => ({
  surfaces: null,
  green: null,
  summary: { status, shiftYds, radiusYds: null, pins, disk: false, outsideDetail: null },
})

/**
 * The hole's surfaces with the green anchored to GSPro's green, or null
 * surfaces when the rule leaves the hole as it is (summary says why).
 * `detailBounds`: the packaged green-detail grid's [minX, maxX, minY, maxY].
 */
export const anchorGreenToGkd = (
  hole: CourseHoleGeometry,
  layout: NativeCourseLayout,
  registration: NativeRegistration,
  detailBounds: readonly [number, number, number, number] | null = null,
): { surfaces: CourseSurface[] | null; green: CoursePolygonYds | null; summary: GreenAnchorSummary } => {
  const gkdHole = nativeHole(layout, hole.holeNumber)
  const centre = gkdHole ? effectiveGreenCenter(gkdHole) : null
  const C = centre ? nativeWorldToHoleLocalYds(registration, hole.holeNumber, centre.point) : null
  if (!gkdHole || !C) return unchanged('no-gkd-green')
  const pins = gkdHole.pins
    .map((p) => nativeWorldToHoleLocalYds(registration, hole.holeNumber, p))
    .filter((p): p is Pt => p !== null)

  // 1. The OSM green polygon nearest GSPro's centre.
  let pick: { surfaceIndex: number; polygonIndex: number; ring: readonly Pt[]; c: Pt; d: number } | null = null
  hole.surfaces.forEach((surface, surfaceIndex) => {
    if (surface.kind !== 'green') return
    surface.polygons.forEach((ring, polygonIndex) => {
      if (ring.length < 3) return
      const c = centroid(ring)
      const d = Math.hypot(c[0] - C[0], c[1] - C[1])
      if (!pick || d < pick.d) pick = { surfaceIndex, polygonIndex, ring, c, d }
    })
  })
  const chosen = pick as { surfaceIndex: number; polygonIndex: number; ring: readonly Pt[]; c: Pt; d: number } | null
  if (!chosen || chosen.d > MAX_GREEN_SEARCH_YDS) return unchanged('no-osm-green', pins.length)

  // 2. Translate onto GSPro's centre (only 3–25 yd shifts).
  if (chosen.d > MAX_SHIFT_YDS) return unchanged('unanchored', pins.length, chosen.d)
  const shift: Pt = chosen.d >= MIN_SHIFT_YDS ? [C[0] - chosen.c[0], C[1] - chosen.c[1]] : [0, 0]
  const moved: Pt[] = chosen.ring.map((p) => [p[0] + shift[0], p[1] + shift[1]] as const)

  // 3–4. Clip to a disk sized by the pins; grow until every pin is on the green.
  const maxPin = pins.reduce((m, p) => Math.max(m, Math.hypot(p[0] - C[0], p[1] - C[1])), 0)
  let radius = pins.length
    ? Math.min(RADIUS_MAX_YDS, Math.max(RADIUS_MIN_YDS, 1.4 * maxPin + 6))
    : RADIUS_NO_PINS_YDS
  let green: Pt[] = []
  let disk = false
  for (;;) {
    const clipped = clipToConvex(moved, circleRing(C, radius))
    const usable = clipped.length >= 3
      && area(clipped) >= 0.4 * Math.min(Math.PI * radius * radius, area(moved))
    if (!usable) {
      green = circleRing(C, radius)
      disk = true
      break
    }
    if (pins.every((p) => onGreen(p, clipped))) {
      green = clipped
      break
    }
    if (radius + 2 > RADIUS_GROW_LIMIT_YDS) {
      radius = Math.max(radius, maxPin + 4)
      green = circleRing(C, radius)
      disk = true
      break
    }
    radius += 2
  }

  // 5–6. Replace the polygon; the rest of the (moved) OSM green is apron.
  const shiftYds = Math.hypot(shift[0], shift[1])
  const surfaces: CourseSurface[] = hole.surfaces.map((surface, si) => {
    if (si !== chosen.surfaceIndex) return surface
    return {
      ...surface,
      polygons: surface.polygons.map((ring, pi) => (pi === chosen.polygonIndex ? green : ring)),
      provenance: {
        ...surface.provenance,
        source: 'derived',
        confidence: 'high',
        note: `OSM green anchored to GSPro green centre (shift ${shiftYds.toFixed(0)} yd, radius ${radius.toFixed(0)} yd${disk ? ', disk' : ''})`,
      },
    }
  })
  if (area(moved) > area(green) * 1.05) {
    surfaces.push({
      id: `green-apron-${hole.holeNumber}`,
      kind: 'fairway',
      polygons: [moved as CoursePolygonYds],
      provenance: { source: 'derived', confidence: 'medium', note: "OSM green beyond GSPro's green: treated as apron" },
    })
  }
  return {
    surfaces,
    green,
    summary: {
      status: 'anchored',
      shiftYds,
      radiusYds: radius,
      pins: pins.length,
      disk,
      outsideDetail: detailBounds ? greenShareOutsideDetail(green, detailBounds) : null,
    },
  }
}

export const greenAnchorLine = (s: GreenAnchorSummary): string => {
  switch (s.status) {
    case 'anchored':
      return `anchored to GSPro (shift ${s.shiftYds!.toFixed(0)} yd, radius ${s.radiusYds!.toFixed(0)} yd${s.disk ? ', round: map outline unusable' : ''})`
        + (s.outsideDetail != null && s.outsideDetail > 0.15
          ? `; slope data covers ${Math.round((1 - s.outsideDetail) * 100)}% of it` : '')
    case 'unanchored':
      return `map outline (GSPro's green centre is ${s.shiftYds!.toFixed(0)} yd away: check the registration)`
    case 'no-osm-green':
      return 'map outline (no map green within 60 yd of GSPro\'s)'
    case 'no-gkd-green':
      return 'map outline (no GSPro green centre or pins for this hole)'
  }
}
