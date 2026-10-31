import {
  gkdTeeForTeeSet,
  NATIVE_METERS_TO_YARDS,
  nativeHole,
  nativeStraightDistanceM,
  resolveNativePinSlot,
  resolveNativeTee,
  type NativeXYZ,
} from '../courseGeometry/nativeGkd'
import type { NativeCourseContext } from '../courseGeometry/nativeCourseRuntime'
import { nativeWorldToHoleLocalYds } from '../courseGeometry/nativeRegistration'
import type { CoursePointYds } from '../courseGeometry/types'
import type { BrowserGsproCourseSnapshot } from './browserGsproCourseState'
import type { GsproStartingPositionObservation } from './gsproStartingPosition'

/**
 * Native positions (beta): overlay GKD tee, ball and pin onto a snapshot that
 * the existing pipeline already built. Pure, so it can be tested without a
 * browser. If anything needed is missing, the input snapshot passes through.
 *
 * Tee (before shot 1): GSPro's pre-shot StartingPOS when it sits on a GKD tee,
 *   otherwise the GKD tee for the round's tee set (by GSPro name, e.g. "White",
 *   only once the layout is confirmed; or, for a legacy OSM pick like "Tee 3",
 *   the GKD tee at that map spot).
 * The caller picks the layout (selectNativeLayout) before calling this.
 * Pin: the GKD pin slot that matches GSPro's own DistanceToPin (pre-shot from
 *   the tee, or from the latest shot's end); else the slot learned earlier this
 *   round; else unknown (the existing pin estimate stays).
 * Distance to pin before shot 1: straight line tee -> pin slot in GSPro metres.
 */

export type NativeSnapshotInputs = Readonly<{
  base: BrowserGsproCourseSnapshot
  context: NativeCourseContext
  holeNumber: number
  teeContext: boolean
  preShotStart: GsproStartingPositionObservation | null
  normalizedTeeSet: string | null
  rememberedPinSlot: number | null
  /** Map position of the round's OSM tee pick, for legacy names like "Tee 3". */
  legacyTeeLocal?: CoursePointYds | null
}>

const LEGACY_TEE_MATCH_YDS = 10
const LEGACY_TEE_NOTE = /^Provisional Hole \d+ tee \(/

export type NativeSnapshotResult = Readonly<{
  snapshot: BrowserGsproCourseSnapshot
  pinSlot: number | null
}>

const NATIVE_NOTE = 'Native positions (beta): tee, ball and pin placed from GSPro coordinates using the LiDAR-verified course registration.'

const yards = (metres: number) => metres * NATIVE_METERS_TO_YARDS

export const applyNativeCourseSnapshot = ({
  base,
  context,
  holeNumber,
  teeContext,
  preShotStart,
  normalizedTeeSet,
  rememberedPinSlot,
  legacyTeeLocal = null,
}: NativeSnapshotInputs): NativeSnapshotResult => {
  const hole = nativeHole(context.layout, holeNumber)
  if (!hole) return { snapshot: base, pinSlot: rememberedPinSlot }
  const toLocal = (world: Readonly<{ x: number; z: number }>) =>
    nativeWorldToHoleLocalYds(context.registration, holeNumber, world)

  // Pin slot from GSPro's own straight distance, wherever we can observe one.
  let pinSlot = rememberedPinSlot
  let pinErrorYds: number | null = null
  const preShotPin = teeContext && preShotStart?.world && preShotStart.distanceToPinYds != null
    ? resolveNativePinSlot(hole, preShotStart.world, preShotStart.distanceToPinYds / NATIVE_METERS_TO_YARDS)
    : null
  const latest = base.latestShot
  const latestPin = !preShotPin || preShotPin.status !== 'matched'
    ? latest?.holeNumber === holeNumber && latest.endWorld && latest.distanceToPinYds != null
      ? resolveNativePinSlot(hole, latest.endWorld, latest.distanceToPinYds / NATIVE_METERS_TO_YARDS)
      : null
    : null
  const observed = preShotPin?.status === 'matched' ? preShotPin : latestPin?.status === 'matched' ? latestPin : null
  if (observed) {
    pinSlot = observed.pin.slot
    pinErrorYds = yards(observed.errorM)
  }
  const pin = pinSlot != null ? hole.pins.find((p) => p.slot === pinSlot) ?? null : null
  const pinLocal = pin ? toLocal(pin) : null
  const withPin: BrowserGsproCourseSnapshot = pinLocal
    ? { ...base, pinLocalYds: pinLocal, pinSource: 'native-gkd', pinDistanceValidationErrorYds: pinErrorYds }
    : base

  if (!teeContext) {
    return { snapshot: withPin, pinSlot }
  }

  const nearestGkdTeeTo = (local: CoursePointYds | null): NativeXYZ | null => {
    if (!local) return null
    let best: { tee: NativeXYZ; d: number } | null = null
    for (const tee of Object.values(hole.tees)) {
      const p = toLocal(tee)
      if (!p) continue
      const d = Math.hypot(p[0] - local[0], p[1] - local[1])
      if (d <= LEGACY_TEE_MATCH_YDS && (!best || d < best.d)) best = { tee, d }
    }
    return best?.tee ?? null
  }
  const preShotOnTee = preShotStart?.world && resolveNativeTee(hole, preShotStart.world).status !== 'no-match'
    ? preShotStart.world : null
  // By-name lookup only once the layout is known: an alternate layout's
  // "White" can be 70 m from the main layout's "White".
  const teeWorld: NativeXYZ | null = preShotOnTee
    ?? (context.layoutConfirmed ? gkdTeeForTeeSet(hole, normalizedTeeSet) : null)
    ?? nearestGkdTeeTo(legacyTeeLocal)
  const ball = teeWorld ? toLocal(teeWorld) : null
  if (!teeWorld || !ball) return { snapshot: withPin, pinSlot }

  const distanceToPinYds = pin
    ? yards(nativeStraightDistanceM(teeWorld, pin))
    : preShotStart?.distanceToPinYds
      ?? (hole.greenCenter ? yards(nativeStraightDistanceM(teeWorld, hole.greenCenter)) : withPin.distanceToPinYds)

  return {
    pinSlot,
    snapshot: {
      ...withPin,
      holeNumber,
      ballLocalYds: ball,
      ballSource: 'native-gkd',
      teePlacement: 'mapped',
      teeUncertaintyYds: 1,
      surface: preShotStart?.surface ?? 'tee',
      surfaceSource: preShotStart ? 'gspro-startingpos' : 'cached-tee',
      distanceToPinYds,
      nextShotNumber: 1,
      // The tee is now GSPro's own; drop the legacy "Provisional Hole N tee"
      // estimate note that described the position this replaces.
      warnings: [...new Set([...withPin.warnings.filter((w) => !LEGACY_TEE_NOTE.test(w)), NATIVE_NOTE])],
    },
  }
}
