import {
  GREYWOLF_COURSE_ID,
  TOBACCO_ROAD_COURSE_ID,
  UNSELECTED_COURSE_ID,
  getCourseCatalogEntry,
  type CourseId,
} from './courseCatalog'
import { loadGreywolfHoleGeometryAdapter } from './greywolfCourseAdapter'
import { normalizeRouteCourseGeometry } from './normalizeRouteCourseGeometry'
import { loadPackagedCourseHoleGeometry } from './packagedCourseLoader'
import { loadRoutePackagedCourseHoleGeometry } from './routePackagedCourseLoader'
import type { CourseHoleGeometry } from './types'

/**
 * Canonical runtime entry point for static course geometry.
 *
 * Greywolf remains the proven compatibility control. Tobacco Road still uses
 * the earlier generic package shape. Courses produced by the automated
 * OSM-route importer are normalized to the same selected-tee runtime contract
 * before any UI or decision logic consumes them.
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
  }
  if (courseId === TOBACCO_ROAD_COURSE_ID) {
    return loadPackagedCourseHoleGeometry(courseId, holeNumber)
  }
  return loadRoutePackagedCourseHoleGeometry(courseId, holeNumber)
    .then(normalizeRouteCourseGeometry)
}
