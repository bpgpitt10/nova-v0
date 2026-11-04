import type { WindObservation } from './types'

export type WindProjection = {
  relativeFromDegrees: number
  helpingHurtingMph: number
  leftRightMph: number
  note: string
}

export type WindProjectionResult =
  | { projection: WindProjection; unavailableReason: null }
  | { projection: null; unavailableReason: string }

const normalizeDegrees = (value: number) => ((value % 360) + 360) % 360

/**
 * GSPro's wind compass is the scene's own (+z = "N"). Most scenes are built
 * true north, but some are turned (Valhalla 180°, Royal New Kent about -12°);
 * with the scene's rotation from native registration, turn a compass reading
 * into a true bearing. A scene bearing b points true b - rotation.
 */
export const windInTrueCompass = (
  wind: WindObservation | null,
  sceneRotationDeg: number | null | undefined,
  sceneMirrored = false,
): WindObservation | null => {
  const rotation = Number.isFinite(sceneRotationDeg) ? sceneRotationDeg ?? 0 : 0
  if (!wind || wind.referenceFrame !== 'compass' || wind.directionDegrees == null
    || !Number.isFinite(wind.directionDegrees) || (!rotation && !sceneMirrored)) {
    return wind
  }
  // Mirror-image scene: a scene bearing b points -b before the turn.
  const scene = sceneMirrored ? -wind.directionDegrees : wind.directionDegrees
  return { ...wind, directionDegrees: normalizeDegrees(scene - rotation) }
}

/**
 * Project a validated wind observation into shot-relative components.
 *
 * Direction contract:
 * - shot-relative: 0° is straight ahead toward the intended shot target;
 *   degrees increase toward shot-right.
 * - hole-local: 0° is packaged hole-local forward; degrees increase toward
 *   local-right. aimBearingDegrees must use the same convention.
 * - compass: 0° = true north, 90° = east. shotCompassBearingDegrees must be a
 *   validated true bearing for the same intended shot.
 *
 * Output signs:
 * - helpingHurtingMph > 0 means tail/helping; < 0 means head/hurting.
 * - leftRightMph > 0 means the wind vector pushes toward shot-right;
 *   < 0 pushes toward shot-left.
 */
export const projectWindObservation = (
  wind: WindObservation | null | undefined,
  aimBearingDegrees: number | null,
  shotCompassBearingDegrees: number | null = null,
): WindProjectionResult => {
  if (!wind) {
    return { projection: null, unavailableReason: 'No wind observation is connected.' }
  }
  if (wind.status !== 'READY') {
    return { projection: null, unavailableReason: `Wind observation status is ${wind.status}.` }
  }
  if (wind.speedMph == null || !Number.isFinite(wind.speedMph)) {
    return { projection: null, unavailableReason: 'Wind speed is missing or invalid.' }
  }
  if (wind.directionDegrees == null || !Number.isFinite(wind.directionDegrees)) {
    return { projection: null, unavailableReason: 'Wind direction is missing or invalid.' }
  }
  if (!wind.convention) {
    return { projection: null, unavailableReason: 'Wind from/toward convention is not established.' }
  }
  if (!wind.referenceFrame || wind.referenceFrame === 'unknown') {
    return { projection: null, unavailableReason: 'Wind direction reference frame is unknown.' }
  }

  // Normalize every observation to the direction the wind is coming FROM.
  const fromDegrees = normalizeDegrees(
    wind.directionDegrees + (wind.convention === 'toward' ? 180 : 0),
  )

  let relativeFromDegrees: number
  if (wind.referenceFrame === 'shot-relative') {
    relativeFromDegrees = fromDegrees
  } else if (wind.referenceFrame === 'hole-local') {
    if (aimBearingDegrees == null || !Number.isFinite(aimBearingDegrees)) {
      return {
        projection: null,
        unavailableReason: 'Hole-local wind requires a validated hole-local shot bearing.',
      }
    }
    relativeFromDegrees = normalizeDegrees(fromDegrees - aimBearingDegrees)
  } else {
    if (shotCompassBearingDegrees == null || !Number.isFinite(shotCompassBearingDegrees)) {
      return {
        projection: null,
        unavailableReason: 'Compass wind requires a validated true compass bearing for the intended shot.',
      }
    }
    relativeFromDegrees = normalizeDegrees(fromDegrees - shotCompassBearingDegrees)
  }

  const radians = relativeFromDegrees * Math.PI / 180
  const helpingHurtingMph = -wind.speedMph * Math.cos(radians)
  const leftRightMph = -wind.speedMph * Math.sin(radians)

  return {
    projection: {
      relativeFromDegrees,
      helpingHurtingMph,
      leftRightMph,
      note: `Projected from ${wind.referenceFrame} ${wind.convention}-direction; relative FROM angle ${relativeFromDegrees.toFixed(1)}°. Positive help = tailwind; positive lateral = pushes shot-right.`,
    },
    unavailableReason: null,
  }
}
