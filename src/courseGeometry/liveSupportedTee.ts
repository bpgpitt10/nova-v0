import type { GsproStartingPositionObservation } from '../adapters/gsproStartingPosition'
import { loadActiveLiveCaddieRound } from '../liveCaddie/roundRuntime'
import { estimateProvisionalTee } from './provisionalTeeEstimate'
import { courseGeometryFingerprint } from './shotOneTeeResolver'
import { loadTeeCalibration } from './teeCalibrationStore'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseTeeCandidate,
} from './types'

const MAX_DISTANCE_RESIDUAL_YDS = 30
const MIN_RUNNER_UP_MARGIN_YDS = 8

export type LiveSupportedTeeResolution =
  | Readonly<{
      status: 'supported'
      courseLocalYds: CoursePointYds
      candidate: CourseTeeCandidate | null
      residualYds: number | null
      referenceDistanceYds: number | null
      reason: string
      placement: 'mapped' | 'locked' | 'provisional'
      uncertaintyRadiusYds: number | null
    }>
  | Readonly<{
      status: 'unsupported'
      courseLocalYds: null
      candidate: CourseTeeCandidate | null
      residualYds: number | null
      referenceDistanceYds: number | null
      reason: string
    }>

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const pointDistance = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(b[0] - a[0], b[1] - a[1])

const normalize = (value: string | null | undefined) =>
  value?.trim().replace(/\s+/g, ' ').toLowerCase() ?? ''

const candidateReferenceDistance = (
  geometry: CourseHoleGeometry,
  candidate: CourseTeeCandidate,
) => {
  if (finite(candidate.teeToGreenCentroidYards) && candidate.teeToGreenCentroidYards > 0) {
    return candidate.teeToGreenCentroidYards
  }
  return geometry.markers.pin
    ? pointDistance(candidate.coursePoint, geometry.markers.pin)
    : null
}

const candidateLabel = (candidate: CourseTeeCandidate) => {
  const identity = candidate.label
    ?? candidate.teeSet
    ?? candidate.color
    ?? candidate.name
    ?? candidate.ref
  if (identity) return identity
  if (candidate.osmId != null) return `OSM tee ${candidate.osmId}`
  return 'OSM tee'
}

const candidateMatchesTeeSet = (candidate: CourseTeeCandidate, teeSet: string) => {
  const wanted = normalize(teeSet)
  if (!wanted) return false
  return [
    candidate.teeSet,
    ...(candidate.teeAliases ?? []),
    candidate.color,
    candidate.label,
    candidate.name,
    candidate.ref,
  ].some((value) => normalize(value) === wanted)
}

/**
 * Live tee contract.
 *
 * Once the golfer explicitly starts a Looper round with a course + tee set,
 * that selection is authoritative for the round. GSPro pre-shot state is useful
 * evidence, but it must never silently redefine Black as Blue (or any other tee).
 * The imported/inferred tee for each hole is therefore used immediately and
 * GSPro observations are treated as validation evidence rather than a prerequisite.
 *
 * The older distance-to-pin matcher remains as a conservative fallback for
 * legacy/dev flows that do not have an active configured round.
 */
export const resolveLiveSupportedTee = (
  geometry: CourseHoleGeometry,
  observation: GsproStartingPositionObservation | null,
): LiveSupportedTeeResolution => {
  const activeRound = loadActiveLiveCaddieRound()
  if (activeRound && activeRound.courseId === geometry.courseId) {
    const matches = (geometry.teeCandidates ?? [])
      .filter((candidate) => candidateMatchesTeeSet(candidate, activeRound.normalizedTeeSet))

    const candidate = matches.length === 1 ? matches[0] : null
    const locked = loadTeeCalibration(
      courseGeometryFingerprint(geometry), geometry.holeNumber, activeRound.normalizedTeeSet,
    )
    const exactLocked = locked?.status === 'locked' ? locked : null
    // ONLY an unmapped OSM route origin may be estimated. Existing mapped or
    // locked tee positions have strict priority over the synthetic fallback.
    const provisional = !candidate && !exactLocked
      && geometry.coordinateSystem.origin === 'osm-hole-route-start'
      ? estimateProvisionalTee(geometry,
          observation?.holeNumber === geometry.holeNumber
          && observation.shotNumber === 1
          && observation.surface === 'tee'
          && finite(observation.distanceToPinYds)
            ? observation.distanceToPinYds : null)
      : null
    if (provisional?.status === 'blocked') {
      return {
        status: 'unsupported', courseLocalYds: null, candidate: null,
        residualYds: null, referenceDistanceYds: null,
        reason: provisional.reason,
      }
    }
    const courseLocalYds: CoursePointYds = exactLocked
      ? exactLocked.courseLocalYds
      : provisional?.status === 'provisional'
        ? provisional.point
        : geometry.holeNumber === 1 && activeRound.assumedTeeLocalYds
          ? [activeRound.assumedTeeLocalYds[0], activeRound.assumedTeeLocalYds[1]]
          : candidate?.coursePoint ?? geometry.markers.tee
    const referenceDistanceYds = candidate
      ? candidateReferenceDistance(geometry, candidate)
      : geometry.markers.pin
        ? pointDistance(courseLocalYds, geometry.markers.pin)
        : null
    const residualYds = observation && finite(observation.distanceToPinYds) && finite(referenceDistanceYds)
      ? Math.abs(observation.distanceToPinYds - referenceDistanceYds)
      : null

    return {
      status: 'supported',
      courseLocalYds,
      candidate,
      residualYds,
      referenceDistanceYds,
      placement: exactLocked ? 'locked' : provisional?.status === 'provisional' ? 'provisional' : 'mapped',
      uncertaintyRadiusYds: provisional?.status === 'provisional' ? provisional.uncertaintyRadiusYds : null,
      reason: exactLocked
        ? 'Using locked ' + activeRound.teeSet + ' tee calibration.'
        : provisional?.status === 'provisional'
          ? 'Provisional Hole ' + geometry.holeNumber + ' tee (' + provisional.source +
            '), ±' + provisional.uncertaintyRadiusYds + ' yd. ' + provisional.note
          : candidate
            ? 'Using selected ' + activeRound.teeSet + ' tee (' + candidateLabel(candidate) +
              ') on Hole ' + geometry.holeNumber + '. GSPro is validation evidence only.'
            : 'Using the active round assumed ' + activeRound.teeSet + ' tee on Hole ' +
              geometry.holeNumber + '. GSPro is validation evidence only.',
    }
  }

  if (!observation) {
    return {
      status: 'unsupported',
      courseLocalYds: null,
      candidate: null,
      residualYds: null,
      referenceDistanceYds: null,
      reason: 'GSPro pre-shot StartingPOS is not available yet.',
    }
  }

  if (
    observation.holeNumber != null
    && observation.holeNumber !== geometry.holeNumber
  ) {
    return {
      status: 'unsupported',
      courseLocalYds: null,
      candidate: null,
      residualYds: null,
      referenceDistanceYds: null,
      reason: `GSPro reports Hole ${observation.holeNumber}, not Hole ${geometry.holeNumber}.`,
    }
  }

  if (observation.shotNumber != null && observation.shotNumber !== 1) {
    return {
      status: 'unsupported',
      courseLocalYds: null,
      candidate: null,
      residualYds: null,
      referenceDistanceYds: null,
      reason: `GSPro reports Shot ${observation.shotNumber}; live tee reconciliation only applies to Shot 1.`,
    }
  }

  if (observation.surface && observation.surface !== 'tee') {
    return {
      status: 'unsupported',
      courseLocalYds: null,
      candidate: null,
      residualYds: null,
      referenceDistanceYds: null,
      reason: `GSPro reports ${observation.surface}, not a tee start.`,
    }
  }

  if (!finite(observation.distanceToPinYds) || observation.distanceToPinYds <= 0) {
    return {
      status: 'unsupported',
      courseLocalYds: null,
      candidate: null,
      residualYds: null,
      referenceDistanceYds: null,
      reason: 'GSPro did not expose a usable pre-shot distance-to-pin for tee reconciliation.',
    }
  }

  const ranked = (geometry.teeCandidates ?? [])
    .filter((candidate) => candidate.osmId != null)
    .flatMap((candidate) => {
      const referenceDistanceYds = candidateReferenceDistance(geometry, candidate)
      if (!finite(referenceDistanceYds) || referenceDistanceYds <= 0) return []
      return [{
        candidate,
        referenceDistanceYds,
        residualYds: Math.abs(observation.distanceToPinYds! - referenceDistanceYds),
      }]
    })
    .sort((left, right) => left.residualYds - right.residualYds)

  if (ranked.length === 0) {
    return {
      status: 'unsupported',
      courseLocalYds: null,
      candidate: null,
      residualYds: null,
      referenceDistanceYds: null,
      reason: 'This imported hole does not expose a usable OSM tee candidate for Shot 1.',
    }
  }

  const best = ranked[0]
  const runnerUp = ranked[1] ?? null
  if (best.residualYds > MAX_DISTANCE_RESIDUAL_YDS) {
    return {
      status: 'unsupported',
      courseLocalYds: null,
      candidate: best.candidate,
      residualYds: best.residualYds,
      referenceDistanceYds: best.referenceDistanceYds,
      reason: `No supported OSM tee matches the GSPro start closely enough; nearest is ${candidateLabel(best.candidate)} (${best.residualYds.toFixed(1)} yd residual).`,
    }
  }

  if (
    runnerUp
    && runnerUp.residualYds - best.residualYds < MIN_RUNNER_UP_MARGIN_YDS
  ) {
    return {
      status: 'unsupported',
      courseLocalYds: null,
      candidate: best.candidate,
      residualYds: best.residualYds,
      referenceDistanceYds: best.referenceDistanceYds,
      reason: `GSPro tee distance is ambiguous between multiple OSM tee candidates; refusing to guess.`,
    }
  }

  return {
    status: 'supported',
    courseLocalYds: best.candidate.coursePoint,
    candidate: best.candidate,
    residualYds: best.residualYds,
    referenceDistanceYds: best.referenceDistanceYds,
    reason: `Matched GSPro Shot 1 to ${candidateLabel(best.candidate)} (${best.residualYds.toFixed(1)} yd residual).`,
    placement: 'mapped',
    uncertaintyRadiusYds: null,
  }
}
