import { registerRuntimeCourses, type CourseCatalogEntry } from './courseCatalog'

/**
 * Courses the one-click loader published at run time (Supabase
 * `loaded_courses`, package files in the public `course-packages` bucket).
 * A cached copy is applied as soon as this module loads, so a course loaded
 * yesterday is in the catalog before the first page renders; the app then
 * refreshes from Supabase (courseLoads.refreshLoadedCourses).
 */
export type LoadedCourseRow = Readonly<{
  slug: string
  course_id: string
  name: string
  location: string | null
  gspro_aliases: readonly string[] | null
  package_url: string
  lidar: boolean | null
  hole_headings: readonly (number | null)[] | null
}>

const CACHE_KEY = 'looper.loaded-courses.v1'

const validRow = (row: unknown): row is LoadedCourseRow => {
  const r = row as Partial<LoadedCourseRow> | null
  return Boolean(r && typeof r.slug === 'string' && typeof r.course_id === 'string' && typeof r.name === 'string'
    && typeof r.package_url === 'string' && /^https:\/\//.test(r.package_url))
}

export const runtimeEntryFromRow = (row: LoadedCourseRow): CourseCatalogEntry & { holeHeadings: readonly (number | null)[] | null } => ({
  id: row.course_id,
  name: row.name,
  location: row.location ?? '',
  slug: row.slug,
  gsproAliases: [...new Set([row.name, ...(row.gspro_aliases ?? [])].map((alias) => alias.trim()).filter(Boolean))],
  staticPackageUrl: row.package_url,
  status: 'validated',
  packageStatus: 'ready',
  packageVersion: 'v1',
  packageCacheStatus: 'cached',
  osmCacheStatus: 'cached',
  lidarCacheStatus: row.lidar ? 'cached' : 'unknown',
  holeHeadings: Array.isArray(row.hole_headings) ? row.hole_headings : null,
})

/** Add these rows to the catalog and remember them for the next start. */
export const applyLoadedCourseRows = (rows: readonly unknown[]): number => {
  const valid = rows.filter(validRow)
  const added = registerRuntimeCourses(valid.map(runtimeEntryFromRow))
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(valid))
  } catch {
    // memory copy is enough
  }
  return added
}

// Cached copy first (before any page renders).
try {
  const raw = typeof window !== 'undefined' ? window.localStorage.getItem(CACHE_KEY) : null
  const parsed = raw ? JSON.parse(raw) as unknown : null
  if (Array.isArray(parsed)) registerRuntimeCourses(parsed.filter(validRow).map(runtimeEntryFromRow))
} catch {
  // no cache
}
