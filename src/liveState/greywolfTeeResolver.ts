import type { CoursePointYds } from '../courseGeometry/types'
import type { TeeSelection } from './types'

export type GreywolfTeeCandidate = Readonly<{
  osmId: number
  coursePoint: CoursePointYds
  teeToGreenCentroidYards: number
  sourceLatLon: readonly [latitude: number, longitude: number]
  source: string
}>

export type TeeDistanceResolution = Readonly<{
  selection: TeeSelection | null
  candidate: GreywolfTeeCandidate | null
  observedDistanceYards: number | null
  bestResidualYards: number | null
  secondBestResidualYards: number | null
  status: 'MATCHED' | 'AMBIGUOUS' | 'NO_MATCH' | 'NO_OBSERVATION' | 'UNAVAILABLE'
  note: string
}>

/**
 * H1-only validation candidates recovered from the preserved Greywolf OSM tee
 * matching artifact on hazard-field-lab-v0. Coordinates are projected into the
 * existing Hole-1 local frame whose origin is OSM tee 1209190795 and whose
 * +forward axis points to the retained target-green centroid.
 *
 * Do not extend this table by inference. Additional holes should be promoted
 * only from retained source centroids through the same package-generation path.
 */
export const GREYWOLF_H1_TEE_CANDIDATES: readonly GreywolfTeeCandidate[] = Object.freeze([
  Object.freeze({
    osmId: 1209190795,
    coursePoint: Object.freeze([0, 0]) as CoursePointYds,
    teeToGreenCentroidYards: 347.7,
    sourceLatLon: Object.freeze([50.446423107692304, -116.24757067692309]) as readonly [number, number],
    source: 'preserved Greywolf OSM tee-match artifact',
  }),
  Object.freeze({
    osmId: 1209190794,
    coursePoint: Object.freeze([-11.811, -20.847]) as CoursePointYds,
    teeToGreenCentroidYards: 368.8,
    sourceLatLon: Object.freeze([50.4465687, -116.2473621882353]) as readonly [number, number],
    source: 'preserved Greywolf OSM tee-match artifact',
  }),
  Object.freeze({
    osmId: 1209190793,
    coursePoint: Object.freeze([-21.919, -43.231]) as CoursePointYds,
    teeToGreenCentroidYards: 391.6,
    sourceLatLon: Object.freeze([50.44672972, -116.24717074]) as readonly [number, number],
    source: 'preserved Greywolf OSM tee-match artifact',
  }),
  Object.freeze({
    osmId: 1214871677,
    coursePoint: Object.freeze([-62.851, -161.149]) as CoursePointYds,
    teeToGreenCentroidYards: 512.7,
    sourceLatLon: Object.freeze([50.447600470588235, -116.2463172647059]) as readonly [number, number],
    source: 'preserved Greywolf OSM tee-match artifact',
  }),
])

export type ResolveGreywolfH1TeeOptions = Readonly<{
  /** Maximum absolute gap between an observed GSPro tee-to-pin distance and the candidate's retained tee-to-green-centroid distance. */
  maxResidualYards?: number
  /** Minimum separation between the best and second-best residual. Prevents silently choosing between plausible tees. */
  minWinnerMarginYards?: number
}>

/**
 * Resolve a Hole-1 tee only from an independent observed distance. The package's
 * own selected tee or scorecard yardage is never used as evidence for itself.
 *
 * Green-centroid distance is intentionally only a matching fingerprint. GSPro's
 * live pin can move within the green, so this resolver is conservative: if the
 * pin shift makes two candidates plausible or pushes the best residual outside
 * tolerance, it returns no selection and LiveShotState remains UNKNOWN.
 */
export const resolveGreywolfH1TeeFromObservedDistance = (
  observedDistanceYards: number | null | undefined,
  options: ResolveGreywolfH1TeeOptions = {},
): TeeDistanceResolution => {
  const maxResidualYards = options.maxResidualYards ?? 10
  const minWinnerMarginYards = options.minWinnerMarginYards ?? 8

  if (
    typeof observedDistanceYards !== 'number'
    || !Number.isFinite(observedDistanceYards)
    || observedDistanceYards <= 0
  ) {
    return {
      selection: null,
      candidate: null,
      observedDistanceYards: null,
      bestResidualYards: null,
      secondBestResidualYards: null,
      status: 'NO_OBSERVATION',
      note: 'No trustworthy independent GSPro tee-to-pin distance is available; tee remains unresolved.',
    }
  }

  if (GREYWOLF_H1_TEE_CANDIDATES.length === 0) {
    return {
      selection: null,
      candidate: null,
      observedDistanceYards,
      bestResidualYards: null,
      secondBestResidualYards: null,
      status: 'UNAVAILABLE',
      note: 'Greywolf H1 tee candidates are not packaged.',
    }
  }

  const ranked = GREYWOLF_H1_TEE_CANDIDATES
    .map((candidate) => ({
      candidate,
      residual: Math.abs(observedDistanceYards - candidate.teeToGreenCentroidYards),
    }))
    .sort((left, right) => left.residual - right.residual)

  const best = ranked[0]
  const second = ranked[1] ?? null
  const winnerMargin = second ? second.residual - best.residual : Number.POSITIVE_INFINITY

  if (best.residual > maxResidualYards) {
    return {
      selection: null,
      candidate: best.candidate,
      observedDistanceYards,
      bestResidualYards: best.residual,
      secondBestResidualYards: second?.residual ?? null,
      status: 'NO_MATCH',
      note: `Nearest packaged tee is ${best.residual.toFixed(1)} yd from the observed distance, beyond the ${maxResidualYards.toFixed(1)} yd safety tolerance.`,
    }
  }

  if (winnerMargin < minWinnerMarginYards) {
    return {
      selection: null,
      candidate: best.candidate,
      observedDistanceYards,
      bestResidualYards: best.residual,
      secondBestResidualYards: second?.residual ?? null,
      status: 'AMBIGUOUS',
      note: `Best tee is not uniquely separated: winner margin ${winnerMargin.toFixed(1)} yd is below the ${minWinnerMarginYards.toFixed(1)} yd safety margin.`,
    }
  }

  return {
    selection: {
      label: `Greywolf H1 OSM tee ${best.candidate.osmId}`,
      coursePoint: best.candidate.coursePoint,
      confidence: best.residual <= 5 ? 'high' : 'medium',
    },
    candidate: best.candidate,
    observedDistanceYards,
    bestResidualYards: best.residual,
    secondBestResidualYards: second?.residual ?? null,
    status: 'MATCHED',
    note: `Matched independent ${observedDistanceYards.toFixed(1)} yd observation to OSM tee ${best.candidate.osmId}; residual ${best.residual.toFixed(1)} yd, winner margin ${winnerMargin.toFixed(1)} yd.`,
  }
}
