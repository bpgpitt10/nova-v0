import { nativeHole, sha256Hex, type NativeCourseLayout } from './nativeGkd'
import type { NativeHoleFrame, NativeRegistration } from './nativeRegistration'
import { groundOffsetMeters, nativeWorldToLatLon } from './nativeRegistration'
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

export type GreenSimilarity = Readonly<{ rotationDeg: number; scale: number; rmsM: number; n: number }>

export type AutoRegistrationResult = Readonly<{
  fit: NativeRegistrationFitResult
  greensWithin25m: number
  greensChecked: number
  /** GKD green centres vs mapped green centres, best rotation + scale + shift.
   * Diagnoses a failed fit: rotation far from 0 or scale far from 1 means GSPro
   * built this course off true north / not in metres; a large rms means the
   * holes or greens do not correspond (wrong course, renumbered holes). */
  greenSimilarity: GreenSimilarity | null
  /** Diagnostic when the greens don't pair up by hole number: the hole offset
   * (GSPro hole = Looper hole + shift, wrapping) whose greens do line up. */
  holeShift: Readonly<{ shift: number; rmsM: number; rotationDeg: number; scale: number }> | null
  registration: NativeRegistration | null
}>

const DEG = Math.PI / 180
const ROTATION_MIN_DEG = 0.5
const SCALE_MIN_DEVIATION = 0.003
const ROTATION_TRUST_RMS_M = 25

export const greenSimilarity = (
  greens: ReadonlyArray<Readonly<{ world: Readonly<{ x: number; z: number }>; latLon: readonly [number, number] }>>,
): GreenSimilarity | null => {
  if (greens.length < 3) return null
  const lat0 = greens.reduce((s, g) => s + g.latLon[0], 0) / greens.length
  const lon0 = greens.reduce((s, g) => s + g.latLon[1], 0) / greens.length
  const map = greens.map((g) => groundOffsetMeters(lat0, lon0, g.latLon[0], g.latLon[1]))
  const wx = greens.reduce((s, g) => s + g.world.x, 0) / greens.length
  const wz = greens.reduce((s, g) => s + g.world.z, 0) / greens.length
  const world = greens.map((g) => [g.world.x - wx, g.world.z - wz] as const)
  // Least-squares similarity world -> map (east, north), complex-number form.
  let a = 0, b = 0, norm = 0
  for (let i = 0; i < greens.length; i += 1) {
    const [px, pz] = world[i]
    const [qe, qn] = map[i]
    a += px * qe + pz * qn
    b += px * qn - pz * qe
    norm += px * px + pz * pz
  }
  if (norm <= 0) return null
  const scale = Math.hypot(a, b) / norm
  const theta = Math.atan2(b, a)
  let sq = 0
  for (let i = 0; i < greens.length; i += 1) {
    const [px, pz] = world[i]
    const e = scale * (px * Math.cos(theta) - pz * Math.sin(theta))
    const n = scale * (px * Math.sin(theta) + pz * Math.cos(theta))
    sq += (e - map[i][0]) ** 2 + (n - map[i][1]) ** 2
  }
  return { rotationDeg: theta / DEG, scale, rmsM: Math.sqrt(sq / greens.length), n: greens.length }
}

/** Try pairing Looper hole h with GSPro hole h + shift (wrapping over the
 * GKD's holes), e.g. nines swapped. Diagnostic only. */
const bestHoleShift = (layout: NativeCourseLayout, mapped: ReadonlyMap<number, readonly [number, number]>) => {
  const count = layout.holes.length
  let best: { shift: number; rmsM: number; rotationDeg: number; scale: number } | null = null
  for (let shift = 1; shift < count; shift += 1) {
    const pairs: Array<{ world: { x: number; z: number }; latLon: readonly [number, number] }> = []
    for (const [hole, latLon] of mapped) {
      const gkd = nativeHole(layout, ((hole - 1 + shift) % count) + 1)
      if (gkd?.greenCenter) pairs.push({ world: gkd.greenCenter, latLon })
    }
    const sim = greenSimilarity(pairs)
    if (sim && (!best || sim.rmsM < best.rmsM)) best = { shift, rmsM: sim.rmsM, rotationDeg: sim.rotationDeg, scale: sim.scale }
  }
  return best && best.rmsM <= ROTATION_TRUST_RMS_M ? best : null
}

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
  const mappedGreens = new Map<number, readonly [number, number]>()
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
    if (green) mappedGreens.set(Number(key), green)
    const gkdHole = nativeHole(layout, Number(key))
    if (green && gkdHole?.greenCenter) greens.push({ world: gkdHole.greenCenter, latLon: green })
  }
  const points = layout.holes.flatMap((h) => [...h.pins, ...(h.greenCenter ? [h.greenCenter] : [])])
  // Some GSPro scenes are built turned or scaled (Valhalla 180°, Royal New Kent
  // -12°); the greens give that directly. Near 0° / 1 (FarmLinks) keep the
  // true-north model exactly as before.
  const similarity = greenSimilarity(greens)
  const turned = similarity != null && similarity.rmsM <= ROTATION_TRUST_RMS_M
    && (Math.abs(similarity.rotationDeg) > ROTATION_MIN_DEG || Math.abs(similarity.scale - 1) > SCALE_MIN_DEVIATION)
  const fit = fitNativeRegistration({
    ...(turned ? { rotationDeg: similarity!.rotationDeg, scale: similarity!.scale } : {}),
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
    greenSimilarity: similarity,
    holeShift: similarity && similarity.rmsM > ROTATION_TRUST_RMS_M ? bestHoleShift(layout, mappedGreens) : null,
    registration: fit.registration && sameCourse ? fit.registration : null,
  }
}
