import { pointInPolygon } from '../courseGeometry/geometry'
import {
  courseGreenSectorAtPoint,
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

const terrainRead = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  pin: CoursePointYds,
  detail: CourseGreenDetail | null,
) => {
  const short6 = shortOf(ball, pin, 6)
  const short12 = shortOf(ball, pin, 12)
  const short20 = shortOf(ball, pin, 20)

  if (detail) {
    const pinZ = sampleCourseGreenElevation(detail, pin)
    const short6Z = sampleCourseGreenElevation(detail, short6)
    const short12Z = sampleCourseGreenElevation(detail, short12)
    const polygon = containingGreen(hole, pin)
    const slope = sampleCourseGreenSlopeAtPoint(detail, pin, polygon)
    const sector = courseGreenSectorAtPoint(detail, pin)
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
      return {
        text: `Strong green slope${sector ? ` on the ${sector.row}-${sector.column} section` : ''}; avoid the downhill side of the target.`,
        shortIsCostly: false,
        longIsCostly: false,
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

const hazardRead = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  pin: CoursePointYds,
) => {
  const hazard = nearestHazardPoint(hole, pin)
  if (!hazard) return { text: null, safeMiss: null }
  const frame = buildAimShotFrame(ball, pin)
  const pinFrame = frame(pin)
  const hazardFrame = frame(hazard.point)
  const lateral = hazardFrame.lateral - pinFrame.lateral
  const forward = hazardFrame.forward - pinFrame.forward
  const depth = forward < -2.5 ? 'short' : forward > 2.5 ? 'long' : null
  const side = lateral < -2.5 ? 'left' : lateral > 2.5 ? 'right' : null
  const where = depth && side ? `${depth}-${side}` : depth ?? side ?? 'near the target'
  const safe: string[] = []
  if (depth === 'short') safe.push('pin-high / slightly long')
  if (depth === 'long') safe.push('pin-high / slightly short')
  if (side === 'left') safe.push('right')
  if (side === 'right') safe.push('left')
  return {
    text: `${hazardName(hazard.kind)} ${where === 'near the target' ? 'is tight to the target' : `guards ${where}`}.`,
    safeMiss: safe.length ? `Favor ${safe.join(' / ')}.` : null,
  }
}

export const buildShotStrategyTacticalRead = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  pin: CoursePointYds,
  detail: CourseGreenDetail | null,
): ShotStrategyTacticalRead => {
  const terrain = terrainRead(hole, ball, pin, detail)
  const hazard = hazardRead(hole, ball, pin)
  const safeMiss = hazard.safeMiss
    ?? (terrain.shortIsCostly
      ? 'Pin-high / slightly long is preferable to short.'
      : terrain.longIsCostly
        ? 'Pin-high / slightly short is preferable to long.'
        : 'Favor the largest available section of green around the target.')

  return {
    terrain: terrain.text,
    hazard: hazard.text,
    safeMiss,
    shortIsCostly: terrain.shortIsCostly,
    longIsCostly: terrain.longIsCostly,
  }
}
