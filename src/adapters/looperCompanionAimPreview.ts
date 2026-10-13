/**
 * READ-ONLY bridge from canonical Live Caddie shot/target to provisional native
 * minimap pixels. The only authority for the shot is BrowserGsproCourseSnapshot
 * (via the existing Live Caddie aim intent). Python's last_completed record
 * must never become a new current-hole/ball source.
 *
 * GSPro and Looper hole-local frames are NOT proven identical. Even on a
 * matching geometry/shot this module returns candidate-unverified and never
 * constructs an actuator request, desktop click, or pairing authorization.
 */
import type { LooperCompanionLiveObservations } from './looperCompanion'
import type { ReadOnlyNativeAimIntent } from './looperCompanionAim'

type Pixel = { x: number; y: number }
export type ReadOnlyNativeAimPreview = {
  status: 'blocked' | 'candidate-unverified'
  reason: string
  shotMatch: 'none' | 'matching-pre-shot' | 'matching-last-completed'
  coordinateFrame: 'gspro-minimap-roi-unverified'
  nativeInputAuthorized: false
  targetPixel: Pixel | null
  projectedBallErrorYds: number | null
  teePinAnchorErrorYds: number | null
  roiWidthPx: number | null
  roiHeightPx: number | null
}

const ACCEPTABLE_AGE_MS = 60000
const MAX_ANCHOR_ERROR_YDS = 10
const MAX_CURRENT_BALL_ERROR_YDS = 12
const MAX_PIN_REGISTRATION_ERROR_PX = 3

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const validPixel = (v: unknown): v is Pixel => {
  if (!v || typeof v !== 'object') return false
  const p = v as Pixel
  return finite(p.x) && finite(p.y)
}
const distance = (a: Pixel, b: Pixel) => Math.hypot(a.x - b.x, a.y - b.y)
const norm = (x: number, y: number): [number, number] | null => {
  const length = Math.hypot(x, y)
  return length >= 1e-6 && Number.isFinite(length) ? [x / length, y / length] : null
}
const round = (n: number) => Math.round(n * 100) / 100

const block = (
  reason: string,
  shotMatch: ReadOnlyNativeAimPreview['shotMatch'] = 'none',
  anchorError: number | null = null,
  ballError: number | null = null,
): ReadOnlyNativeAimPreview => ({
  status: 'blocked',
  reason,
  shotMatch,
  coordinateFrame: 'gspro-minimap-roi-unverified',
  nativeInputAuthorized: false,
  targetPixel: null,
  projectedBallErrorYds: ballError,
  teePinAnchorErrorYds: anchorError,
  roiWidthPx: null,
  roiHeightPx: null,
})

type Matrix = [[number, number, number], [number, number, number]]
const canonicalToCurrent = (matrix: Matrix, target: Pixel): Pixel | null => {
  const [[a, b, tx], [c, d, ty]] = matrix
  if (![a, b, tx, c, d, ty].every(finite)) return null
  const det = a * d - b * c
  if (!finite(det) || Math.abs(det) < 1e-9) return null
  const dx = target.x - tx
  const dy = target.y - ty
  return { x: (d * dx - b * dy) / det, y: (-c * dx + a * dy) / det }
}

/** Mirrors the proven helpers/auto_aim_transform.py tee/pin axis math.
 * x/y source coordinates are [rightYds,forwardYds] (NOT GSPro world X/Z).
 */
const courseToCanonical = (
  point: readonly [number, number],
  tee: readonly [number, number],
  pin: readonly [number, number],
  canonicalTee: Pixel,
  canonicalPin: Pixel,
  ypp: number,
): Pixel | null => {
  const courseForward = norm(pin[0] - tee[0], pin[1] - tee[1])
  const screenForward = norm(canonicalPin.x - canonicalTee.x, canonicalPin.y - canonicalTee.y)
  if (!courseForward || !screenForward || !finite(ypp) || ypp <= 0) return null
  const [cfx, cfy] = courseForward
  const [pfx, pfy] = screenForward
  // Course "right" follows previous Python model; pixel y axis points down.
  const dx = point[0] - tee[0], dy = point[1] - tee[1]
  const forward = dx * cfx + dy * cfy
  const right = dx * cfy - dy * cfx
  return {
    x: canonicalTee.x + (forward * pfx - right * pfy) / ypp,
    y: canonicalTee.y + (forward * pfy + right * pfx) / ypp,
  }
}

/** Actual pixels are only a diagnostic overlay; never an executable aim. */
export const prepareReadOnlyNativeAimPreview = (
  intent: ReadOnlyNativeAimIntent | null,
  native: LooperCompanionLiveObservations | null,
  nowMs = Date.now(),
): ReadOnlyNativeAimPreview => {
  if (!intent) return block('No fresh authoritative Live Caddie shot and selected club/target.')
  if (!native || native.status !== 'ready' || native.stateAuthority !== 'diagnostic-only'
      || native.capabilities?.autoAim !== false) {
    return block('No compatible read-only native companion observation.')
  }
  if (native.gspro?.status !== 'connected' || native.gspro.window?.minimized !== false
      || native.gspro.window.dpiAwareness !== 'per-monitor') {
    return block('GSPro window or DPI state is not safe for minimap alignment.')
  }
  const obsAt = Date.parse(native.observedAt ?? '')
  const liveAt = Date.parse(intent.observedAt)
  if (!finite(nowMs) || !finite(obsAt) || !finite(liveAt)
      || nowMs - obsAt > ACCEPTABLE_AGE_MS || nowMs - liveAt > ACCEPTABLE_AGE_MS
      || obsAt - nowMs > 10000 || liveAt - nowMs > 10000) {
    return block('Live shot or native window observation is stale.')
  }
  const nativeShot = native.structured?.shot
  if (!nativeShot || nativeShot.courseKey !== intent.gsproCourseKey
      || String(nativeShot.roundId ?? '') !== String(intent.roundId)
      || nativeShot.holeNumber !== intent.holeNumber) {
    return block('Native record differs from Live Caddie course, round or hole.')
  }
  let shotMatch: ReadOnlyNativeAimPreview['shotMatch'] = 'none'
  if (nativeShot.kind === 'pre_shot' && nativeShot.status === 'ready'
      && nativeShot.shotNumber === intent.nextShotNumber) {
    shotMatch = 'matching-pre-shot'
  } else if (nativeShot.kind === 'last_completed'
      && nativeShot.status === 'completed_record_only'
      && intent.lastCompletedShotId && nativeShot.shotId === intent.lastCompletedShotId
      && nativeShot.shotNumber === intent.nextShotNumber - 1) {
    shotMatch = 'matching-last-completed'
  } else {
    return block('Native shot evidence is completed/stale or does not match the authoritative shot.')
  }
  const fileAgeMs = native.structured?.fileAgeMs
  if (!finite(fileAgeMs) || fileAgeMs < 0 || fileAgeMs > ACCEPTABLE_AGE_MS) {
    return block('Native currentRound.dat evidence is stale.', shotMatch)
  }
  if (intent.coordinateFrame !== 'looper-hole-local-yards-unverified'
      || intent.nativeInputAuthorized !== false
      || ![...intent.ballLocalYds, ...intent.teeLocalYds,
           ...intent.pinLocalYds, ...intent.targetLocalYds].every(finite)) {
    return block('Live Caddie local frame or proposed target is invalid.', shotMatch)
  }
  const mini = native.minimap
  const reg = mini?.registration
  if (mini?.status !== 'markers_found' || !validPixel(mini.ballPixel) || !validPixel(mini.pinPixel)) {
    return block('Current minimap ball and pin have not been detected.', shotMatch)
  }
  if (!reg || !['tee_anchor_candidate_cached', 'registered_candidate_unverified'].includes(reg.status)
      || !validPixel(reg.canonicalTeePixel) || !validPixel(reg.canonicalPinPixel)
      || !Array.isArray(reg.currentToCanonicalMatrix)) {
    return block('No cached tee frame and current minimap registration.', shotMatch)
  }
  if (reg.status === 'registered_candidate_unverified'
      && (!finite(reg.pinErrorPixels) || reg.pinErrorPixels > MAX_PIN_REGISTRATION_ERROR_PX)) {
    return block('Independent white-pin registration failed.', shotMatch)
  }
  const ypp = reg.teeScaleYardsPerPixel ?? mini.scale?.yardsPerPixel
  if (!finite(ypp) || ypp <= 0 || mini.scale?.status === 'unavailable') {
    return block('Tee minimap yards-per-pixel scale is unverified.', shotMatch)
  }
  const sourceTee = { x: intent.teeLocalYds[0], y: intent.teeLocalYds[1] }
  const sourcePin = { x: intent.pinLocalYds[0], y: intent.pinLocalYds[1] }
  const anchorError = Math.abs(
    distance(sourceTee, sourcePin) - distance(reg.canonicalTeePixel, reg.canonicalPinPixel) * ypp
  )
  if (!finite(anchorError) || anchorError > MAX_ANCHOR_ERROR_YDS) {
    return block('Looper tee-to-pin geometry differs from calibrated GSPro tee-to-pin ruler.',
      shotMatch, round(anchorError))
  }
  const targetCanonical = courseToCanonical(
    intent.targetLocalYds, intent.teeLocalYds, intent.pinLocalYds,
    reg.canonicalTeePixel, reg.canonicalPinPixel, ypp,
  )
  const ballCanonical = courseToCanonical(
    intent.ballLocalYds, intent.teeLocalYds, intent.pinLocalYds,
    reg.canonicalTeePixel, reg.canonicalPinPixel, ypp,
  )
  const targetCurrent = targetCanonical &&
    canonicalToCurrent(reg.currentToCanonicalMatrix, targetCanonical)
  const expectedBallCurrent = ballCanonical &&
    canonicalToCurrent(reg.currentToCanonicalMatrix, ballCanonical)
  const currentYpp = reg.currentScaleYardsPerPixel ?? ypp
  if (!targetCurrent || !expectedBallCurrent || !finite(currentYpp) || currentYpp <= 0
      || !validPixel(targetCurrent) || !validPixel(expectedBallCurrent)) {
    return block('Course-to-native affine transform is invalid.', shotMatch, round(anchorError))
  }
  const ballError = distance(expectedBallCurrent, mini.ballPixel) * currentYpp
  if (!finite(ballError) || ballError > MAX_CURRENT_BALL_ERROR_YDS) {
    return block('Current Looper ball differs from GSPro minimap ball; frame is not aligned.',
      shotMatch, round(anchorError), round(ballError))
  }
  const roi = mini.minimapRoiWindowPixels
  const width = roi?.[2], height = roi?.[3]
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0
      || targetCurrent.x < 0 || targetCurrent.x >= width
      || targetCurrent.y < 0 || targetCurrent.y >= height) {
    return block('Target projects outside the visible native minimap region.', shotMatch,
      round(anchorError), round(ballError))
  }
  return {
    status: 'candidate-unverified',
    reason: 'Read-only coordinate candidate only. Independent GSPro/Looper course-frame validation and explicit Set Aim authorization are still required.',
    shotMatch,
    coordinateFrame: 'gspro-minimap-roi-unverified',
    nativeInputAuthorized: false,
    targetPixel: { x: round(targetCurrent.x), y: round(targetCurrent.y) },
    projectedBallErrorYds: round(ballError),
    teePinAnchorErrorYds: round(anchorError),
    roiWidthPx: width,
    roiHeightPx: height,
  }
}
