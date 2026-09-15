import { GREYWOLF_COURSE_ID } from './courseCatalog'
import { loadCourseHoleGeometry } from './courseProvider'
import type { CourseHoleGeometry } from './types'

/**
 * Compatibility wrapper for existing Greywolf call sites.
 *
 * New code should call loadCourseHoleGeometry(courseId, holeNumber) directly.
 * Keeping this export means Aim Lab / Live Caddie and older dev surfaces still
 * flow through the same canonical provider rather than a parallel loader path.
 */
export const loadGreywolfHoleGeometry = (holeNumber: number): Promise<CourseHoleGeometry> =>
  loadCourseHoleGeometry(GREYWOLF_COURSE_ID, holeNumber)
