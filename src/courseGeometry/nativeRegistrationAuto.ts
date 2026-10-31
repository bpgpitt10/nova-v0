import { nativeHole, sha256Hex, type NativeCourseLayout } from './nativeGkd'
import type { NativeHoleFrame, NativeRegistration } from './nativeRegistration'
import { nativeWorldToLatLon } from './nativeRegistration'
import { fitNativeRegistration, terrainSamplerFromHoles, type NativeRegistrationFitResult } from './nativeRegistrationFit'
import { parsePackageTerrain, type RawTerrain } from './routePackagedCourseLoader'
import type { CourseTerrainGrid } from './types'

/**
 * Registration for a course that has none published yet (e.g. just loaded):
 * fit the player's GKD to the course package's own LiDAR terrain, in this
 * browser. The GKD stays on the PC; the result contains no GKD geometry.
 *
 * Extra guard against pairing the wrong GSPro course with a Looper course:
 * after the fit, most GKD green centres must land within 25 m of the mapped
 * green centres (the fit itself also fails on mismatched terrain).
 */

type RawFrame = { anchorLatLon?: unknown; headingDegreesTrue?: unknown; origin?: unknown; targetGreenLatLon?: unknown }
type RawHole = { coordinateFrame?: RawFrame; terrain?: RawTerrain }
type RawPackage = { courseId?: unknown; holes?: Record<string, RawHole> }

const pair = (value: unknown): readonly [number, number] | null =>
  Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ? [value[0] as number, value[1] as number] : null

export type AutoRegistrationResult = Readonly<{
  fit: NativeRegistrationFitResult
  greensWithin25m: number
  greensChecked: number
  registration: NativeRegistration | null
}>

export const fitRegistrationFromPackage = async ({
  courseId,
  gsproCourseKey,
  layout,
  packageJson,
}: Readonly<{
  courseId: string
  gsproCourseKey: string
  /** Main layout of the scene (pins and greens are shared by all layouts). */
  layout: NativeCourseLayout
  packageJson: unknown
}>): Promise<AutoRegistrationResult> => {
  const pkg = packageJson as RawPackage
  const holes: Array<{ frame: NativeHoleFrame; terrain: CourseTerrainGrid }> = []
  const frames: Record<string, NativeHoleFrame> = {}
  const greens: Array<{ world: { x: number; z: number }; latLon: readonly [number, number] }> = []
  for (const [key, raw] of Object.entries(pkg.holes ?? {})) {
    const cf = raw.coordinateFrame
    const anchor = pair(cf?.anchorLatLon)
    const heading = cf?.headingDegreesTrue
    if (!anchor || typeof heading !== 'number' || !Number.isFinite(heading)) continue
    const frame: NativeHoleFrame = { anchorLatLon: anchor, headingDegreesTrue: heading,
      origin: typeof cf?.origin === 'string' ? cf.origin : null }
    frames[key] = frame
    const terrain = raw.terrain ? await parsePackageTerrain(raw.terrain, courseId, Number(key)).catch(() => null) : null
    if (terrain) holes.push({ frame, terrain })
    const green = pair(cf?.targetGreenLatLon)
    const gkdHole = nativeHole(layout, Number(key))
    if (green && gkdHole?.greenCenter) greens.push({ world: gkdHole.greenCenter, latLon: green })
  }
  const points = layout.holes.flatMap((h) => [...h.pins, ...(h.greenCenter ? [h.greenCenter] : [])])
  const fit = fitNativeRegistration({
    courseId,
    gsproCourseKey,
    layoutFingerprint: await sha256Hex(layout.fingerprintText),
    sceneFingerprint: await sha256Hex(layout.sceneFingerprintText),
    points,
    greens,
    holes: frames,
    sampler: terrainSamplerFromHoles(holes),
  })
  let within = 0
  if (fit.registration) {
    for (const g of greens) {
      const [lat, lon] = nativeWorldToLatLon(fit.registration, g.world)
      const m = Math.hypot((lat - g.latLon[0]) * 111_320, (lon - g.latLon[1]) * 111_320 * Math.cos(lat * Math.PI / 180))
      if (m <= 25) within += 1
    }
  }
  const sameCourse = greens.length >= 3 && within >= Math.ceil(0.8 * greens.length)
  return {
    fit,
    greensWithin25m: within,
    greensChecked: greens.length,
    registration: fit.registration && sameCourse ? fit.registration : null,
  }
}
