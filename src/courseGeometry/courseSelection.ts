import {
  UNSELECTED_COURSE_ID,
  isCourseId,
  type CourseId,
} from './courseCatalog'

const LAST_SELECTED_COURSE_STORAGE_KEY = 'looper.course-selection.last.v1'
export const COURSE_SELECTION_UPDATED_EVENT = 'looper:course-selection-updated'

export const loadLastSelectedCourseId = (): CourseId => {
  if (typeof window === 'undefined') return UNSELECTED_COURSE_ID
  try {
    const stored = window.localStorage.getItem(LAST_SELECTED_COURSE_STORAGE_KEY)
    return isCourseId(stored) ? stored : UNSELECTED_COURSE_ID
  } catch {
    return UNSELECTED_COURSE_ID
  }
}

export const saveLastSelectedCourseId = (courseId: CourseId) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LAST_SELECTED_COURSE_STORAGE_KEY, courseId)
    window.dispatchEvent(new CustomEvent(COURSE_SELECTION_UPDATED_EVENT, {
      detail: { courseId },
    }))
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}
