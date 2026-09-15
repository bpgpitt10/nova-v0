import {
  isCourseId,
  type CourseId,
} from './courseCatalog'

const LAST_SELECTED_COURSE_STORAGE_KEY = 'looper.course-selection.last.v1'

export const loadLastSelectedCourseId = (): CourseId | null => {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(LAST_SELECTED_COURSE_STORAGE_KEY)
    return isCourseId(stored) ? stored : null
  } catch {
    return null
  }
}

export const saveLastSelectedCourseId = (courseId: CourseId) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LAST_SELECTED_COURSE_STORAGE_KEY, courseId)
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}
