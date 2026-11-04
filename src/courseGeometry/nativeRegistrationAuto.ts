import { effectiveGreenCenter, nativeHole, sha256Hex, type NativeCourseLayout, type NativeXYZ } from './nativeGkd'
import type { NativeHoleFrame, NativeRegistration } from './nativeRegistration'
import { groundOffsetMeters, nativeWorldToLatLon } from './nativeRegistration'
import { fitNativeRegistration, registrationFromGreens, terrainSamplerFromHoles, type NativeRegistrationFitResult } from './nativeRegistrationFit'
import { fitGreens, type Xy } from '../courseLoading/courseGeometryMatch'
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
  /** Greens matched mirror-image (scene x runs west); greenSimilarity is that fit. */
  mirrored: boolean
  /** Best mirror-image fit, for diagnostics when nothing registers. */
  mirroredSimilarity: GreenSimilarity | null
  /** Diagnostic when the greens don't pair up by hole number: the hole offset
   * (GSPro hole = Looper hole + shift, wrapping) whose greens do line up. */
  holeShift: Readonly<{ shift: number; rmsM: number; rotationDeg: number; scale: number; label: string }> | null
  /** Holes whose GreenCenterPoint was missing or far from the pins: the pins' centroid was used. */
  greenCentresReplaced: number
  /** The height fit only passed with GSPro's penalty-area outlines added as extra points. */
  usedHazardPoints: boolean
  /** Placed from the greens alone: they line up to a few metres but the terrain doesn't match. */
  greensOnly: boolean
  /** Diagnostic when greens don't pair by hole number: the best fit ignoring
   * hole numbers, and which GSPro hole's green landed on which map hole's. */
  unordered: Readonly<{
    paired: number
    gkdGreens: number
    rmsM: number
    rotationDeg: number
    scale: number
    mirrored: boolean
    /** [GSPro hole, map hole] for each paired green. */
    holes: ReadonlyArray<readonly [number, number]>
  }> | null
  registration: NativeRegistration | null
}>

const DEG = Math.PI / 180
const ROTATION_MIN_DEG = 0.5
const SCALE_MIN_DEVIATION = 0.003
const ROTATION_TRUST_RMS_M = 25
/** Retry the height fit with penalty-area outlines when there are fewer height points than this. */
const HAZARD_POINTS_BELOW = 150
/** Greens this close (rms, nearly true scale) place the course on their own when the height fit fails. */
const GREENS_ONLY_RMS_M = 6
const GREENS_ONLY_SCALE = 0.03

/** Best fit of GSPro's greens onto the map's, ignoring hole numbers (diagnostic). */
export const unorderedGreenFit = (layout: Pick<NativeCourseLayout, 'holes'>, mapped: ReadonlyMap<number, readonly [number, number]>) => {
  const gkd: Array<{ hole: number; p: Xy }> = []
  for (const h of layout.holes) {
    const centre = effectiveGreenCenter(h)
    if (centre) gkd.push({ hole: h.hole, p: [centre.point.x, centre.point.z] })
  }
  const entries = [...mapped.entries()]
  if (gkd.length < 3 || entries.length < 3) return null
  const lat0 = entries.reduce((s, [, g]) => s + g[0], 0) / entries.length
  const lon0 = entries.reduce((s, [, g]) => s + g[1], 0) / entries.length
  const map: Xy[] = entries.map(([, g]) => groundOffsetMeters(lat0, lon0, g[0], g[1]))
  const fit = fitGreens(gkd.map((g) => g.p), map)
  if (!fit) return null
  return {
    paired: fit.paired, gkdGreens: fit.gkdGreens, rmsM: fit.rmsM, rotationDeg: fit.rotationDeg,
    scale: fit.scale, mirrored: fit.mirrored,
    holes: (fit.pairs ?? []).map(([i, j]) => [gkd[i].hole, entries[j][0]] as const).sort((a, b) => a[0] - b[0]),
  }
}

export const greenSimilarity = (
  greens: ReadonlyArray<Readonly<{ world: Readonly<{ x: number; z: number }>; latLon: readonly [number, number] }>>,
  mirrored = false,
): GreenSimilarity | null => {
  if (greens.length < 3) return null
  const lat0 = greens.reduce((s, g) => s + g.latLon[0], 0) / greens.length
  const lon0 = greens.reduce((s, g) => s + g.latLon[1], 0) / greens.length
  const map = greens.map((g) => groundOffsetMeters(lat0, lon0, g.latLon[0], g.latLon[1]))
  const wx = greens.reduce((s, g) => s + g.world.x, 0) / greens.length
  const wz = greens.reduce((s, g) => s + g.world.z, 0) / greens.length
  const world = greens.map((g) => [(mirrored ? -1 : 1) * (g.world.x - wx), g.world.z - wz] as const)
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

/** Try other hole pairings (nines swapped / offset numbering, or numbered
 * backwards), plain and mirror-image. Diagnostic only: tells why greens don't
 * pair when the course itself is right. */
const bestHoleShift = (layout: NativeCourseLayout, mapped: ReadonlyMap<number, readonly [number, number]>) => {
  const count = layout.holes.length
  let best: { shift: number; rmsM: number; rotationDeg: number; scale: number; label: string } | null = null
  const pairings: Array<{ label: string; shift: number; map: (hole: number) => number }> = []
  for (let shift = 1; shift < count; shift += 1) {
    pairings.push({ label: `GSPro hole = Looper hole + ${shift}`, shift, map: (h) => ((h - 1 + shift) % count) + 1 })
  }
  for (let shift = 0; shift < count; shift += 1) {
    pairings.push({ label: `GSPro holes numbered backwards (+${shift})`, shift, map: (h) => ((count - h + shift) % count) + 1 })
  }
  for (const pairing of pairings) {
    const pairs: Array<{ world: { x: number; z: number }; latLon: readonly [number, number] }> = []
    for (const [hole, latLon] of mapped) {
      const gkd = nativeHole(layout, pairing.map(hole))
      const centre = gkd ? effectiveGreenCenter(gkd) : null
      if (centre) pairs.push({ world: centre.point, latLon })
    }
    for (const mirrored of [false, true]) {
      const sim = greenSimilarity(pairs, mirrored)
      if (sim && (!best || sim.rmsM < best.rmsM)) {
        best = { shift: pairing.shift, rmsM: sim.rmsM, rotationDeg: sim.rotationDeg, scale: sim.scale,
          label: pairing.label + (mirrored ? ', mirror-image' : '') }
      }
    }
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
    const centre = gkdHole ? effectiveGreenCenter(gkdHole) : null
    if (green && centre) greens.push({ world: centre.point, latLon: green })
  }
  // Heights: pins, plus green centres the designer actually set (a replaced
  // centre is the pins' own average, so it adds nothing).
  let greenCentresReplaced = 0
  const points: NativeXYZ[] = layout.holes.flatMap((h) => {
    const centre = effectiveGreenCenter(h)
    if (centre?.replaced) greenCentresReplaced += 1
    return [...h.pins, ...(centre && !centre.replaced ? [centre.point] : [])]
  })
  // Some GSPro scenes are built turned or scaled (Valhalla 180°, Royal New Kent
  // -12°); the greens give that directly. Near 0° / 1 (FarmLinks) keep the
  // true-north model exactly as before.
  // Some scenes are also built mirror-image (x running west): use that only
  // when the greens fit far better mirrored.
  const plain = greenSimilarity(greens)
  const flipped = greenSimilarity(greens, true)
  const mirrored = flipped != null && flipped.rmsM <= ROTATION_TRUST_RMS_M
    && (plain == null || flipped.rmsM < plain.rmsM / 3)
  const similarity = mirrored ? flipped : plain
  const turned = similarity != null && similarity.rmsM <= ROTATION_TRUST_RMS_M
    && (mirrored || Math.abs(similarity.rotationDeg) > ROTATION_MIN_DEG || Math.abs(similarity.scale - 1) > SCALE_MIN_DEVIATION)
  const fitInput = {
    ...(turned ? { rotationDeg: similarity!.rotationDeg, scale: similarity!.scale } : {}),
    ...(mirrored ? { mirrored: true } : {}),
    courseId,
    gsproCourseKey,
    layoutFingerprint: await sha256Hex(layout.fingerprintText),
    sceneFingerprint: await sha256Hex(layout.sceneFingerprintText),
    points,
    greens,
    holes: frames,
    sampler: terrainSamplerFromHoles(holes),
  }
  let fit = fitNativeRegistration(fitInput)
  // Few height points (pins + centres on a sparse GKD) and no fit: retry with
  // the penalty-area outlines, which the designer draws on the ground. Only
  // as a retry, so courses that register today are untouched.
  let usedHazardPoints = false
  const hazardPoints = layout.penaltyAreas.flatMap((area) => area.points)
  if (!fit.registration && points.length < HAZARD_POINTS_BELOW && hazardPoints.length) {
    const retry = fitNativeRegistration({ ...fitInput, points: [...points, ...hazardPoints] })
    if (retry.registration) {
      fit = retry
      usedHazardPoints = true
    }
  }
  // Greens line up to a few metres but the heights don't (terrain older than
  // GSPro's course): place it from the greens.
  let registration = fit.registration
  let greensOnly = false
  const minGreens = Math.max(6, Math.ceil((2 / 3) * layout.holes.length))
  if (!registration && similarity && similarity.rmsM <= GREENS_ONLY_RMS_M
    && Math.abs(similarity.scale - 1) <= GREENS_ONLY_SCALE && greens.length >= minGreens) {
    registration = registrationFromGreens(fitInput)
    greensOnly = registration != null
  }
  let within = 0
  if (registration) {
    for (const g of greens) {
      const [lat, lon] = nativeWorldToLatLon(registration, g.world)
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
    mirrored,
    mirroredSimilarity: flipped,
    holeShift: similarity && similarity.rmsM > ROTATION_TRUST_RMS_M ? bestHoleShift(layout, mappedGreens) : null,
    greenCentresReplaced,
    usedHazardPoints,
    greensOnly,
    unordered: !registration && (!similarity || similarity.rmsM > ROTATION_TRUST_RMS_M) ? unorderedGreenFit(layout, mappedGreens) : null,
    registration: registration && sameCourse ? registration : null,
  }
}
