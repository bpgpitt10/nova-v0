import { GREYWOLF_COURSE_ID } from './courseCatalog'
import {
  listTeeCalibrations,
  loadTeeCalibration,
  lockTeeCalibration,
  saveTeeCalibrationCandidate,
  type TeeCalibrationRecord,
  type TeeCalibrationWorldPoint,
  type TeeCalibrationWriteResult,
} from './teeCalibrationStore'
import type { CoursePointYds } from './types'

const METERS_TO_YARDS = 1.0936132983377078
const WORLD_ROTATION_DEG = 0.5319220319046369
const H1_ANCHOR_OSM_ID = '1209190795'
const H1_ANCHOR_TEE_TO_GREEN_CENTROID_YDS = 347.7
const H1_ANCHOR_LAT_LON = [50.446423107692304, -116.24757067692309] as const
const H1_GREEN_LAT_LON = [50.443634984615386, -116.24856764615384] as const
const H1_OSM_CANDIDATE_DISTANCES_YDS = Object.freeze([
  347.7,
  368.8,
  391.6,
  512.7,
  534.6,
  556.6,
])
const LOCAL_POINT_TOLERANCE_YDS = 0.25
const WORLD_POINT_TOLERANCE = 0.05

export const GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT = `${GREYWOLF_COURSE_ID}::v1`

export type GreywolfH1StartingPositionObservation = Readonly<{
  teeSet: string
  world: TeeCalibrationWorldPoint
  distanceToPinYds: number | null
}>

export type GreywolfH1StartingPositionCaptureResult =
  | Readonly<{
      status: 'anchor-locked' | 'candidate-saved' | 'unchanged'
      record: TeeCalibrationRecord
      write: TeeCalibrationWriteResult
    }>
  | Readonly<{
      status: 'needs-anchor'
      reason: string
    }>
  | Readonly<{
      status: 'conflict' | 'invalid'
      reason: string
      write: TeeCalibrationWriteResult
    }>

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const h1ForwardEastNorth = (() => {
  const meanLatRad = ((H1_ANCHOR_LAT_LON[0] + H1_GREEN_LAT_LON[0]) / 2) * Math.PI / 180
  const east = (H1_GREEN_LAT_LON[1] - H1_ANCHOR_LAT_LON[1]) * Math.cos(meanLatRad)
  const north = H1_GREEN_LAT_LON[0] - H1_ANCHOR_LAT_LON[0]
  const length = Math.hypot(east, north)
  return [east / length, north / length] as const
})()

const worldDeltaToEastNorthYards = (dx: number, dz: number) => {
  const radians = WORLD_ROTATION_DEG * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    east: METERS_TO_YARDS * (cos * dx - sin * dz),
    north: METERS_TO_YARDS * (sin * dx + cos * dz),
  }
}

const localDistance = (left: CoursePointYds, right: CoursePointYds) =>
  Math.hypot(left[0] - right[0], left[1] - right[1])

const worldDistance = (left: TeeCalibrationWorldPoint, right: TeeCalibrationWorldPoint) =>
  Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)

const samePhysicalCalibration = (
  existing: TeeCalibrationRecord | null,
  local: CoursePointYds,
  world: TeeCalibrationWorldPoint,
) => Boolean(
  existing?.gsproWorld
  && localDistance(existing.courseLocalYds, local) <= LOCAL_POINT_TOLERANCE_YDS
  && worldDistance(existing.gsproWorld, world) <= WORLD_POINT_TOLERANCE,
)

/**
 * Converts a GSPro world point into the fixed Greywolf H1 package frame.
 * The anchor world point must be the GSPro StartingPOS associated with OSM tee
 * 1209190795, which is the [0, 0] origin of the retained H1 geometry package.
 */
export const gsproWorldToGreywolfH1Local = (
  world: TeeCalibrationWorldPoint,
  anchorWorld: TeeCalibrationWorldPoint,
): CoursePointYds => {
  const delta = worldDeltaToEastNorthYards(
    world.x - anchorWorld.x,
    world.z - anchorWorld.z,
  )
  const [forwardEast, forwardNorth] = h1ForwardEastNorth
  const rightEast = forwardNorth
  const rightNorth = -forwardEast
  return [
    delta.east * rightEast + delta.north * rightNorth,
    delta.east * forwardEast + delta.north * forwardNorth,
  ]
}

const uniqueAnchorDistanceMatch = (distanceToPinYds: number | null) => {
  if (!finite(distanceToPinYds) || distanceToPinYds <= 0) return false
  const ranked = H1_OSM_CANDIDATE_DISTANCES_YDS
    .map((distance) => ({ distance, residual: Math.abs(distanceToPinYds - distance) }))
    .sort((left, right) => left.residual - right.residual)
  const best = ranked[0]
  const second = ranked[1]
  if (best.distance !== H1_ANCHOR_TEE_TO_GREEN_CENTROID_YDS) return false
  if (best.residual > 10) return false
  return !second || second.residual - best.residual >= 8
}

const lockedAnchorCalibration = () =>
  listTeeCalibrations(GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT)
    .find((record) => (
      record.holeNumber === 1
      && record.status === 'locked'
      && record.osmTeeId === H1_ANCHOR_OSM_ID
      && record.gsproWorld != null
    )) ?? null

const unchangedResult = (record: TeeCalibrationRecord): GreywolfH1StartingPositionCaptureResult => ({
  status: 'unchanged',
  record,
  write: { outcome: 'unchanged', record },
})

const mapWriteResult = (
  write: TeeCalibrationWriteResult,
  savedStatus: 'anchor-locked' | 'candidate-saved',
): GreywolfH1StartingPositionCaptureResult => {
  if (write.outcome === 'saved') return { status: savedStatus, record: write.record, write }
  if (write.outcome === 'unchanged') return unchangedResult(write.record)
  if (write.outcome === 'locked-conflict') {
    return {
      status: 'conflict',
      reason: `Locked tee calibration conflicts on ${write.conflictFields.join(', ')}.`,
      write,
    }
  }
  return { status: 'invalid', reason: write.reason, write }
}

/**
 * H1 validation bridge between GSPro CurrentShot.StartingPOS and the retained
 * Greywolf geometry frame.
 *
 * The first trustworthy observation that uniquely matches the package origin
 * becomes the locked registration anchor. After that, every selected tee set
 * can be located from its GSPro world delta even when OSM has no tee feature
 * for that physical start. No nearest-OSM fallback is used.
 */
export const captureGreywolfH1StartingPosition = (
  observation: GreywolfH1StartingPositionObservation,
): GreywolfH1StartingPositionCaptureResult => {
  const teeSet = observation.teeSet.trim()
  if (!teeSet) {
    const write = { outcome: 'invalid', reason: 'A selected tee set is required.' } as const
    return { status: 'invalid', reason: write.reason, write }
  }

  const existing = loadTeeCalibration(
    GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT,
    1,
    teeSet,
  )

  if (uniqueAnchorDistanceMatch(observation.distanceToPinYds)) {
    if (
      existing?.status === 'locked'
      && existing.osmTeeId === H1_ANCHOR_OSM_ID
      && samePhysicalCalibration(existing, [0, 0], observation.world)
    ) return unchangedResult(existing)

    const write = lockTeeCalibration({
      courseFingerprint: GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT,
      holeNumber: 1,
      teeSet,
      teeLabel: teeSet,
      osmTeeId: H1_ANCHOR_OSM_ID,
      courseLocalYds: [0, 0],
      gsproWorld: observation.world,
      ...(finite(observation.distanceToPinYds)
        ? { expectedYardageYds: observation.distanceToPinYds }
        : {}),
      confidence: 0.99,
      confirmationMethod: 'gspro-current-shot-plus-unique-osm-anchor-distance',
    })
    return mapWriteResult(write, 'anchor-locked')
  }

  const anchor = lockedAnchorCalibration()
  if (!anchor?.gsproWorld) {
    if (existing?.gsproWorld) return unchangedResult(existing)
    return {
      status: 'needs-anchor',
      reason: 'Greywolf H1 needs one locked GSPro-to-OSM anchor before an unmapped tee can be placed in the package frame.',
    }
  }

  const courseLocalYds = gsproWorldToGreywolfH1Local(observation.world, anchor.gsproWorld)
  if (samePhysicalCalibration(existing, courseLocalYds, observation.world) && existing) {
    return unchangedResult(existing)
  }

  const write = saveTeeCalibrationCandidate({
    courseFingerprint: GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT,
    holeNumber: 1,
    teeSet,
    teeLabel: teeSet,
    courseLocalYds,
    gsproWorld: observation.world,
    ...(finite(observation.distanceToPinYds)
      ? { expectedYardageYds: observation.distanceToPinYds }
      : {}),
    confidence: 0.95,
    confirmationMethod: 'gspro-current-shot-relative-to-locked-h1-osm-anchor',
  })
  return mapWriteResult(write, 'candidate-saved')
}
