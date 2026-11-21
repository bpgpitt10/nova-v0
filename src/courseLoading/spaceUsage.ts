import { getSupabaseClient } from '../cloud/supabaseClient'

/**
 * How full the Supabase project is, for /admin/courses. The limits are the Free plan's
 * (Brian's org, 21 Nov 2026): 500 MB of database and 1 GB of file storage. Change them here
 * if the plan changes.
 */
export const SPACE_LIMITS = { databaseBytes: 500 * 1024 ** 2, fileBytes: 1024 ** 3, plan: 'Free plan' } as const

export type SpaceUsage = {
  database_bytes: number
  file_bytes: number
  course_file_bytes: number
  full_courses: number
  area_courses: number
  shot_rows: number
  shot_bytes: number
}

export const loadSpaceUsage = async (): Promise<SpaceUsage | null> => {
  const client = await getSupabaseClient()
  const { data, error } = await client.rpc<SpaceUsage[]>('admin_space_usage')
  if (error) throw new Error(/admins only/i.test(error.message) ? 'This Looper account is not an admin.' : error.message)
  const row = data?.[0]
  if (!row) return null
  // bigint columns can arrive as strings.
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as SpaceUsage
}

export const megabytes = (bytes: number) => {
  const mb = bytes / 1024 ** 2
  return mb >= 1000 ? `${(mb / 1024).toFixed(2)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** How many more courses fit in the file space left, at the average size so far. */
export const coursesLeft = (usage: SpaceUsage) => {
  const courses = usage.full_courses + usage.area_courses
  if (courses === 0 || usage.course_file_bytes === 0) return null
  return Math.floor((SPACE_LIMITS.fileBytes - usage.file_bytes) / (usage.course_file_bytes / courses))
}

/** How many more shots fit in the database left, at the bytes per shot so far (lineage and putts included). */
export const shotsLeft = (usage: SpaceUsage) => {
  if (usage.shot_rows === 0) return null
  return Math.floor((SPACE_LIMITS.databaseBytes - usage.database_bytes) / (usage.shot_bytes / usage.shot_rows))
}
