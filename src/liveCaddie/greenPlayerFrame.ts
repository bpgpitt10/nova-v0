import type { CoursePointYds, CoursePolygonYds } from '../courseGeometry/types'
import {
  buildAimShotFrame,
  chooseAimFrameInterval,
  polygonIntervalsAtForward,
  polygonIntervalsAtLateral,
} from './aimDescriptorFrame'

/**
 * Green language in the GOLFER's frame.
 *
 * Course geometry is hole-local (x = right, y = forward along the tee→green
 * route). That is not where the golfer is standing: from a dogleg, a recovery
 * or an angled approach, the hole's "back" can be the player's right. Every
 * word the golfer reads about a green (pin position, which way it slopes,
 * which side leaves an uphill putt) is therefore expressed relative to the
 * ball→pin line here.
 *
 *   lateral > 0  → right of the line, as seen from the ball
 *   away    > 0  → farther from the ball (the player's "back" / "past")
 */

export type PlayerFrameDirection = { lateral: number; away: number }

/** Below this component a direction is not called (matches the old hole-frame labels). */
const COMPONENT_THRESHOLD = 0.35

const unit = (from: CoursePointYds, to: CoursePointYds): CoursePointYds | null => {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy)
  return length > 1e-8 ? [dx / length, dy / length] : null
}

/** Rotate a hole-local direction (e.g. a downhill unit vector) into the ball→pin frame. */
export const toPlayerFrameDirection = (
  ball: CoursePointYds,
  pin: CoursePointYds,
  holeLocalDirection: CoursePointYds,
): PlayerFrameDirection | null => {
  const forward = unit(ball, pin)
  if (!forward) return null
  const right: CoursePointYds = [forward[1], -forward[0]]
  return {
    lateral: holeLocalDirection[0] * right[0] + holeLocalDirection[1] * right[1],
    away: holeLocalDirection[0] * forward[0] + holeLocalDirection[1] * forward[1],
  }
}

type Side = 'left' | 'right'
type Depth = 'toward' | 'away'

const parts = (direction: PlayerFrameDirection): { side: Side | null; depth: Depth | null } => ({
  side: Math.abs(direction.lateral) >= COMPONENT_THRESHOLD
    ? direction.lateral > 0 ? 'right' : 'left'
    : null,
  depth: Math.abs(direction.away) >= COMPONENT_THRESHOLD
    ? direction.away > 0 ? 'away' : 'toward'
    : null,
})

/**
 * "toward you", "away from you and to the right", "to the left"… for a downhill
 * direction already in the player frame. Null when no component is strong enough.
 */
export const describeFall = (downhill: PlayerFrameDirection): string | null => {
  const { side, depth } = parts(downhill)
  const depthWords = depth === 'toward' ? 'toward you' : depth === 'away' ? 'away from you' : null
  const sideWords = side ? `to the ${side}` : null
  if (depthWords && sideWords) return `${depthWords} and ${sideWords}`
  return depthWords ?? sideWords
}

/**
 * Where to leave the ball for an uphill putt: on the LOW side of the hole,
 * i.e. in the downhill direction from the pin. A green that falls toward you
 * and to the right wants the ball short and right of the hole.
 */
export const uphillPuttSide = (downhill: PlayerFrameDirection): string | null => {
  const { side, depth } = parts(downhill)
  if (depth === 'toward') return side ? `short and ${side} of the hole` : 'short of the hole'
  if (depth === 'away') return side ? `past the hole and to the ${side}` : 'past the hole'
  if (side) return `${side} of the hole`
  return null
}

/** The high (uphill) lateral side of the green, as seen from the ball. */
export const highSide = (downhill: PlayerFrameDirection): Side | null => {
  const { side } = parts(downhill)
  if (!side) return null
  return side === 'right' ? 'left' : 'right'
}

export type PlayerPinPlacement = {
  depth: 'front' | 'middle' | 'back'
  side: 'left' | 'center' | 'right'
  /** "front left", "back", "middle right", "in the middle" */
  text: string
}

/**
 * Pin position on the actual green polygon as the golfer sees it from the
 * ball: front/middle/back along the ball→pin line, left/center/right across it.
 * Same proportional thresholds as the aim descriptor's green zones.
 */
export const pinPlacementFromBall = (
  ball: CoursePointYds,
  pin: CoursePointYds,
  green: CoursePolygonYds,
): PlayerPinPlacement | null => {
  const project = buildAimShotFrame(ball, pin)
  const flag = project(pin)
  const across = chooseAimFrameInterval(
    polygonIntervalsAtForward([green], project, flag.forward),
    flag.lateral,
  )
  const along = chooseAimFrameInterval(
    polygonIntervalsAtLateral([green], project, flag.lateral),
    flag.forward,
  )
  if (!across || !along || across.width < 1 || along.width < 1) return null

  const lateralPosition = (flag.lateral - across.min) / across.width
  const depthPosition = (flag.forward - along.min) / along.width
  const side = lateralPosition < 0.34 ? 'left' : lateralPosition > 0.66 ? 'right' : 'center'
  const depth = depthPosition < 0.30 ? 'front' : depthPosition > 0.70 ? 'back' : 'middle'
  const text = depth === 'middle' && side === 'center'
    ? 'in the middle'
    : side === 'center'
      ? depth
      : `${depth} ${side}`
  return { depth, side, text }
}
