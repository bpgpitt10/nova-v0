import type { BrowserGsproCourseSnapshot } from '../adapters/reliableBrowserGsproCourseState'
import { GREYWOLF_COURSE_ID } from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import { getRouteHoleHeadingDegreesTrue } from '../courseGeometry/generatedRouteHoleHeadings'
import { estimateGreywolfTerrain } from '../courseGeometry/lidar'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import type {
  LiveField,
  LiveShotState,
  LiveStateStatus,
  TerrainPlane,
  TeeSelection,
  WindObservation,
} from './types'
import { projectWindObservation } from './windProjection'

export type AssembleLiveShotStateInput = {
  snapshot: BrowserGsproCourseSnapshot
  revision: number
  wind?: WindObservation | null
  roundTeeSelection?: TeeSelection | null
}

const field = <T = string>(
  value: T | null,
  status: LiveStateStatus,
  source: string | null,
  note?: string,
  observedAt?: string | null,
  ageMs?: number | null,
): LiveField<T> => ({ value, status, source, note, observedAt, ageMs })

const unavailable = <T>(source: string | null, note: string): LiveField<T> =>
  field<T>(null, 'UNAVAILABLE', source, note)

const unknown = <T>(source: string | null, note: string): LiveField<T> =>
  field<T>(null, 'UNKNOWN', source, note)

const isGreywolf = (courseKey: string | null) =>
  Boolean(courseKey && courseKey.toLowerCase().includes('greywolf'))

const normalizeDegrees = (value: number) => ((value % 360) + 360) % 360

const pointInPolygon = (point: CoursePointYds, polygon: CoursePolygonYds) => {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    const intersects = ((yi > point[1]) !== (yj > point[1]))
      && (point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi)
    if (intersects) inside = !inside
  }
  return inside
}

const surfacePriority: CourseSurfaceClassification[] = [
  'green',
  'bunker',
  'water',
  'penalty',
  'tee',
  'fairway',
  'deep-rough',
  'rough',
]

const classifyCourseSurface = (
  hole: CourseHoleGeometry,
  point: CoursePointYds,
): CourseSurfaceClassification => {
  for (const kind of surfacePriority) {
    const hit = hole.surfaces.some((surface) =>
      surface.kind === kind && surface.polygons.some((polygon) => pointInPolygon(point, polygon)))
    if (hit) return kind
  }
  return 'unknown'
}

const bearingFromLocal = (from: CoursePointYds, to: CoursePointYds) => {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (Math.hypot(dx, dy) <= Number.EPSILON) return null
  const degrees = Math.atan2(dx, dy) * 180 / Math.PI
  return normalizeDegrees(degrees)
}

const terrainPlaneAt = (
  hole: CourseHoleGeometry,
  point: CoursePointYds,
  stepYds = 1,
): TerrainPlane | null => {
  const center = estimateGreywolfTerrain(hole, point)
  const left = estimateGreywolfTerrain(hole, [point[0] - stepYds, point[1]])
  const right = estimateGreywolfTerrain(hole, [point[0] + stepYds, point[1]])
  const back = estimateGreywolfTerrain(hole, [point[0], point[1] - stepYds])
  const forward = estimateGreywolfTerrain(hole, [point[0], point[1] + stepYds])
  if (!center || !left || !right || !back || !forward) return null

  const horizontalSpanFt = stepYds * 2 * 3
  return {
    elevationFt: center.elevationFt,
    gradientRightFtPerFt: (right.elevationFt - left.elevationFt) / horizontalSpanFt,
    gradientForwardFtPerFt: (forward.elevationFt - back.elevationFt) / horizontalSpanFt,
    sampleStepYds: stepYds,
    source: center.source,
  }
}

const projectTerrainToShot = (
  plane: TerrainPlane,
  ball: CoursePointYds,
  target: CoursePointYds,
) => {
  const dx = target[0] - ball[0]
  const dy = target[1] - ball[1]
  const length = Math.hypot(dx, dy)
  if (length <= Number.EPSILON) return null
  const forwardX = dx / length
  const forwardY = dy / length
  const shotRightX = forwardY
  const shotRightY = -forwardX
  const forwardSlope = plane.gradientRightFtPerFt * forwardX
    + plane.gradientForwardFtPerFt * forwardY
  const rightSlope = plane.gradientRightFtPerFt * shotRightX
    + plane.gradientForwardFtPerFt * shotRightY
  return {
    upDownDeg: Math.atan(forwardSlope) * 180 / Math.PI,
    leftRightDeg: Math.atan(rightSlope) * 180 / Math.PI,
  }
}

const gsproStatus = (snapshot: BrowserGsproCourseSnapshot): LiveStateStatus => {
  if (snapshot.health.integrity === 'stale') return 'STALE'
  return 'READY'
}

const sourceField = (
  state: 'available' | 'missing' | 'invalid',
  integrity: BrowserGsproCourseSnapshot['health']['integrity'],
  source: string,
  observedAt: string,
  ageMs: number | null,
): LiveField<string> => {
  if (state === 'invalid') return field<string>(null, 'UNKNOWN', source, 'Source exists but could not be parsed.', observedAt, ageMs)
  if (state === 'missing') return field<string>(null, 'UNAVAILABLE', source, 'Source file is not currently available.', observedAt, ageMs)
  return field('available', integrity === 'stale' ? 'STALE' : 'READY', source, undefined, observedAt, ageMs)
}

export const assembleLiveShotState = async ({
  snapshot,
  revision,
  wind = null,
  roundTeeSelection = null,
}: AssembleLiveShotStateInput): Promise<LiveShotState> => {
  const assembledAtMs = Date.now()
  const assembledAt = new Date(assembledAtMs).toISOString()
  const sourceStatus = gsproStatus(snapshot)
  const teeSelection = roundTeeSelection
  const observedBall = snapshot.ballSource === 'cached-tee' ? null : snapshot.ballLocalYds
  const selectedTeeBall = snapshot.ballSource === 'cached-tee'
    ? teeSelection?.coursePoint ?? null
    : null
  // Never let the watcher's continuity-only cached [0,0] stand in for an
  // observed tee. Shot-1 course calculations require either a real GSPro ball
  // position or an explicit tee selection with exact packaged coordinates.
  const ball = observedBall ?? selectedTeeBall
  const ballSource = observedBall
    ? `GSPro ${snapshot.ballSource}`
    : selectedTeeBall
      ? 'round tee selection'
      : null
  const holeNumber = snapshot.holeNumber
  const greywolf = isGreywolf(snapshot.courseKey)

  // The health wrapper can see a newly-created/pre-impact ShotID slightly before
  // the core watcher accepts it as a completed physical shot. Raw EndingPOS is
  // trustworthy only when both layers agree on the same latest completed ShotID.
  const coreLatestShotId = snapshot.latestShot?.shotId ?? null
  const healthLatestShotId = snapshot.health.roundIdentity?.latestShotId ?? null
  const ballWorldAligned = Boolean(
    snapshot.ballWorld
    && coreLatestShotId
    && healthLatestShotId
    && coreLatestShotId === healthLatestShotId,
  )

  let hole: CourseHoleGeometry | null = null
  let geometryError: string | null = null
  if (greywolf && holeNumber != null) {
    try {
      hole = await loadCourseHoleGeometry(GREYWOLF_COURSE_ID, holeNumber)
    } catch (error) {
      geometryError = error instanceof Error ? error.message : String(error)
    }
  }

  const target = hole?.markers.pin ?? null
  const aimBearing = ball && target ? bearingFromLocal(ball, target) : null
  const holeTrueHeadingDegrees = greywolf && holeNumber != null
    ? getRouteHoleHeadingDegreesTrue(GREYWOLF_COURSE_ID, holeNumber)
    : null
  const aimCompassBearing = aimBearing != null && holeTrueHeadingDegrees != null
    ? normalizeDegrees(holeTrueHeadingDegrees + aimBearing)
    : null
  const calculatedDistance = ball && target
    ? Math.hypot(target[0] - ball[0], target[1] - ball[1])
    : null
  const distance = snapshot.distanceToPinYds ?? calculatedDistance

  const terrainPlane = hole && ball ? terrainPlaneAt(hole, ball) : null
  const terrainProjection = terrainPlane && ball && target
    ? projectTerrainToShot(terrainPlane, ball, target)
    : null
  const targetTerrain = hole && target ? estimateGreywolfTerrain(hole, target) : null
  const courseSurface = hole && ball ? classifyCourseSurface(hole, ball) : 'unknown'

  const registration = hole?.registration ?? null
  const residual = registration?.residualsMeters?.max
    ?? registration?.residualsMeters?.mean
    ?? registration?.residualsMeters?.median
    ?? null

  const windObservedAtMs = wind ? Date.parse(wind.observedAt) : Number.NaN
  const windAgeMs = Number.isFinite(windObservedAtMs)
    ? Math.max(0, assembledAtMs - windObservedAtMs)
    : null
  const windProjection = projectWindObservation(wind, aimBearing, aimCompassBearing)
  const windReady = wind?.status === 'READY'
    && wind.speedMph != null
    && wind.directionDegrees != null
    && wind.convention != null
    && wind.referenceFrame != null
    && wind.referenceFrame !== 'unknown'
    && windProjection.projection != null

  const teeDetectionMethod: LiveShotState['tee']['detectionMethod'] = teeSelection?.coursePoint
    ? 'round-selection'
    : 'unknown'

  const coreCourseReady = Boolean(
    ball
    && hole
    && target
    && terrainPlane
    && terrainProjection
    && distance != null
    && courseSurface !== 'unknown',
  )

  const overallStatus: LiveStateStatus =
    sourceStatus === 'STALE'
      ? 'STALE'
      : !coreCourseReady
        ? 'UNKNOWN'
        : !windReady
          ? 'UNAVAILABLE'
          : 'READY'

  return {
    revision,
    assembledAt,
    overallStatus,
    game: {
      course: snapshot.courseKey
        ? field(snapshot.courseKey, sourceStatus, 'GSPro currentRound.dat', undefined, snapshot.observedAt)
        : unknown('GSPro', 'Course key has not been observed.'),
      hole: holeNumber != null
        ? field(holeNumber, sourceStatus, 'reliable GSPro course-state watcher', undefined, snapshot.observedAt)
        : unknown('GSPro', 'Current hole is not established.'),
      shotNumber: snapshot.nextShotNumber != null
        ? field(snapshot.nextShotNumber, sourceStatus, 'reliable GSPro course-state watcher', undefined, snapshot.observedAt)
        : unknown('GSPro', 'Next shot number is not established.'),
      ballPositionWorld: ballWorldAligned && snapshot.ballWorld
        ? field(snapshot.ballWorld, sourceStatus, 'GSPro currentRound.dat EndingPOS', undefined, snapshot.observedAt)
        : unavailable(
            'GSPro currentRound.dat',
            snapshot.ballWorld
              ? 'Raw EndingPOS was withheld because the health layer latest ShotID did not match the core watcher latest completed ShotID.'
              : 'No trustworthy EndingPOS XYZ exists for the current pre-shot state. Cached tee positions never fabricate raw world coordinates.',
          ),
      ballPositionLocalYds: ball
        ? field(
            ball,
            sourceStatus,
            ballSource,
            selectedTeeBall
              ? 'Shot-1 position comes from an explicit tee selection with exact packaged coordinates.'
              : undefined,
            snapshot.observedAt,
          )
        : unknown(
            'tee resolver',
            snapshot.ballSource === 'cached-tee'
              ? 'GSPro has not exposed a physical shot-1 position and no exact tee selection is established. Cached [0,0] is deliberately blocked from course calculations.'
              : 'No trustworthy current ball coordinate is available.',
          ),
      startingSurface: snapshot.surface
        ? field(snapshot.surface, sourceStatus, `GSPro ${snapshot.surfaceSource}`, undefined, snapshot.observedAt)
        : unknown('GSPro', 'Starting surface is not currently observed.'),
      targetPositionWorld: unavailable('GSPro', 'Raw target/pin XYZ is not exposed by the current browser snapshot contract.'),
      targetPositionLocalYds: target
        ? field(target, 'READY', 'Greywolf course package')
        : unavailable('course geometry', greywolf ? geometryError ?? 'Pin marker is unavailable for this hole.' : 'This diagnostic slice is Greywolf-only.'),
      targetDistanceYards: distance != null
        ? field(distance, sourceStatus, snapshot.distanceToPinYds != null ? 'GSPro currentRound.dat' : 'derived local geometry', undefined, snapshot.observedAt)
        : unknown(null, 'Target distance cannot be established.'),
      aimBearingDegrees: aimBearing != null
        ? field(aimBearing, 'READY', 'derived ball→pin local bearing', '0° is hole-local forward; positive rotates toward local right.')
        : unknown(null, 'Aim direction is not available; ball→pin bearing is shown only when both local points are known.'),
      aimCompassBearingDegrees: aimCompassBearing != null
        ? field(
            aimCompassBearing,
            'READY',
            'OSM true hole heading + ball→pin local bearing',
            `True-north bearing. Hole ${holeNumber ?? '—'} packaged heading=${holeTrueHeadingDegrees?.toFixed(2) ?? '—'}°. This is currently ball→pin, not a future decision-engine aim point.`,
          )
        : unavailable('course registration', 'A validated route true heading plus local ball→pin bearing are required.'),
    },
    course: {
      matchedCoordinate: ball && hole
        ? field(ball, sourceStatus, ballSource ?? 'course registration', undefined, snapshot.observedAt)
        : unknown('course registration', geometryError ?? 'Ball/course registration is not ready.'),
      groundElevationFt: terrainPlane
        ? field(terrainPlane.elevationFt, 'READY', terrainPlane.source)
        : unavailable('Greywolf terrain', geometryError ?? 'Direct terrain sample is unavailable at the ball.'),
      terrainPlane: terrainPlane
        ? field(terrainPlane, 'READY', terrainPlane.source, 'Central-difference plane from ±1 yd samples around the ball.')
        : unavailable('Greywolf terrain', geometryError ?? 'Local terrain plane could not be sampled.'),
      uphillDownhillLieDegrees: terrainProjection
        ? field(terrainProjection.upDownDeg, 'READY', 'derived local terrain plane', 'Positive = ground rises toward the target; GSPro sign calibration remains explicit validation work.')
        : unavailable('derived terrain', 'Ball, target, and local terrain plane are all required.'),
      leftRightLieDegrees: terrainProjection
        ? field(terrainProjection.leftRightDeg, 'READY', 'derived local terrain plane', 'Positive = ground rises toward shot-right; GSPro sidehill sign calibration remains explicit validation work.')
        : unavailable('derived terrain', 'Ball, target, and local terrain plane are all required.'),
      surface: courseSurface !== 'unknown'
        ? field(courseSurface, 'READY', 'Greywolf OSM course polygons')
        : unknown('Greywolf OSM course polygons', 'Ball is not inside a known surface polygon; no rough default is substituted.'),
      targetElevationChangeFt: terrainPlane && targetTerrain
        ? field(targetTerrain.elevationFt - terrainPlane.elevationFt, 'READY', `${terrainPlane.source}→${targetTerrain.source}`)
        : unavailable('Greywolf terrain', 'Ball and target elevations are both required.'),
      registrationResidualMeters: residual != null
        ? field(residual, registration?.status === 'verified' ? 'READY' : 'UNKNOWN', 'course registration', `Using ${registration?.residualsMeters?.max != null ? 'max' : registration?.residualsMeters?.mean != null ? 'mean' : 'median'} residual from packaged registration validation.`)
        : unknown('course registration', registration?.note ?? geometryError ?? 'No packaged registration residual is available.'),
    },
    wind: {
      speedMph: wind?.speedMph != null
        ? field(wind.speedMph, wind.status, wind.source, wind.note, wind.observedAt, windAgeMs)
        : unavailable('wind observation bridge', 'No live HUD wind observation is connected; calm/0 is never assumed.'),
      directionDegrees: wind?.directionDegrees != null
        ? field(wind.directionDegrees, wind.status, wind.source, wind.note, wind.observedAt, windAgeMs)
        : unavailable('wind observation bridge', 'Wind direction is not currently observed.'),
      directionConvention: wind?.convention
        ? field(wind.convention, wind.status, wind.source, wind.note, wind.observedAt, windAgeMs)
        : unavailable('wind calibration', 'Wind from/toward convention is not currently established.'),
      referenceFrame: wind?.referenceFrame && wind.referenceFrame !== 'unknown'
        ? field(wind.referenceFrame, wind.status, wind.source, wind.note, wind.observedAt, windAgeMs)
        : unavailable('wind observation bridge', 'Wind direction reference frame is not established.'),
      ocrConfidence: wind?.confidence != null
        ? field(wind.confidence, wind.status, wind.source, wind.rawText ? `OCR raw: ${wind.rawText}` : wind.note, wind.observedAt, windAgeMs)
        : unavailable('wind OCR', wind ? `OCR engine did not expose confidence.${wind.rawText ? ` Raw: ${wind.rawText}` : ''}` : 'No HUD OCR observation is connected.'),
      helpingHurtingMph: windProjection.projection
        ? field(
            windProjection.projection.helpingHurtingMph,
            wind?.status ?? 'UNKNOWN',
            'wind projection',
            windProjection.projection.note,
            wind?.observedAt,
            windAgeMs,
          )
        : unavailable('wind projection', windProjection.unavailableReason),
      leftRightMph: windProjection.projection
        ? field(
            windProjection.projection.leftRightMph,
            wind?.status ?? 'UNKNOWN',
            'wind projection',
            windProjection.projection.note,
            wind?.observedAt,
            windAgeMs,
          )
        : unavailable('wind projection', windProjection.unavailableReason),
    },
    tee: {
      selection: teeSelection?.coursePoint
        ? field(teeSelection, 'READY', 'round tee selection')
        : unknown('tee resolver', snapshot.ballSource === 'cached-tee'
          ? 'cached-tee [0,0] is a continuity placeholder, not tee detection. An exact tee position is required before shot-1 course calculations can be READY.'
          : 'No persisted round tee selection or validated position match exists.'),
      detectionMethod: teeDetectionMethod,
    },
    sources: {
      currentRound: sourceField(
        snapshot.health.currentRound.state,
        snapshot.health.integrity,
        'currentRound.dat',
        snapshot.health.observedAt,
        snapshot.health.currentRound.modifiedAgeMs,
      ),
      outputLog: sourceField(
        snapshot.health.outputLog.state,
        snapshot.health.integrity,
        'output_log.txt',
        snapshot.health.observedAt,
        snapshot.health.outputLog.modifiedAgeMs,
      ),
      registration: hole
        ? field(hole.registration.status, hole.registration.status === 'verified' ? 'READY' : 'UNKNOWN', 'course package', hole.registration.note)
        : unavailable('course package', geometryError ?? 'Greywolf geometry is not loaded.'),
      lidar: terrainPlane
        ? field(terrainPlane.source, terrainPlane.source === 'lidar-dem' ? 'READY' : 'UNKNOWN', 'Greywolf terrain package')
        : unavailable('Greywolf terrain package', geometryError ?? 'No local terrain sample is available.'),
      windOcr: wind
        ? field(
            wind.source,
            wind.status,
            wind.source,
            [wind.note, wind.rawText ? `raw=${wind.rawText}` : null].filter(Boolean).join(' · ') || undefined,
            wind.observedAt,
            windAgeMs,
          )
        : unavailable('wind OCR', 'No HUD OCR observation has been received from the bundled helper.'),
    },
    decision: {
      playerProfileId: null,
      recommendedClub: null,
      selectedClub: null,
      expectedCarryYards: null,
      intendedAimPoint: null,
    },
  }
}
