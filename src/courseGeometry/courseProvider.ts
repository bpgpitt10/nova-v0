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
 * Greywolf remains the proven compatibility control. Every other packaged
 * route course is normalized to the selected-tee runtime contract before any
 * UI or decision logic consumes it. Tobacco Road still uses the older package
 * schema, but it goes through the same normalization when tee evidence exists.
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
      .then(normalizeRouteCourseGeometry)
  }
  return loadRoutePackagedCourseHoleGeometry(courseId, holeNumber)
    .then(normalizeRouteCourseGeometry)
}
