import type { RoundTeeSelection } from './roundTeeSelection.ts'
import {
  loadTeeCalibration,
  saveTeeCalibrationCandidate,
  type TeeCalibrationRecord,
} from './teeCalibrationStore.ts'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseTeeCandidate,
} from './types.ts'

export type ShotOneTeeResolution = Readonly<{
  point: CoursePointYds
  source: 'locked-calibration' | 'osm-tee-candidate' | 'fallback-marker'
  candidate: CourseTeeCandidate | null
  calibration: TeeCalibrationRecord | null
  reason: string
}>

const normalize = (value: string | null | undefined) =>
  value?.trim().replace(/\s+/g, ' ').toLowerCase() ?? ''

export const courseGeometryFingerprint = (geometry: CourseHoleGeometry) => {
  const version = geometry.provenance.sourceBaseTimestamp
    ?? geometry.provenance.fetchedAt
    ?? geometry.provenance.geometrySource
  return `${geometry.courseId}::${version}`
}

const matchValues = (candidate: CourseTeeCandidate) => new Set([
  candidate.teeSet,
  ...(candidate.teeAliases ?? []),
  candidate.color,
  candidate.label,
  candidate.name,
  candidate.ref,
].map(normalize).filter(Boolean))

export const matchingTeeCandidates = (
  geometry: CourseHoleGeometry,
  teeSet: string,
): readonly CourseTeeCandidate[] => {
  const wanted = normalize(teeSet)
  if (!wanted) return []
  return (geometry.teeCandidates ?? []).filter((candidate) => matchValues(candidate).has(wanted))
}

const fallback = (
  geometry: CourseHoleGeometry,
  calibration: TeeCalibrationRecord | null,
  reason: string,
): ShotOneTeeResolution => ({
  point: geometry.markers.tee,
  source: 'fallback-marker',
  candidate: null,
  calibration,
  reason,
})

export const resolveShotOneTee = (
  geometry: CourseHoleGeometry,
  selection: RoundTeeSelection | null,
): ShotOneTeeResolution => {
  if (!selection || selection.courseId !== geometry.courseId) {
    return fallback(geometry, null, 'No round tee selection is available for this course.')
  }

  const fingerprint = courseGeometryFingerprint(geometry)
  const calibration = loadTeeCalibration(
    fingerprint,
    geometry.holeNumber,
    selection.normalizedTeeSet,
  )

  if (calibration?.status === 'locked') {
    return {
      point: calibration.courseLocalYds,
      source: 'locked-calibration',
      candidate: null,
      calibration,
      reason: `Using locked ${selection.teeSet} tee calibration.`,
    }
  }

  const matches = matchingTeeCandidates(geometry, selection.normalizedTeeSet)
  if (matches.length === 0) {
    return fallback(
      geometry,
      calibration,
      `No OSM/inferred tee candidate matched ${selection.teeSet}; keeping the package tee marker.`,
    )
  }
  if (matches.length > 1) {
    return fallback(
      geometry,
      calibration,
      `${matches.length} tee candidates matched ${selection.teeSet}; refusing to guess.`,
    )
  }

  const candidate = matches[0]
  const write = saveTeeCalibrationCandidate({
    courseFingerprint: fingerprint,
    holeNumber: geometry.holeNumber,
    teeSet: selection.normalizedTeeSet,
    teeLabel: selection.teeSet,
    osmTeeId: candidate.osmId,
    courseLocalYds: candidate.coursePoint,
    expectedYardageYds: candidate.teeToGreenCentroidYards,
    confidence: 0.6,
    confirmationMethod: candidate.teeAliases?.some((alias) => normalize(alias) === selection.normalizedTeeSet)
      ? 'user-tee-set-plus-scorecard-distance-assumption'
      : 'user-tee-set-plus-osm-exact-match',
  })

  if (write.outcome === 'locked-conflict') {
    return {
      point: write.record.courseLocalYds,
      source: 'locked-calibration',
      candidate: null,
      calibration: write.record,
      reason: `Assumed ${selection.teeSet} tee conflicts with the locked calibration; preserving the locked tee.`,
    }
  }

  if (write.outcome === 'invalid') {
    return fallback(geometry, calibration, `Tee calibration candidate was invalid: ${write.reason}`)
  }

  return {
    point: candidate.coursePoint,
    source: 'osm-tee-candidate',
    candidate,
    calibration: write.record,
    reason: `Mapped ${selection.teeSet} to one tee candidate; GSPro completed shots will validate the assumption.`,
  }
}
