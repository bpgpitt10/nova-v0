import { readLooperCompanionCourseLibrary } from '../adapters/looperCompanion'
import {
  courseGsproAliases,
  courseRegistry,
  registerRuntimeCourses,
  resolveCourseIdFromGsproName,
  type CourseCatalogEntry,
} from './courseCatalog'
import { gsproOnlyCatalogEntry, gsproOnlyCourseKey, type GsproInstalledCourse } from './gsproOnlyCourse'
import { installedCourseCandidates } from './nativeCourseRuntime'

/**
 * The GSPro-only entries in the course catalog: one per course installed in
 * GSPro on this PC (from the companion's course list), so any of them can be
 * picked in Start a Round and played in Live Caddie with no map loaded.
 *
 * A course with a loaded map keeps using the map; its GSPro-only entry is
 * hidden from the picker (gsproOnlyLoadedMatch). The list is cached on this
 * browser so a GSPro-only round survives a reload before the companion answers.
 */

const CACHE_KEY = 'looper.gspro-only-courses.v1'

const valid = (row: unknown): row is GsproInstalledCourse => {
  const r = row as Partial<GsproInstalledCourse> | null
  return Boolean(r && typeof r.courseKey === 'string' && r.courseKey.trim() && typeof r.courseName === 'string')
}

const apply = (rows: readonly GsproInstalledCourse[]) => registerRuntimeCourses(rows.map(gsproOnlyCatalogEntry))

/** Add every course installed in GSPro (the companion's list) as a GSPro-only entry. */
export const refreshGsproOnlyCourses = async (): Promise<number> => {
  const library = await readLooperCompanionCourseLibrary(8000)
  const rows: GsproInstalledCourse[] = library.courses
    .filter((course) => course.courseKey && (course.holes ?? 18) > 0)
    .map((course) => ({
      courseKey: course.courseKey,
      courseName: course.courseName,
      location: course.location,
      altitude: typeof course.altitude === 'number' ? course.altitude : null,
    }))
  const added = apply(rows)
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(rows))
  } catch {
    // memory copy is enough
  }
  return added
}

/**
 * The loaded course (map + terrain) for a GSPro-only entry, if there is one:
 * by GSPro alias or a link made on the Load page, then by name the way the
 * native runtime pairs installed courses with loaded ones.
 */
export const gsproOnlyLoadedMatch = (entry: Pick<CourseCatalogEntry, 'id' | 'name'>): string | null => {
  const key = gsproOnlyCourseKey(entry.id)
  if (!key) return null
  const byAlias = resolveCourseIdFromGsproName(key, { includeGsproOnly: false })
    ?? resolveCourseIdFromGsproName(entry.name, { includeGsproOnly: false })
  if (byAlias) return byAlias
  for (const loaded of courseRegistry) {
    if (loaded.source === 'gspro-only' || loaded.packageStatus !== 'ready') continue
    if (installedCourseCandidates([loaded.name, ...courseGsproAliases(loaded)], [{ courseKey: key, courseName: entry.name }]).length) {
      return loaded.id
    }
  }
  return null
}

// Cached copy first (before any page renders).
try {
  const raw = typeof window !== 'undefined' ? window.localStorage.getItem(CACHE_KEY) : null
  const parsed = raw ? JSON.parse(raw) as unknown : null
  if (Array.isArray(parsed)) apply(parsed.filter(valid))
} catch {
  // no cache
}
