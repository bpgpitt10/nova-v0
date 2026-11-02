import type { CourseId } from '../courseGeometry/courseCatalog'
import {
  nativeCourseContextForLive,
  rememberNativePinSlot,
} from '../courseGeometry/nativeCourseRuntime'
import { NATIVE_METERS_TO_YARDS, nativeHole, resolveNativePinSlot } from '../courseGeometry/nativeGkd'
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
}>): Promise<Readonly<{ slot: number; pinLocal: CoursePointYds }> | null> => {
  if (!Number.isFinite(distanceYds) || distanceYds <= 0) return null
  const context = await nativeCourseContextForLive(courseId, courseKey).catch(() => null)
  if (!context) return null
  const hole = nativeHole(context.layout, holeNumber)
  const tee = nativeHoleLocalYdsToWorld(context.registration, holeNumber, teeLocal)
  if (!hole || !tee) return null
  // GSPro shows 0.1 yd; the GKD tee and pins are exact.
  const match = resolveNativePinSlot(hole, tee, distanceYds / NATIVE_METERS_TO_YARDS, 0.5)
  if (match.status !== 'matched') return null
  const pinLocal = nativeWorldToHoleLocalYds(context.registration, holeNumber, match.pin)
  if (!pinLocal) return null
  rememberNativePinSlot(context.courseKey, roundId, match.pin.slot)
  return { slot: match.pin.slot, pinLocal }
}
