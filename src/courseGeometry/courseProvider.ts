import {
  GREYWOLF_COURSE_ID,
  TOBACCO_ROAD_COURSE_ID,
  UNSELECTED_COURSE_ID,
  getCourseCatalogEntry,
  type CourseId,
} from './courseCatalog'
import { loadGreywolfHoleGeometryAdapter } from './greywolfCourseAdapter'
import { loadGsproTeeStarts } from './gsproTeeStartProvider'
import { normalizeRouteCourseGeometry } from './normalizeRouteCourseGeometry'
import { loadPackagedCourseHoleGeometry } from './packagedCourseLoader'
import { loadRoundTeeSelection } from './roundTeeSelection'
import { loadRoutePackagedCourseHoleGeometry } from './routePackagedCourseLoader'
import { resolveShotOneTee } from './shotOneTeeResolver'
import { loadCourseTeeCandidates } from './teeCandidateProvider'
import type { CourseHoleGeometry } from './types'

const withShotOneTee = async (
  courseId: CourseId,
  holeNumber: number,
  geometry: CourseHoleGeometry,
): Promise<CourseHoleGeometry> => {
  let teeCandidates = geometry.teeCandidates ?? []
  try {
    teeCandidates = await loadCourseTeeCandidates(courseId, holeNumber)
  } catch (error) {
    console.warn('[Course geometry] tee-candidate sidecar could not be loaded; keeping package tee marker.', error)
  }

  try {
    const gsproTeeStarts = await loadGsproTeeStarts(courseId, holeNumber)
    if (gsproTeeStarts.length > 0) {
      teeCandidates = [...gsproTeeStarts, ...teeCandidates]
    }
  } catch (error) {
    console.warn('[Course geometry] GSPro tee-start sidecar could not be loaded; using other tee evidence.', error)
  }

  const enriched = teeCandidates.length > 0
    ? { ...geometry, teeCandidates }
    : geometry
  const selection = loadRoundTeeSelection(courseId)
  const resolution = resolveShotOneTee(enriched, selection)

  return {
    ...enriched,
    markers: {
      ...enriched.markers,
      tee: resolution.point,
    },
  }
}

/**
 * Canonical runtime entry point for static course geometry.
 *
 * Greywolf remains the proven compatibility control. Every other packaged
 * route course is normalized to the selected-tee runtime contract before any
 * UI or decision logic consumes it. Tobacco Road still uses the older package
 * schema, but it goes through the same normalization when tee evidence exists.
 *
 * Shot 1 then applies the persisted round tee selection conservatively. A
 * unique GSPro .GKD tee start is authoritative when packaged; otherwise a
 * locked calibration wins, then exactly one matching OSM tee candidate. Missing
 * or ambiguous evidence leaves the package tee marker untouched.
 */
export const loadCourseHoleGeometry = (
  courseId: CourseId,
  holeNumber: number,
): Promise<CourseHoleGeometry> => {
  if (courseId === UNSELECTED_COURSE_ID) {
    return Promise.reject(new Error('Choose a course before loading hole geometry.'))
  }
  getCourseCatalogEntry(courseId)
  if (courseId === GREYWOLF_COURSE_ID) {
    return loadGreywolfHoleGeometryAdapter(holeNumber)
      .then((geometry) => withShotOneTee(courseId, holeNumber, geometry))
  }
  if (courseId === TOBACCO_ROAD_COURSE_ID) {
    return loadPackagedCourseHoleGeometry(courseId, holeNumber)
      .then(normalizeRouteCourseGeometry)
      .then((geometry) => withShotOneTee(courseId, holeNumber, geometry))
  }
  return loadRoutePackagedCourseHoleGeometry(courseId, holeNumber)
    .then(normalizeRouteCourseGeometry)
    .then((geometry) => withShotOneTee(courseId, holeNumber, geometry))
}
