import {
  GREYWOLF_COURSE_ID,
  getCourseCatalogEntry,
  type CourseId,
} from './courseCatalog'
import { loadGreywolfHoleGeometryAdapter } from './greywolfCourseAdapter'
import { loadPackagedCourseHoleGeometry } from './packagedCourseLoader'
import type { CourseHoleGeometry } from './types'

/**
 * Canonical runtime entry point for static course geometry.
 *
 * Downstream renderers and strategy code should depend on this provider rather
 * than on course-specific loaders. Greywolf remains a compatibility adapter
 * while its proven V1 assets are frozen; new courses use the generic cached
 * package contract.
 */
export const loadCourseHoleGeometry = (
  courseId: CourseId,
  holeNumber: number,
): Promise<CourseHoleGeometry> => {
  getCourseCatalogEntry(courseId)
  if (courseId === GREYWOLF_COURSE_ID) {
    return loadGreywolfHoleGeometryAdapter(holeNumber)
  }
  return loadPackagedCourseHoleGeometry(courseId, holeNumber)
}
