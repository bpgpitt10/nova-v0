import { sendLooperCompanionAimClick } from '../adapters/looperCompanion'
import type { CourseId } from '../courseGeometry/courseCatalog'
import { nativeCourseContextForLive } from '../courseGeometry/nativeCourseRuntime'
import { nativeHoleLocalYdsToWorld } from '../courseGeometry/nativeRegistration'
import type { CoursePointYds } from '../courseGeometry/types'

export type AimInGsproResult = Readonly<{
  /** 'aimed': GSPro's aim reticle seen where Looper clicked. */
  outcome: 'aimed' | 'clicked-unverified' | 'clicked-mismatch' | 'not-sent'
  message: string
}>

const REASONS: Record<string, string> = {
  'gspro-not-connected': 'GSPro is not running',
  'gspro-minimized': 'GSPro is minimized',
  'target-off-map': "the aim is outside GSPro's minimap",
  'minimap-not-read': "couldn't find the ball and pin on GSPro's minimap",
  'minimap-not-aligned': "GSPro's minimap isn't showing ball below pin",
  'preflight-failed': 'GSPro window check failed',
  'click-failed': "couldn't click GSPro",
  'too-soon': 'already aimed a moment ago',
  'invalid-request': 'positions not available',
  'missing-shot': 'no current shot',
  unavailable: 'companion error',
}

/** Looper's aim into GSPro: hole-local yards -> GSPro world -> one minimap click. */
export const aimInGspro = async ({
  courseId, courseKey, holeNumber, ball, pin, target, shotKey,
}: Readonly<{
  courseId: CourseId | null
  courseKey: string | null
  holeNumber: number
  ball: CoursePointYds | null
  pin: CoursePointYds | null
  target: CoursePointYds | null
  shotKey: string
}>): Promise<AimInGsproResult> => {
  if (!courseId) return { outcome: 'not-sent', message: 'Aim by hand: no course selected.' }
  const context = await nativeCourseContextForLive(courseId, courseKey).catch(() => null)
  if (!context) return { outcome: 'not-sent', message: "Aim by hand: Looper hasn't matched this course to GSPro yet (see Course match)." }
  const toWorld = (local: CoursePointYds | null) => nativeHoleLocalYdsToWorld(context.registration, holeNumber, local)
  const points = { ball: toWorld(ball), pin: toWorld(pin), target: toWorld(target) }
  if (!points.ball || !points.pin || !points.target) {
    return { outcome: 'not-sent', message: 'Aim by hand: ball, pin or aim position not known yet.' }
  }
  try {
    const result = await sendLooperCompanionAimClick(
      { ball: points.ball, pin: points.pin, target: points.target }, shotKey)
    if (result.status !== 'clicked') {
      const why = REASONS[result.reason ?? ''] ?? result.reason ?? 'unknown reason'
      return { outcome: 'not-sent', message: `Aim by hand: ${why}${result.detail ? ` (${result.detail})` : ''}.` }
    }
    if (result.verified === 'match') return { outcome: 'aimed', message: 'Aimed in GSPro.' }
    if (result.verified === 'mismatch') {
      return {
        outcome: 'clicked-mismatch',
        message: "Clicked GSPro, but its aim marker isn't where Looper aimed"
          + (result.markerOffsetPx != null ? ` (${Math.round(result.markerOffsetPx)} px off on the minimap)` : '')
          + '. Check the aim.',
      }
    }
    return { outcome: 'clicked-unverified', message: "Clicked GSPro's minimap. Glance at the aim to confirm." }
  } catch (error) {
    return { outcome: 'not-sent', message: `Aim by hand: ${error instanceof Error ? error.message : String(error)}` }
  }
}
