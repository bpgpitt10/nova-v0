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
import type { BrowserGsproCourseSnapshot } from './browserGsproCourseState'
import type { GsproStartingPositionObservation } from './gsproStartingPosition'

/**
 * Native positions (beta): overlay GKD tee, ball and pin onto a snapshot that
 * the existing pipeline already built. Pure, so it can be tested without a
 * browser. If anything needed is missing, the input snapshot passes through.
 *
 * Tee (before shot 1): GSPro's pre-shot StartingPOS when it sits on a GKD tee,
 *   otherwise the GKD tee for the round's tee set.
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
}>

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

  const preShotOnTee = preShotStart?.world && resolveNativeTee(hole, preShotStart.world).status !== 'no-match'
    ? preShotStart.world : null
  const teeWorld: NativeXYZ | null = preShotOnTee ?? gkdTeeForTeeSet(hole, normalizedTeeSet)
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
      warnings: [...new Set([...withPin.warnings, NATIVE_NOTE])],
    },
  }
}
