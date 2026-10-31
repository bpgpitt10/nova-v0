import { pointInPolygon } from '../courseGeometry/geometry'
import {
  sampleCourseGreenElevation,
  type CourseGreenDetail,
} from '../courseGeometry/courseGreenDetail'
import { estimateGreywolfTerrain as estimateCourseTerrain } from '../courseGeometry/lidar'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurfaceKind,
} from '../courseGeometry/types'
import { buildAimShotFrame } from './aimDescriptorFrame'
import { describeFall, highSide, toPlayerFrameDirection } from './greenPlayerFrame'
import { sampleCourseGreenSlopeAtPoint } from './greenTargeting'

export type ShotStrategyTacticalRead = {
  terrain: string
  hazard: string | null
  safeMiss: string
  shortIsCostly: boolean
  longIsCostly: boolean
}

const distance = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(a[0] - b[0], a[1] - b[1])

const unit = (from: CoursePointYds, to: CoursePointYds): CoursePointYds => {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy)
  return length > 1e-9 ? [dx / length, dy / length] : [0, 1]
}

const shortOf = (
  ball: CoursePointYds,
  pin: CoursePointYds,
  yards: number,
): CoursePointYds => {
  const forward = unit(ball, pin)
  return [pin[0] - forward[0] * yards, pin[1] - forward[1] * yards]
}

const containingGreen = (
  hole: CourseHoleGeometry,
  point: CoursePointYds,
): CoursePolygonYds | null => {
  for (const surface of hole.surfaces) {
    if (surface.kind !== 'green') continue
    for (const polygon of surface.polygons) {
      if (pointInPolygon(point, polygon)) return polygon
    }
  }
  return null
}

type TerrainRead = {
  text: string
  shortIsCostly: boolean
  longIsCostly: boolean
  /** High lateral side of a strongly sloped target, as seen from the ball. */
  highSide?: 'left' | 'right' | null
}

const terrainRead = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  pin: CoursePointYds,
  detail: CourseGreenDetail | null,
): TerrainRead => {
  const short6 = shortOf(ball, pin, 6)
  const short12 = shortOf(ball, pin, 12)
  const short20 = shortOf(ball, pin, 20)

  if (detail) {
    const pinZ = sampleCourseGreenElevation(detail, pin)
    const short6Z = sampleCourseGreenElevation(detail, short6)
    const short12Z = sampleCourseGreenElevation(detail, short12)
    const polygon = containingGreen(hole, pin)
    const slope = sampleCourseGreenSlopeAtPoint(detail, pin, polygon)
    const rise6 = pinZ != null && short6Z != null ? pinZ - short6Z : null
    const rise12 = pinZ != null && short12Z != null ? pinZ - short12Z : null

    if ((rise6 != null && rise6 >= 2.2) || (rise12 != null && rise12 >= 3.5)) {
      return {
        text: 'Pin sits on a steep rise / shelf. A short miss finishes well below the hole; full carry matters.',
        shortIsCostly: true,
        longIsCostly: false,
      }
    }
    if ((rise6 != null && rise6 >= 1.1) || (rise12 != null && rise12 >= 2)) {
      return {
        text: 'Target area rises into the pin. Short leaves the more difficult uphill recovery.',
        shortIsCostly: true,
        longIsCostly: false,
      }
    }
    if ((rise6 != null && rise6 <= -2.2) || (rise12 != null && rise12 <= -3.5)) {
      return {
        text: 'Target area falls through the pin. Long leaves the more difficult terrain miss.',
        shortIsCostly: false,
        longIsCostly: true,
      }
    }
    if (slope && slope.slopePercent <= 2 && Math.abs(rise12 ?? 0) <= 1.5) {
      return {
        text: 'Target area is relatively flat.',
        shortIsCostly: false,
        longIsCostly: false,
      }
    }
    if (slope && slope.slopePercent >= 5) {
      // Player frame, not the hole's sector grid: the golfer's "right" is what matters.
      const downhill = toPlayerFrameDirection(ball, pin, slope.downhill)
      const fall = downhill ? describeFall(downhill) : null
      const high = downhill ? highSide(downhill) : null
      return {
        text: fall
          ? `Strong green slope falling ${fall}; keep it on the high side of the target.`
          : 'Strong green slope at the target; keep it on the high side.',
        shortIsCostly: false,
        longIsCostly: false,
        highSide: high,
      }
    }
  }

  const pinTerrain = estimateCourseTerrain(hole, pin)
  const short12Terrain = estimateCourseTerrain(hole, short12)
  const short20Terrain = estimateCourseTerrain(hole, short20)
  const rise12 = pinTerrain && short12Terrain
    ? pinTerrain.elevationFt - short12Terrain.elevationFt
    : null
  const rise20 = pinTerrain && short20Terrain
    ? pinTerrain.elevationFt - short20Terrain.elevationFt
    : null

  if ((rise12 != null && rise12 >= 4) || (rise20 != null && rise20 >= 6)) {
    return {
      text: 'Steep rise into the target. A short miss stays well below the hole; full carry matters.',
      shortIsCostly: true,
      longIsCostly: false,
    }
  }
  if ((rise12 != null && rise12 <= -4) || (rise20 != null && rise20 <= -6)) {
    return {
      text: 'Target sits on a meaningful downslope. Long leaves the more difficult terrain miss.',
      shortIsCostly: false,
      longIsCostly: true,
    }
  }

  return {
    text: 'No major green-terrain warning at the target.',
    shortIsCostly: false,
    longIsCostly: false,
  }
}

type HazardKind = Extract<CourseSurfaceKind, 'bunker' | 'water' | 'penalty' | 'deep-rough'>

const hazardName = (kind: HazardKind) => {
  if (kind === 'water') return 'Water'
  if (kind === 'penalty') return 'Penalty area'
  if (kind === 'deep-rough') return 'Deep rough / woods'
  return 'Bunker'
}

/**
 * Nearest polygon EDGE, not merely nearest vertex. A bunker can have a long
 * straight side one yard from the target with vertices 100 yards away.
 * A target *inside* the hazard is explicitly distance zero.
 */
export const closestPointOnHazardEdge = (
  target: CoursePointYds,
  polygon: CoursePolygonYds,
): { point: CoursePointYds; distanceYds: number } | null => {
  if (polygon.length === 0) return null
  if (pointInPolygon(target, polygon)) return { point: target, distanceYds: 0 }
  let best: { point: CoursePointYds; distanceYds: number } | null = null
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index]
    const b = polygon[(index + 1) % polygon.length]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const lengthSquared = dx * dx + dy * dy
    const t = lengthSquared > 1e-10
      ? Math.max(0, Math.min(1, ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / lengthSquared))
      : 0
    const point: CoursePointYds = [a[0] + t * dx, a[1] + t * dy]
    const distanceYds = distance(target, point)
    if (!best || distanceYds < best.distanceYds) best = { point, distanceYds }
  }
  return best
}

const nearestHazardPoint = (
  hole: CourseHoleGeometry,
  target: CoursePointYds,
): { kind: HazardKind; point: CoursePointYds; distanceYds: number } | null => {
  const allowed = new Set<HazardKind>(['bunker', 'water', 'penalty', 'deep-rough'])
  let best: { kind: HazardKind; point: CoursePointYds; distanceYds: number } | null = null
  for (const surface of hole.surfaces) {
    if (!allowed.has(surface.kind as HazardKind)) continue
    for (const polygon of surface.polygons) {
      const nearest = closestPointOnHazardEdge(target, polygon)
      if (!nearest || nearest.distanceYds > 28) continue
      if (!best || nearest.distanceYds < best.distanceYds) {
        best = { kind: surface.kind as HazardKind, ...nearest }
      }
    }
  }
  return best
}

type HazardRead = {
  text: string | null
  /** Set only when the target itself is inside a mapped hazard. */
  overrideSafeMiss: string | null
  name: string | null
  depth: 'short' | 'long' | null
  side: 'left' | 'right' | null
}

const NO_HAZARD: HazardRead = { text: null, overrideSafeMiss: null, name: null, depth: null, side: null }

const hazardRead = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  pin: CoursePointYds,
): HazardRead => {
  const hazard = nearestHazardPoint(hole, pin)
  if (!hazard) return NO_HAZARD
  if (hazard.distanceYds <= 1e-8) {
    // A mapped hazard containing the pin/target is not a "no danger"
    // scenario. Without a verified landing alternative, warn rather than
    // invent an exact safe-side instruction.
    return {
      ...NO_HAZARD,
      text: `${hazardName(hazard.kind)} overlaps the mapped target location.`,
      overrideSafeMiss: 'Do not plan a landing inside this mapped hazard; favor verified clear ground.',
      name: hazardName(hazard.kind),
    }
  }
  const frame = buildAimShotFrame(ball, pin)
  const pinFrame = frame(pin)
  const hazardFrame = frame(hazard.point)
  const lateral = hazardFrame.lateral - pinFrame.lateral
  const forward = hazardFrame.forward - pinFrame.forward
  const depth = forward < -2.5 ? 'short' : forward > 2.5 ? 'long' : null
  const side = lateral < -2.5 ? 'left' : lateral > 2.5 ? 'right' : null
  const where = depth && side ? `${depth}-${side}` : depth ?? side ?? 'near the target'
  return {
    text: `${hazardName(hazard.kind)} ${where === 'near the target' ? 'is tight to the target' : `guards ${where}`}.`,
    overrideSafeMiss: null,
    name: hazardName(hazard.kind),
    depth,
    side,
  }
}

/**
 * One safe-miss line that agrees with BOTH reads. Previously a short hazard
 * always produced "favor slightly long", even when the terrain line had just
 * said long was the costly miss. Now short/long cost is the union of the
 * hazard and terrain signals, and when both are costly we say so.
 */
const resolveSafeMiss = (hazard: HazardRead, terrain: TerrainRead): string => {
  if (hazard.overrideSafeMiss) return hazard.overrideSafeMiss

  const shortIsCostly = hazard.depth === 'short' || terrain.shortIsCostly
  const longIsCostly = hazard.depth === 'long' || terrain.longIsCostly
  const lateral = hazard.side === 'left'
    ? 'right'
    : hazard.side === 'right'
      ? 'left'
      : terrain.highSide
        ? `the high (${terrain.highSide}) side`
        : null

  if (shortIsCostly && longIsCostly) {
    const shortWhy = hazard.depth === 'short' ? `${hazard.name?.toLowerCase() ?? 'hazard'} short` : 'short stays well below the hole'
    const longWhy = hazard.depth === 'long' ? `${hazard.name?.toLowerCase() ?? 'hazard'} long` : 'the slope runs it away long'
    return `Distance control matters: ${shortWhy}, ${longWhy}. Commit to pin-high${lateral ? `, favoring ${lateral}` : ''}.`
  }

  const parts: string[] = []
  if (shortIsCostly) parts.push('pin-high / slightly long')
  if (longIsCostly) parts.push('pin-high / slightly short')
  if (lateral) parts.push(lateral)
  if (parts.length) return `Favor ${parts.join(' / ')}.`
  return 'Favor the largest available section of green around the target.'
}

export const buildShotStrategyTacticalRead = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  pin: CoursePointYds,
  detail: CourseGreenDetail | null,
): ShotStrategyTacticalRead => {
  const terrain = terrainRead(hole, ball, pin, detail)
  const hazard = hazardRead(hole, ball, pin)
  const safeMiss = resolveSafeMiss(hazard, terrain)

  return {
    terrain: terrain.text,
    hazard: hazard.text,
    safeMiss,
    shortIsCostly: terrain.shortIsCostly,
    longIsCostly: terrain.longIsCostly,
  }
}
