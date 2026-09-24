import type { GsproStartingPositionObservation } from '../adapters/gsproStartingPosition'
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
      candidate: CourseTeeCandidate
      residualYds: number
      referenceDistanceYds: number
      reason: string
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

/**
 * V1 live-tee contract.
 *
 * We only support Shot 1 when GSPro's pre-shot distance-to-pin can be
 * reconciled to one retained OSM tee candidate for the imported hole. This is
 * intentionally conservative: no nearest-position snapping, no synthetic tee,
 * and no learning an unmapped tee from GSPro coordinates.
 *
 * The absolute residual allowance absorbs normal pin-vs-green-centroid
 * differences. The runner-up margin prevents two nearby tee boxes from being
 * treated as an identity match when the evidence is ambiguous.
 */
export const resolveLiveSupportedTee = (
  geometry: CourseHoleGeometry,
  observation: GsproStartingPositionObservation | null,
): LiveSupportedTeeResolution => {
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
  }
}
