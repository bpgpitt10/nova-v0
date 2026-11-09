import type { CourseId } from '../courseGeometry/courseCatalog'
import {
  nativeCourseContextForLive,
  rememberNativePinSlot,
} from '../courseGeometry/nativeCourseRuntime'
import { NATIVE_METERS_TO_YARDS, nativeHole, nativeRouteDistanceM, type NativeHole } from '../courseGeometry/nativeGkd'
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
  courseId, courseKey, holeNumber, roundId, teeLocal, distanceYds, elevationFt = null,
}: Readonly<{
  courseId: CourseId
  courseKey: string | null
  holeNumber: number
  roundId: number | null
  teeLocal: CoursePointYds
  distanceYds: number
  /**
   * GSPro 4's player box also shows the pin's height above (+) or below (−)
   * the ball ("▼ 10ft 11"). Pin slots the same distance from the tee sit
   * across the green, and distance alone can't tell them apart (Valhalla 2,
   * 11/8: Aim by hand, "could put this aim 11 yd off"); their heights usually can.
   */
  elevationFt?: number | null
}>): Promise<Readonly<{
  slot: number | null
  pinLocal: CoursePointYds | null
  note: string
  /** The hole's designer aim points (tee -> AimPoint1 -> AimPoint2 route), hole-local yards. */
  aimPointsLocal: readonly CoursePointYds[]
  /**
   * Where today's pin could be when `pinLocal` is null: the GKD slots whose
   * distance fits the HUD (several, when the match was ambiguous), or every
   * slot when none fits. Bounds the error of an estimated pin for Auto Aim.
   */
  candidatesLocal: readonly CoursePointYds[]
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
  const { ranked, teeY } = rankHudPinSlots(hole, tee, distanceYds, elevationFt)
  const [best, next] = ranked
  const toLocal = (pin: { x: number; z: number }) => nativeWorldToHoleLocalYds(context.registration, holeNumber, pin)
  const fitting = ranked.filter((r) => r.errorM <= HUD_PIN_MAX_ERROR_M)
  const candidatesLocal = (fitting.length ? fitting : ranked)
    .map((r) => toLocal(r.pin))
    .filter((p): p is CoursePointYds => p !== null)
  const note = (best
    ? `nearest pin slot ${best.pin.slot} ${best.errorM.toFixed(1)} m off`
      + (next ? `, next ${next.errorM.toFixed(1)} m` : '')
    : 'no GKD pins for this hole')
    + (elevationFt != null && teeY != null ? `; height ${elevationFt.toFixed(1)} ft kept ${ranked.length} of ${hole.pins.length}` : '')
    + (best && next ? `; next slot ${Math.hypot(next.pin.x - best.pin.x, next.pin.z - best.pin.z).toFixed(1)} m away` : '')
  if (!best || best.errorM > HUD_PIN_MAX_ERROR_M || !clearOfOtherSpots(ranked)) {
    return { slot: null, pinLocal: null, note, aimPointsLocal, candidatesLocal }
  }
  const pinLocal = toLocal(best.pin)
  if (!pinLocal) return { slot: null, pinLocal: null, note, aimPointsLocal, candidatesLocal }
  rememberNativePinSlot(context.courseKey, roundId, holeNumber, best.pin.slot)
  return { slot: best.pin.slot, pinLocal, note, aimPointsLocal, candidatesLocal: [pinLocal] }
}

const HUD_PIN_MAX_ERROR_M = 6
const HUD_PIN_MIN_MARGIN_M = 3
// GSPro shows feet and inches; the GKD tee marker sits a little off the teed ball.
const HUD_PIN_MAX_HEIGHT_ERROR_FT = 1.0
const METERS_TO_FEET = 3.28084

/** The GKD tee marker nearest the ball's tee spot: its height stands in for the ball's. */
const nearestTeeHeightM = (
  hole: { tees: Readonly<Record<string, { x: number; y: number; z: number }>> },
  tee: { x: number; z: number },
): number | null => {
  let best: { y: number; d: number } | null = null
  for (const t of Object.values(hole.tees)) {
    const d = Math.hypot(t.x - tee.x, t.z - tee.z)
    if (!best || d < best.d) best = { y: t.y, d }
  }
  return best && best.d <= 25 ? best.y : null
}

/**
 * GKD pin slots ranked by how well they fit GSPro's player box: distance from
 * the tee first; with GSPro 4's pin height, slots whose height doesn't fit are
 * dropped (unless that would drop them all).
 */
export const rankHudPinSlots = (
  hole: NativeHole,
  tee: Readonly<{ x: number; z: number }>,
  distanceYds: number,
  elevationFt: number | null = null,
) => {
  // The GKD tee is the tee-marker point, not where the ball is teed (FarmLinks:
  // a couple of metres apart), so an exact 0.5 m match failed. Take the pin
  // whose distance is clearly closest: within 6 m, and 3 m better than the next.
  const wantedM = distanceYds / NATIVE_METERS_TO_YARDS
  // On doglegs GSPro's tee distance follows the hole's aim route (tee ->
  // AimPoint1 -> AimPoint2 -> pin), not the straight line: RNK 4 read 371 yd
  // and no pin was within 29 m in a straight line. Take the better of the two.
  let ranked = hole.pins
    .map((pin) => {
      const straightM = Math.hypot(pin.x - tee.x, pin.z - tee.z)
      const routeM = hole.aimPoints.length ? nativeRouteDistanceM({ ...tee, y: 0 }, hole.aimPoints, pin) : straightM
      return { pin, errorM: Math.min(Math.abs(straightM - wantedM), Math.abs(routeM - wantedM)) }
    })
    .sort((a, b) => a.errorM - b.errorM)
  // Height: the pin's height over the tee's, against GSPro's reading.
  const teeY = nearestTeeHeightM(hole, tee)
  const heightFits = (pin: { y: number }) => elevationFt == null || teeY == null
    || Math.abs((pin.y - teeY) * METERS_TO_FEET - elevationFt) <= HUD_PIN_MAX_HEIGHT_ERROR_FT
  // Only among slots the distance already fits: a misread height must not
  // promote a slot from elsewhere on the green.
  const byDistance = ranked.filter((r) => r.errorM <= HUD_PIN_MAX_ERROR_M)
  const byHeight = byDistance.filter((r) => heightFits(r.pin))
  if (byHeight.length > 0 && byHeight.length < byDistance.length) ranked = byHeight
  return { ranked, teeY }
}

/**
 * The best slot is the pin unless another slot fits about as well *and sits
 * somewhere else*. GKDs repeat one pin position across day slots (Valhalla 1,
 * 11/8: "slot 1 0.0 m off, next 0.4 m", four slots, one spot), and two slots
 * on the same spot are not a choice at all.
 */
export const clearOfOtherSpots = (
  ranked: readonly Readonly<{ pin: { x: number; z: number }; errorM: number }>[],
): boolean => {
  const [best] = ranked
  if (!best) return false
  return ranked.slice(1).every((r) => r.errorM - best.errorM >= HUD_PIN_MIN_MARGIN_M
    || Math.hypot(r.pin.x - best.pin.x, r.pin.z - best.pin.z) <= HUD_PIN_SAME_SPOT_M)
}

const HUD_PIN_SAME_SPOT_M = 1.5

