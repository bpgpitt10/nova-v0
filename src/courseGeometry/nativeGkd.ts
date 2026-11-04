/**
 * GSPro GKD course layout, read in the browser from the player's own install.
 *
 * Verified against FarmLinks and real GSPro output (see
 * tools/course_model/gkd_native.py on course-model-prototype-v1):
 * - positions are GSPro world metres: x east, z north, y up;
 * - a shot's StartingPOS x/z equals the played GKD tee x/z;
 * - currentRound DistanceToPin is the straight 2D line to the active pin;
 * - the tee-box HUD distance is the aim route (tee -> AimPoint1 -> AimPoint2)
 *   to the active pin;
 * - pin entries carry weekday labels but GSPro does not pick them by weekday,
 *   so they are treated as slots.
 *
 * The GKD is third-party content. It is read locally and never uploaded; only
 * its layout fingerprint is compared with the published registration.
 */

export type NativeXYZ = Readonly<{ x: number; y: number; z: number }>
export type NativeTee = NativeXYZ & Readonly<{ name: string; distanceM: number }>
export type NativePin = NativeXYZ & Readonly<{ slot: number; label: string | null }>

export type NativeHole = Readonly<{
  hole: number
  par: number | null
  tees: Readonly<Record<string, NativeTee>>
  aimPoints: readonly NativeXYZ[]
  greenCenter: NativeXYZ | null
  pins: readonly NativePin[]
}>

/**
 * A GSPro penalty area: the polygon GSPro itself uses to assess the penalty
 * (water, lateral hazards, marked dry ravines). Flags are the designer's.
 * Bunkers, fairways, rough and the green outline are NOT in the GKD.
 */
export type NativePenaltyArea = Readonly<{
  id: number
  points: readonly NativeXYZ[]
  freeDrop: boolean
  /** Inside this polygon is out of bounds (internal OB such as a road). */
  innerOOB: boolean
  islandGreen: boolean
  dropZone: NativeXYZ | null
}>

export type NativeCourseLayout = Readonly<{
  courseName: string | null
  /** GKDalt only: the scene (main GKD / CourseKey) this alternate layout belongs to. */
  sceneFolderName: string | null
  /** Designer's course location text and, when present, lat/lon. */
  location: string | null
  courseLatLon: readonly [number, number] | null
  holes: readonly NativeHole[]
  /** GSPro's penalty-area polygons (main GKD; alternate layouts usually omit them). */
  penaltyAreas: readonly NativePenaltyArea[]
  /** GSPro's out-of-bounds polygon ("pOOB"), as drawn: see nativeHazards.ts for its meaning. */
  outOfBounds: readonly NativeXYZ[]
  /** Tees + pins + green centres: changes whenever a tee moves. */
  fingerprintText: string
  /** Pins + green centres only: shared by every layout of one GSPro scene. */
  sceneFingerprintText: string
}>

export class NativeGkdError extends Error {}

export const NATIVE_METERS_TO_YARDS = 1.0936132983377078
export const PLAYABLE_TEES = ['Black', 'Blue', 'White', 'Green', 'Yellow', 'Red', 'Junior', 'Par3'] as const
const MAX_GKD_CHARS = 8 * 1024 * 1024

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const xyz = (value: unknown): NativeXYZ | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as { x?: unknown; y?: unknown; z?: unknown }
  const x = typeof v.x === 'string' ? Number(v.x) : v.x
  const y = typeof v.y === 'string' ? Number(v.y) : v.y
  const z = typeof v.z === 'string' ? Number(v.z) : v.z
  return finite(x) && finite(y) && finite(z) ? { x, y, z } : null
}

/** Round to integer decimetres, half up: identical to the Python side. */
const dm = (value: number) => Math.floor(value * 10 + 0.5)

export const layoutFingerprintText = (holes: readonly NativeHole[]): string =>
  [...holes]
    .sort((a, b) => a.hole - b.hole)
    .map((h) => {
      const tees = Object.keys(h.tees)
        .sort()
        .map((name) => `${name}:${dm(h.tees[name].x)},${dm(h.tees[name].z)}`)
        .join(';')
      const pins = h.pins.map((p) => `${dm(p.x)},${dm(p.z)}`).join(';')
      const gc = h.greenCenter ? `${dm(h.greenCenter.x)},${dm(h.greenCenter.z)}` : '-'
      return `${h.hole}|${tees}|${pins}|${gc}`
    })
    .join('\n')

/** Scene text: no tees, so a GKD and its GKDalt layouts (and tee-only
 * revisions) agree. Mirrors scene_fingerprint_text in gkd_native.py. */
export const sceneFingerprintText = (holes: readonly NativeHole[]): string =>
  [...holes]
    .sort((a, b) => a.hole - b.hole)
    .map((h) => {
      const pins = h.pins.map((p) => `${dm(p.x)},${dm(p.z)}`).join(';')
      const gc = h.greenCenter ? `${dm(h.greenCenter.x)},${dm(h.greenCenter.z)}` : '-'
      return `${h.hole}|${pins}|${gc}`
    })
    .join('\n')

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const parseGkdLayout = (text: string): NativeCourseLayout => {
  if (text.length > MAX_GKD_CHARS) throw new NativeGkdError('GKD file is too large.')
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new NativeGkdError('GKD file is not valid JSON.')
  }
  const root = raw as {
    Holes?: unknown; CourseName?: unknown; SceneFolderName?: unknown; Location?: unknown
    CourseLat?: unknown; CourseLong?: unknown; Hazards?: unknown; pOOB?: unknown
  }
  if (!root || typeof root !== 'object' || !Array.isArray(root.Holes)) {
    throw new NativeGkdError('GKD file has no Holes list.')
  }
  const holes: NativeHole[] = []
  for (const entry of root.Holes) {
    const h = entry as { HoleNumber?: unknown; Par?: unknown; Tees?: unknown; Pins?: unknown }
    if (!h || typeof h !== 'object' || !finite(h.HoleNumber)) {
      throw new NativeGkdError('GKD hole entry is malformed.')
    }
    const tees: Record<string, NativeTee> = {}
    const aims: Record<string, NativeXYZ> = {}
    let greenCenter: NativeXYZ | null = null
    for (const t of Array.isArray(h.Tees) ? h.Tees : []) {
      const tee = t as { TeeType?: unknown; Position?: unknown; Distance?: unknown }
      const kind = typeof tee.TeeType === 'string' ? tee.TeeType : null
      const pos = xyz(tee.Position)
      if (!kind || !pos) continue
      if (kind === 'AimPoint1' || kind === 'AimPoint2') aims[kind] = pos
      else if (kind === 'GreenCenterPoint') greenCenter = pos
      else tees[kind] = { ...pos, name: kind, distanceM: finite(tee.Distance) ? tee.Distance : 0 }
    }
    const pins: NativePin[] = []
    ;(Array.isArray(h.Pins) ? h.Pins : []).forEach((p, index) => {
      const pin = p as { Position?: unknown; Day?: unknown }
      const pos = xyz(pin.Position)
      if (pos) pins.push({ ...pos, slot: index + 1, label: typeof pin.Day === 'string' ? pin.Day : null })
    })
    holes.push({
      hole: h.HoleNumber,
      par: finite(h.Par) ? h.Par : null,
      tees,
      aimPoints: (['AimPoint1', 'AimPoint2'] as const).flatMap((k) => (aims[k] ? [aims[k]] : [])),
      greenCenter,
      pins,
    })
  }
  holes.sort((a, b) => a.hole - b.hole)
  const ring = (value: unknown): NativeXYZ[] => {
    const coords = value && typeof value === 'object' ? (value as { coords?: unknown }).coords : null
    return (Array.isArray(coords) ? coords : []).map(xyz).filter((q): q is NativeXYZ => q !== null)
  }
  const penaltyAreas: NativePenaltyArea[] = []
  ;(Array.isArray(root.Hazards) ? root.Hazards : []).forEach((entry, index) => {
    const hz = entry as { freeDrop?: unknown; innerOOB?: unknown; islandGreen?: unknown; hasDZ?: unknown; DZpos?: unknown }
    const points = ring(entry)
    if (points.length < 3) return
    penaltyAreas.push({
      id: index,
      points,
      freeDrop: hz.freeDrop === true,
      innerOOB: hz.innerOOB === true,
      islandGreen: hz.islandGreen === true,
      dropZone: hz.hasDZ === true ? xyz(hz.DZpos) : null,
    })
  })
  const lat = typeof root.CourseLat === 'string' ? Number(root.CourseLat) : root.CourseLat
  const lon = typeof root.CourseLong === 'string' ? Number(root.CourseLong) : root.CourseLong
  return {
    courseName: typeof root.CourseName === 'string' ? root.CourseName : null,
    sceneFolderName: typeof root.SceneFolderName === 'string' ? root.SceneFolderName : null,
    location: typeof root.Location === 'string' && root.Location.trim() ? root.Location.trim() : null,
    courseLatLon: finite(lat) && finite(lon) && (lat !== 0 || lon !== 0) ? [lat, lon] : null,
    holes,
    penaltyAreas,
    outOfBounds: ring(root.pOOB),
    fingerprintText: layoutFingerprintText(holes),
    sceneFingerprintText: sceneFingerprintText(holes),
  }
}

/** A green centre this far from the centroid of the hole's pins is not trusted. */
export const GREEN_CENTER_MAX_FROM_PINS_M = 40

/**
 * The hole's green centre for registration. Some designers leave
 * GreenCenterPoint unset or at a placeholder; the pins always sit on the
 * green, so their centroid stands in when the centre is missing or more than
 * 40 m from them.
 */
export const effectiveGreenCenter = (
  hole: NativeHole,
): Readonly<{ point: NativeXYZ; replaced: boolean }> | null => {
  const pins = hole.pins
  const centroid = pins.length
    ? {
        x: pins.reduce((s, p) => s + p.x, 0) / pins.length,
        y: pins.reduce((s, p) => s + p.y, 0) / pins.length,
        z: pins.reduce((s, p) => s + p.z, 0) / pins.length,
      }
    : null
  const gc = hole.greenCenter
  if (gc && (!centroid || Math.hypot(gc.x - centroid.x, gc.z - centroid.z) <= GREEN_CENTER_MAX_FROM_PINS_M)) {
    return { point: gc, replaced: false }
  }
  return centroid ? { point: centroid, replaced: true } : null
}

export const nativeHole = (layout: NativeCourseLayout, holeNumber: number): NativeHole | null =>
  layout.holes.find((h) => h.hole === holeNumber) ?? null

export const nativeStraightDistanceM = (a: NativeXYZ, b: NativeXYZ) => Math.hypot(a.x - b.x, a.z - b.z)

/** Aim-route length, skipping aim points not ahead of the start (forward tees). */
export const nativeRouteDistanceM = (start: NativeXYZ, aimPoints: readonly NativeXYZ[], target: NativeXYZ) => {
  const toTarget = nativeStraightDistanceM(start, target)
  const points = [start, ...aimPoints.filter((p) => nativeStraightDistanceM(p, target) < toTarget), target]
  let total = 0
  for (let i = 1; i < points.length; i += 1) total += nativeStraightDistanceM(points[i - 1], points[i])
  return total
}

export type NativeTeeMatch =
  | Readonly<{ status: 'matched' | 'ambiguous-same-spot'; tee: NativeTee; candidates: readonly string[]; offsetM: number }>
  | Readonly<{ status: 'no-match'; nearestM: number | null }>

/** Which GKD tee a ball position sits on. Tees sharing a spot are reported as
 * ambiguous; distances depend only on position, so that is not a failure. */
export const resolveNativeTee = (
  hole: NativeHole,
  world: Readonly<{ x: number; z: number }>,
  toleranceM = 5,
  ambiguityM = 3,
): NativeTeeMatch => {
  const ranked = Object.values(hole.tees)
    .filter((t) => (PLAYABLE_TEES as readonly string[]).includes(t.name))
    .map((t) => ({ tee: t, d: Math.hypot(t.x - world.x, t.z - world.z) }))
    .sort((a, b) => a.d - b.d)
  if (ranked.length === 0 || ranked[0].d > toleranceM) {
    return { status: 'no-match', nearestM: ranked[0]?.d ?? null }
  }
  const best = ranked[0].d
  const candidates = ranked.filter((r) => r.d - best <= ambiguityM && r.d <= toleranceM).map((r) => r.tee.name)
  return {
    status: candidates.length === 1 ? 'matched' : 'ambiguous-same-spot',
    tee: ranked[0].tee,
    candidates,
    offsetM: best,
  }
}

export type NativePinMatch =
  | Readonly<{ status: 'matched'; pin: NativePin; errorM: number }>
  | Readonly<{ status: 'ambiguous' | 'no-match' }>

/** Which pin slot GSPro is using, from a ball position and GSPro's own
 * straight DistanceToPin for that position. */
export const resolveNativePinSlot = (
  hole: NativeHole,
  world: Readonly<{ x: number; z: number }>,
  distanceToPinM: number,
  toleranceM = 0.5,
): NativePinMatch => {
  if (!finite(distanceToPinM)) return { status: 'no-match' }
  const ranked = hole.pins
    .map((pin) => ({ pin, e: Math.abs(Math.hypot(pin.x - world.x, pin.z - world.z) - distanceToPinM) }))
    .sort((a, b) => a.e - b.e)
  if (ranked.length === 0 || ranked[0].e > toleranceM) return { status: 'no-match' }
  if (ranked.length > 1 && ranked[1].e <= toleranceM) return { status: 'ambiguous' }
  return { status: 'matched', pin: ranked[0].pin, errorM: ranked[0].e }
}

/** Looper stores tee sets lowercase ("white", "par 3"); GKD uses "White", "Par3". */
export const gkdTeeForTeeSet = (hole: NativeHole, normalizedTeeSet: string | null | undefined): NativeTee | null => {
  if (!normalizedTeeSet) return null
  const wanted = normalizedTeeSet.replace(/\s+/g, '').toLowerCase()
  const name = Object.keys(hole.tees).find((k) => k.replace(/\s+/g, '').toLowerCase() === wanted)
  return name ? hole.tees[name] : null
}

export type NativeTeeSetOption = Readonly<{ name: string; totalYards: number; holes: number }>

/** GSPro's own tee sets for a round picker: playable tees present on at least
 * nine holes with a designer distance, longest first. */
export const nativeTeeSetOptions = (layout: NativeCourseLayout): readonly NativeTeeSetOption[] => {
  const totals = new Map<string, { metres: number; holes: number }>()
  for (const hole of layout.holes) {
    for (const tee of Object.values(hole.tees)) {
      if (!(PLAYABLE_TEES as readonly string[]).includes(tee.name) || tee.distanceM <= 0) continue
      const entry = totals.get(tee.name) ?? { metres: 0, holes: 0 }
      entry.metres += tee.distanceM
      entry.holes += 1
      totals.set(tee.name, entry)
    }
  }
  return [...totals.entries()]
    .filter(([, entry]) => entry.holes >= 9)
    .map(([name, entry]) => ({ name, totalYards: Math.round(entry.metres * NATIVE_METERS_TO_YARDS), holes: entry.holes }))
    .sort((a, b) => b.totalYards - a.totalYards)
}
