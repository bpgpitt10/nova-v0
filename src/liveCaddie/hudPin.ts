import type { CourseId } from '../courseGeometry/courseCatalog'
import {
  nativeCourseContextForLive,
  rememberNativePinSlot,
} from '../courseGeometry/nativeCourseRuntime'
import { NATIVE_METERS_TO_YARDS, nativeHole, nativeRouteDistanceM } from '../courseGeometry/nativeGkd'
import { nativeHoleLocalYdsToWorld, nativeWorldToHoleLocalYds } from '../courseGeometry/nativeRegistration'
import type { CoursePointYds } from '../courseGeometry/types'

/**
 * Before Shot 1 GSPro writes no distance to its files, and the GKD lists every
 * pin slot for the hole but not the one in play. GSPro's player box shows the
 * exact distance ("Shot 1  492.6 YDS"); the one GKD pin at that distance from
 * the tee is today's pin. Remembered for the round like a pin learned from a
 * shot, so the course-state pipeline uses it too.
 */
export const pinFromHudDistance = async ({
  courseId, courseKey, holeNumber, roundId, teeLocal, distanceYds,
}: Readonly<{
  courseId: CourseId
  courseKey: string | null
  holeNumber: number
  roundId: number | null
  teeLocal: CoursePointYds
  distanceYds: number
}>): Promise<Readonly<{
  slot: number | null
  pinLocal: CoursePointYds | null
  note: string
  /** The hole's designer aim points (tee -> AimPoint1 -> AimPoint2 route), hole-local yards. */
  aimPointsLocal: readonly CoursePointYds[]
}> | null> => {
  if (!Number.isFinite(distanceYds) || distanceYds <= 0) return null
  const context = await nativeCourseContextForLive(courseId, courseKey).catch(() => null)
  if (!context) return null
  const hole = nativeHole(context.layout, holeNumber)
  const tee = nativeHoleLocalYdsToWorld(context.registration, holeNumber, teeLocal)
  if (!hole || !tee) return null
  const aimPointsLocal = hole.aimPoints
    .map((p) => nativeWorldToHoleLocalYds(context.registration, holeNumber, p))
    .filter((p): p is CoursePointYds => p !== null)
  // The GKD tee is the tee-marker point, not where the ball is teed (FarmLinks:
  // a couple of metres apart), so an exact 0.5 m match failed. Take the pin
  // whose distance is clearly closest: within 6 m, and 3 m better than the next.
  const wantedM = distanceYds / NATIVE_METERS_TO_YARDS
  // On doglegs GSPro's tee distance follows the hole's aim route (tee ->
  // AimPoint1 -> AimPoint2 -> pin), not the straight line: RNK 4 read 371 yd
  // and no pin was within 29 m in a straight line. Take the better of the two.
  const ranked = hole.pins
    .map((pin) => {
      const straightM = Math.hypot(pin.x - tee.x, pin.z - tee.z)
      const routeM = hole.aimPoints.length ? nativeRouteDistanceM({ ...tee, y: 0 }, hole.aimPoints, pin) : straightM
      return { pin, errorM: Math.min(Math.abs(straightM - wantedM), Math.abs(routeM - wantedM)) }
    })
    .sort((a, b) => a.errorM - b.errorM)
  const [best, next] = ranked
  const note = best
    ? `nearest pin slot ${best.pin.slot} ${best.errorM.toFixed(1)} m off`
      + (next ? `, next ${next.errorM.toFixed(1)} m` : '')
    : 'no GKD pins for this hole'
  if (!best || best.errorM > HUD_PIN_MAX_ERROR_M
    || (next && next.errorM - best.errorM < HUD_PIN_MIN_MARGIN_M)) {
    return { slot: null, pinLocal: null, note, aimPointsLocal }
  }
  const pinLocal = nativeWorldToHoleLocalYds(context.registration, holeNumber, best.pin)
  if (!pinLocal) return { slot: null, pinLocal: null, note, aimPointsLocal }
  rememberNativePinSlot(context.courseKey, roundId, holeNumber, best.pin.slot)
  return { slot: best.pin.slot, pinLocal, note, aimPointsLocal }
}

const HUD_PIN_MAX_ERROR_M = 6
const HUD_PIN_MIN_MARGIN_M = 3
