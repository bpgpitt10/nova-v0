/**
 * Which GSPro courses players have installed, most-installed first, and what
 * loading each one would take (admin page /admin/courses).
 *
 * Counts only: the database function admin_course_installs() returns how many
 * players have each course, never who. Nobody publishes GSPro play counts, so
 * this is Looper's own popularity signal for what to load next.
 */
import { getSupabaseClient } from '../cloud/supabaseClient'

export type CourseInstallRow = Readonly<{
  course_key: string
  course_name: string | null
  location: string | null
  players: number
  crosswalk_status: string | null
  lat: number | null
  lon: number | null
  osm_type: string | null
  osm_id: number | null
}>

export type CourseInstallStatus =
  | 'loaded' // in Looper already (built in, loaded, or a map area)
  | 'loading' // a load is queued or running
  | 'ready' // a real course with its outline known: one click
  | 'pick' // a real course, but the outline match needs a look (Load page)
  | 'fictional' // no real place to map; plays from the GSPro file alone
  | 'no-map' // real, but nobody has mapped it yet
  | 'range' // a practice range, not a course

export type CourseInstall = CourseInstallRow & Readonly<{ status: CourseInstallStatus; name: string }>

const RANGE_RE = /\b(range|practice area|practice green|putting green)\b/i
/** 'GSProRange22' and 'gspro_range_legacy' read as words, so 'range' matches them but not 'Orange'. */
const asWords = (text: string) => text.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\d-]+/g, ' ')
const isRange = (text: string) => RANGE_RE.test(asWords(text))

export const classifyCourseInstalls = (
  rows: readonly CourseInstallRow[],
  isLoaded: (courseKey: string, courseName: string | null) => boolean,
  loadingKeys: ReadonlySet<string> = new Set(),
): CourseInstall[] => rows.map((row) => {
  const name = row.course_name?.trim() || row.course_key
  const status: CourseInstallStatus = isRange(name) || isRange(row.course_key)
    ? 'range'
    : isLoaded(row.course_key, row.course_name)
      ? 'loaded'
      : loadingKeys.has(row.course_key.toLowerCase())
        ? 'loading'
        : row.crosswalk_status === 'fictional'
          ? 'fictional'
          : row.crosswalk_status === 'no-map'
            ? 'no-map'
            : row.crosswalk_status === 'matched' && row.lat != null && row.lon != null && row.osm_id
              ? 'ready'
              : 'pick'
  return { ...row, name, status }
})

const ORDER: Record<CourseInstallStatus, number> = { ready: 0, pick: 1, loading: 2, 'no-map': 3, fictional: 4, loaded: 5, range: 6 }

/** Most players first; within a count, what can be loaded first. */
export const sortCourseInstalls = (rows: readonly CourseInstall[]): CourseInstall[] =>
  [...rows].sort((a, b) => b.players - a.players || ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name))

export const listCourseInstallsForAdmin = async (): Promise<CourseInstallRow[]> => {
  const client = await getSupabaseClient()
  const { data, error } = await client.rpc<CourseInstallRow[]>('admin_course_installs')
  if (error) throw new Error(/admins only/i.test(error.message) ? 'This Looper account is not an admin.' : error.message)
  return data ?? []
}
