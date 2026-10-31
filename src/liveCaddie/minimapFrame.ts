import type { CoursePointYds } from '../courseGeometry/types'

/** Screen axes of the minimap view in hole-local yards: `up` toward the pin, `right` to the golfer's right. */
export const minimapBasis = (ball: CoursePointYds, upTo: CoursePointYds) => {
  const dx = upTo[0] - ball[0]
  const dy = upTo[1] - ball[1]
  const length = Math.hypot(dx, dy)
  const up: CoursePointYds = length > 1e-9 ? [dx / length, dy / length] : [0, 1]
  const right: CoursePointYds = [up[1], -up[0]]
  return { up, right }
}

/**
 * GSPro's minimap always puts the ball at the bottom with the pin straight
 * above it. This frame turns hole-local yards into that view: origin at the
 * ball, +y toward `upTo` (the pin), +x to the golfer's right. It is a pure
 * rotation (no mirroring), so distances and left/right are preserved.
 */
export const minimapFrame = (ball: CoursePointYds, upTo: CoursePointYds) => {
  const { up, right } = minimapBasis(ball, upTo)
  return (point: CoursePointYds): CoursePointYds => {
    const px = point[0] - ball[0]
    const py = point[1] - ball[1]
    return [px * right[0] + py * right[1], px * up[0] + py * up[1]]
  }
}
