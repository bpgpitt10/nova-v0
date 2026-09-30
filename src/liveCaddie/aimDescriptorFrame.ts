import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurfaceKind,
} from '../courseGeometry/types'

export type AimShotFramePoint = {
  lateral: number
  forward: number
}

export type AimFrameInterval = {
  min: number
  max: number
  width: number
}

const EPSILON = 1e-9

export const buildAimShotFrame = (ball: CoursePointYds, target: CoursePointYds) => {
  const dx = target[0] - ball[0]
  const dy = target[1] - ball[1]
  const length = Math.hypot(dx, dy)
  const forward: CoursePointYds = length > EPSILON ? [dx / length, dy / length] : [0, 1]
  const right: CoursePointYds = [forward[1], -forward[0]]

  return (point: CoursePointYds): AimShotFramePoint => {
    const px = point[0] - ball[0]
    const py = point[1] - ball[1]
    return {
      lateral: px * right[0] + py * right[1],
      forward: px * forward[0] + py * forward[1],
    }
  }
}

const pairSortedCrossings = (crossings: number[]): AimFrameInterval[] => {
  const sorted = [...crossings].sort((a, b) => a - b)
  const intervals: AimFrameInterval[] = []
  for (let index = 0; index + 1 < sorted.length; index += 2) {
    const min = sorted[index]
    const max = sorted[index + 1]
    if (max - min > EPSILON) intervals.push({ min, max, width: max - min })
  }
  return intervals
}

const projectedPolygon = (
  polygon: CoursePolygonYds,
  project: ReturnType<typeof buildAimShotFrame>,
) => polygon.map(project)

export const polygonIntervalsAtForward = (
  polygons: readonly CoursePolygonYds[],
  project: ReturnType<typeof buildAimShotFrame>,
  forward: number,
): AimFrameInterval[] => {
  const intervals: AimFrameInterval[] = []
  for (const polygon of polygons) {
    const points = projectedPolygon(polygon, project)
    const crossings: number[] = []
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index]
      const end = points[(index + 1) % points.length]
      const delta = end.forward - start.forward
      if (Math.abs(delta) <= EPSILON) continue
      const crosses = (start.forward <= forward && forward < end.forward)
        || (end.forward <= forward && forward < start.forward)
      if (!crosses) continue
      const ratio = (forward - start.forward) / delta
      crossings.push(start.lateral + ratio * (end.lateral - start.lateral))
    }
    intervals.push(...pairSortedCrossings(crossings))
  }
  return intervals
}

export const polygonIntervalsAtLateral = (
  polygons: readonly CoursePolygonYds[],
  project: ReturnType<typeof buildAimShotFrame>,
  lateral: number,
): AimFrameInterval[] => {
  const intervals: AimFrameInterval[] = []
  for (const polygon of polygons) {
    const points = projectedPolygon(polygon, project)
    const crossings: number[] = []
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index]
      const end = points[(index + 1) % points.length]
      const delta = end.lateral - start.lateral
      if (Math.abs(delta) <= EPSILON) continue
      const crosses = (start.lateral <= lateral && lateral < end.lateral)
        || (end.lateral <= lateral && lateral < start.lateral)
      if (!crosses) continue
      const ratio = (lateral - start.lateral) / delta
      crossings.push(start.forward + ratio * (end.forward - start.forward))
    }
    intervals.push(...pairSortedCrossings(crossings))
  }
  return intervals
}

export const chooseAimFrameInterval = (
  intervals: readonly AimFrameInterval[],
  reference: number,
): AimFrameInterval | null => {
  if (intervals.length === 0) return null
  const gap = (interval: AimFrameInterval) => {
    if (reference < interval.min) return interval.min - reference
    if (reference > interval.max) return reference - interval.max
    return 0
  }
  return [...intervals].sort((a, b) => {
    const delta = gap(a) - gap(b)
    if (Math.abs(delta) > EPSILON) return delta
    return b.width - a.width
  })[0]
}

export const surfacePolygonsForAimFrame = (
  hole: CourseHoleGeometry,
  kind: CourseSurfaceKind,
): CoursePolygonYds[] => hole.surfaces
  .filter((surface) => surface.kind === kind)
  .flatMap((surface) => [...surface.polygons])
