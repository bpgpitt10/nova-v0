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
  source: 'gspro-gkd' | 'locked-calibration' | 'osm-tee-candidate' | 'fallback-marker'
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

const lockedResolution = (
  calibration: TeeCalibrationRecord,
  reason: string,
): ShotOneTeeResolution => ({
  point: calibration.courseLocalYds,
  source: 'locked-calibration',
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

  const matches = matchingTeeCandidates(geometry, selection.normalizedTeeSet)
  const gkdMatches = matches.filter((candidate) => candidate.source === 'gspro-gkd')

  if (gkdMatches.length > 1) {
    if (calibration?.status === 'locked') {
      return lockedResolution(
        calibration,
        `${gkdMatches.length} GSPro .GKD starts matched ${selection.teeSet}; preserving the locked calibration rather than guessing.`,
      )
    }
    return fallback(
      geometry,
      calibration,
      `${gkdMatches.length} GSPro .GKD starts matched ${selection.teeSet}; refusing to guess.`,
    )
  }

  if (gkdMatches.length === 1) {
    const candidate = gkdMatches[0]
    const write = saveTeeCalibrationCandidate({
      courseFingerprint: fingerprint,
      holeNumber: geometry.holeNumber,
      teeSet: selection.normalizedTeeSet,
      teeLabel: selection.teeSet,
      osmTeeId: candidate.osmId,
      courseLocalYds: candidate.coursePoint,
      gsproWorld: candidate.gsproWorld,
      confidence: 1,
      confirmationMethod: 'gspro-gkd-tee-position',
    })

    return {
      point: candidate.coursePoint,
      source: 'gspro-gkd',
      candidate,
      calibration: write.outcome === 'invalid' ? calibration : write.record,
      reason: write.outcome === 'locked-conflict'
        ? `Using authoritative GSPro .GKD ${selection.teeSet} start despite a conflicting locked calibration.`
        : candidate.osmId != null
          ? `Using GSPro .GKD ${selection.teeSet} start with matched OSM tee enrichment.`
          : `Using GSPro .GKD ${selection.teeSet} start; no OSM tee is required.`,
    }
  }

  if (calibration?.status === 'locked') {
    return lockedResolution(calibration, `Using locked ${selection.teeSet} tee calibration.`)
  }

  const osmMatches = matches.filter((candidate) => candidate.source !== 'gspro-gkd')
  if (osmMatches.length === 0) {
    return fallback(
      geometry,
      calibration,
      `No GSPro .GKD start or OSM tee candidate matched ${selection.teeSet}; keeping the package tee marker.`,
    )
  }
  if (osmMatches.length > 1) {
    return fallback(
      geometry,
      calibration,
      `${osmMatches.length} OSM tee candidates matched ${selection.teeSet}; refusing to guess.`,
    )
  }

  const candidate = osmMatches[0]
  const write = saveTeeCalibrationCandidate({
    courseFingerprint: fingerprint,
    holeNumber: geometry.holeNumber,
    teeSet: selection.normalizedTeeSet,
    teeLabel: selection.teeSet,
    osmTeeId: candidate.osmId,
    courseLocalYds: candidate.coursePoint,
    expectedYardageYds: candidate.teeToGreenCentroidYards,
    confidence: 0.75,
    confirmationMethod: 'user-tee-set-plus-osm-exact-match',
  })

  if (write.outcome === 'locked-conflict') {
    return lockedResolution(
      write.record,
      `OSM ${selection.teeSet} tee conflicts with the locked calibration; preserving the locked tee.`,
    )
  }

  if (write.outcome === 'invalid') {
    return fallback(geometry, calibration, `Tee calibration candidate was invalid: ${write.reason}`)
  }

  return {
    point: candidate.coursePoint,
    source: 'osm-tee-candidate',
    candidate,
    calibration: write.record,
    reason: `Matched ${selection.teeSet} to one OSM tee candidate.`,
  }
}
