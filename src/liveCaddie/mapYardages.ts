import type { CoursePointYds } from '../courseGeometry/types'

/**
 * Yardage-book numbers for the live map, computed in the map's view frame
 * (ball at the origin, see minimapFrame). Only hazards that are in play get
 * a label: in front of the ball, within reach, and inside the shot corridor
 * around the aim line. For each one we give the distance to reach its front
 * edge and to carry its back edge, measured from the ball along the aim line.
 */

export type HazardKind = 'bunker' | 'water' | 'penalty'

export type HazardYardage = {
  kind: HazardKind
  reachYds: number
  carryYds: number
  /** View-frame point to hang the label on (the hazard's front, on the side of the line it sits). */
  anchor: CoursePointYds
  /** Which side of the aim line most of the hazard sits on. */
  side: 'left' | 'right' | 'center'
}

export type GreenYardage = { frontYds: number; middleYds: number; backYds: number }

type Polygon = readonly CoursePointYds[]

const STEP_YDS = 1.5

/** Where the polygon's boundary crosses lateral offset `v` (aim frame), as along-line distances. */
const crossingsAt = (poly: readonly (readonly [number, number])[], v: number): number[] => {
  const out: number[] = []
  for (let i = 0; i < poly.length; i += 1) {
    const [pu, pv] = poly[i]
    const [qu, qv] = poly[(i + 1) % poly.length]
    if ((pv - v) * (qv - v) > 0 || pv === qv) continue
    const t = (v - pv) / (qv - pv)
    if (t < 0 || t > 1) continue
    out.push(pu + t * (qu - pu))
  }
  return out
}

/** A winding creek's far sections don't count toward "carry" for the near crossing. */
const SAME_SECTION_YDS = 25
/** Hazards of one kind this close together are one carry (a pond and its inlet, a bunker complex). */
const MERGE_GAP_YDS = 3
const ON_LINE_YDS = 6

export const hazardYardages = ({
  hazards,
  aim,
  corridorHalfWidthYds,
  maxReachYds,
  bunkerMinCarryYds = 0,
  limit = 4,
}: {
  hazards: readonly { kind: HazardKind; polygons: readonly Polygon[] }[]
  /** Aim point in the view frame (ball at the origin). */
  aim: CoursePointYds
  corridorHalfWidthYds: number
  maxReachYds: number
  /**
   * Bunkers you fly over long before the ball comes down don't matter;
   * water does (a forced carry). Bunkers whose back edge is short of this are dropped.
   */
  bunkerMinCarryYds?: number
  limit?: number
}): HazardYardage[] => {
  const length = Math.hypot(aim[0], aim[1])
  if (!(length > 1)) return []
  const a: CoursePointYds = [aim[0] / length, aim[1] / length]
  const toAim = ([x, y]: CoursePointYds): [number, number] => [x * a[0] + y * a[1], x * a[1] - y * a[0]]
  const fromAim = (u: number, v: number): CoursePointYds => [u * a[0] + v * a[1], u * a[1] - v * a[0]]
  const w = Math.max(5, corridorHalfWidthYds)

  const found: HazardYardage[] = []
  for (const hazard of hazards) {
    for (const polygon of hazard.polygons) {
      if (polygon.length < 3) continue
      const poly = polygon.map(toAim)
      // Along each ray parallel to the aim line, the first stretch of hazard ahead.
      const rays: { v: number; enter: number; exit: number }[] = []
      const n = Math.ceil(w / STEP_YDS)
      for (let k = -n; k <= n; k += 1) {
        const v = (k / n) * w
        const us = crossingsAt(poly, v).sort((x, y) => x - y)
        for (let i = 0; i + 1 < us.length; i += 2) {
          if (us[i + 1] <= 0) continue
          rays.push({ v, enter: us[i], exit: us[i + 1] })
          break
        }
      }
      if (!rays.length) continue
      // A hazard that crosses the aim line is measured on the line (what you
      // must carry where you're aiming); one beside it, across the corridor.
      const onLine = rays.filter((ray) => Math.abs(ray.v) <= ON_LINE_YDS)
      const measured = onLine.length ? onLine : rays
      const front = measured.reduce((best, ray) => (ray.enter < best.enter ? ray : best))
      const reach = front.enter
      // Ball in (or behind) the hazard, or out of reach.
      if (reach < 3 || reach > maxReachYds) continue
      const section = measured.filter((ray) => ray.enter <= reach + SAME_SECTION_YDS)
      const carry = Math.max(...section.map((ray) => ray.exit))
      const meanV = onLine.length ? 0 : section.reduce((sum, ray) => sum + ray.v, 0) / section.length
      found.push({
        kind: hazard.kind,
        reachYds: Math.round(reach),
        carryYds: Math.round(carry),
        anchor: fromAim(reach, front.v),
        side: meanV > 4 ? 'right' : meanV < -4 ? 'left' : 'center',
      })
    }
  }

  found.sort((x, y) => x.reachYds - y.reachYds)
  const merged: HazardYardage[] = []
  for (const item of found) {
    const prev = [...merged].reverse().find((m) => m.kind === item.kind)
    if (prev && item.reachYds <= prev.carryYds + MERGE_GAP_YDS
        && (item.kind !== 'bunker' || prev.side === item.side)) {
      prev.carryYds = Math.max(prev.carryYds, item.carryYds)
      continue
    }
    merged.push({ ...item })
  }
  return merged
    .filter((item) => item.kind !== 'bunker' || item.carryYds >= bunkerMinCarryYds)
    .slice(0, limit)
}

/** Front / middle / back of the green along the ball-to-pin line (the view frame's +y axis). */
export const greenYardage = (greens: readonly Polygon[]): GreenYardage | null => {
  let front = Number.POSITIVE_INFINITY
  let back = Number.NEGATIVE_INFINITY
  for (const polygon of greens) {
    if (polygon.length < 3) continue
    // In the view frame the pin line is x = 0; swap axes so crossingsAt can use it.
    const poly = polygon.map(([x, y]) => [y, x] as [number, number])
    for (const y of crossingsAt(poly, 0)) {
      front = Math.min(front, y)
      back = Math.max(back, y)
    }
  }
  if (!Number.isFinite(front) || back - front < 2 || front < 0) return null
  return {
    frontYds: Math.round(front),
    middleYds: Math.round((front + back) / 2),
    backYds: Math.round(back),
  }
}
