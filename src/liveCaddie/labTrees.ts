/**
 * Trees and the partial-wedge flights (Brian, 23 Nov).
 *
 * A wedge from 40 to 90 yd peaks around 6 to 12 yd up: under a tree's canopy for most of its flight.
 * Each flight is checked along its own line and height against the mapped trees. Chips are not
 * checked: they fly too low and too short for trees on the line to matter, unless the ball is in
 * them, which the card says on its own.
 *
 * Only mapped tree areas are known. A single tree beside a fairway is usually not on the map.
 */
import { woodsNear } from '../courseGeometry/tacticalClassification'
import type { CourseHoleGeometry, CoursePointYds } from '../courseGeometry/types'
import { ballHeightAt } from './aimOutcomeSampling'

/** How tall a mapped tree is taken to be, yards. */
const TREE_HEIGHT_YDS = 15
/** Trees this far either side of the line are close enough to mention. */
const CLOSE_YDS = 5
const STEP_YDS = 3
/** The first few yards are the swing, not the flight. */
const FROM_YDS = 6

export type FlightTrees = 'blocked' | 'close-left' | 'close-right' | 'close-both' | null

/**
 * Peak height of a wedge flight, yards. From GSPro: 55 yd carry at 29° launch, about 38° descent,
 * peaks at 29 ft (9.8 yd); two straight lines at those angles would meet at 17.8.
 */
export const wedgePeakYds = (carryYds: number, launchDeg: number, descentDeg: number) => {
  const up = Math.tan((launchDeg * Math.PI) / 180)
  const down = Math.tan((descentDeg * Math.PI) / 180)
  return up + down > 0 ? (0.55 * carryYds * up * down) / (up + down) : 0
}

/** Two checks in a row inside mapped trees while below their tops: the flight goes into them. */
const fliesInto = (
  hole: CourseHoleGeometry, from: CoursePointYds, ux: number, uy: number,
  carryYds: number, peakYds: number, descentDeg: number,
) => {
  let previous = false
  for (let d = FROM_YDS; d <= carryYds - 2; d += STEP_YDS) {
    const low = ballHeightAt(d, carryYds, peakYds, descentDeg) < TREE_HEIGHT_YDS
    const inside = low && woodsNear(hole, [from[0] + ux * d, from[1] + uy * d])
    if (inside && previous) return true
    previous = inside
  }
  return false
}

/** For one ball and pin: what the mapped trees do to a flight of this carry, launch and descent. */
export const flightTreesFor = (hole: CourseHoleGeometry, ball: CoursePointYds, pin: CoursePointYds) => {
  const distance = Math.hypot(pin[0] - ball[0], pin[1] - ball[1])
  const ux = distance > 0 ? (pin[0] - ball[0]) / distance : 0
  const uy = distance > 0 ? (pin[1] - ball[1]) / distance : 1
  return (flight: Readonly<{ carryYds: number; launchDeg: number; descentDeg: number }>): FlightTrees => {
    if (!(distance > 1) || !(flight.carryYds > FROM_YDS + STEP_YDS)) return null
    const peak = wedgePeakYds(flight.carryYds, flight.launchDeg, flight.descentDeg)
    const along = (sideYds: number) => fliesInto(
      hole, [ball[0] + uy * sideYds, ball[1] - ux * sideYds], ux, uy, flight.carryYds, peak, flight.descentDeg)
    if (along(0)) return 'blocked'
    const right = along(CLOSE_YDS)
    const left = along(-CLOSE_YDS)
    return left && right ? 'close-both' : left ? 'close-left' : right ? 'close-right' : null
  }
}
