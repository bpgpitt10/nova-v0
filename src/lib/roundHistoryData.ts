import {
  getCurrentLooperUser,
  getSupabaseClient,
  isSupabaseConfigured,
} from '../cloud/supabaseClient'
import { readLooperCompanionCourseLibrary } from '../adapters/looperCompanion'
import { courseRegistry, resolveCourseIdFromGsproName } from '../courseGeometry/courseCatalog'
import { companionSceneLayouts } from '../courseGeometry/nativeCourseRuntime'
import { getActiveBagClubIds } from './bagConfig'
import { buildYardageBook } from './bagYardageBook'
import { getActiveLocalUserId } from './localUserScope'
import { loadLiveGsproRoundArchive } from './liveGsproRoundArchive'
import {
  recordFromArchivedShot,
  recordFromCloudRow,
  type CourseInfo,
  type LiveCourseShotRow,
  type RoundFlags,
  type RoundShotRecord,
} from './roundHistory'
import { isSessionEligibleForAnalysis, loadSavedSessions } from './sessions'

/**
 * Where round pages get their data: every captured shot from Supabase (all
 * devices), plus anything still only in this browser's local archive; course
 * names and pars from the GSPro course file (via the companion) or a loaded
 * course package; per-round flags such as auto putt.
 */

const COURSE_INFO_STORAGE_KEY = 'looper-round-course-info-v1'
const ROUND_FLAGS_STORAGE_KEY = 'looper-round-flags-v1'
const ROUNDS_PER_QUERY = 8

type AwaitableResult<T> = { data: T | null; error: { message: string } | null }

const awaitQuery = async <T>(query: unknown): Promise<T> => {
  const result = await (query as Promise<AwaitableResult<T>>)
  if (result.error) throw new Error(result.error.message)
  return (result.data ?? []) as T
}

const SHOT_COLUMNS = [
  'gspro_round_id', 'course_key', 'hole_number', 'hole_shot', 'observed_at',
  'starting_surface_raw', 'ending_surface_raw', 'distance_to_pin_yards',
  'carry_yards', 'total_yards', 'spin_axis_degrees', 'gspro_club_index',
  'raw_metrics', 'actual_club', 'club_source', 'inferred_club',
  'inference_confidence', 'recommended_club',
].join(',')

export type RoundRecordsResult = {
  records: RoundShotRecord[]
  source: 'cloud' | 'cloud+local' | 'local'
  cloudError: string | null
}

const loadCloudRecords = async (): Promise<RoundShotRecord[] | null> => {
  if (!isSupabaseConfigured()) return null
  const user = await getCurrentLooperUser()
  if (!user) return null
  const client = await getSupabaseClient()
  const rounds = await awaitQuery<Array<{ gspro_round_id: number }>>(
    client
      .from<Array<{ gspro_round_id: number }>>('live_course_rounds')
      .select('gspro_round_id')
      .eq('user_id', user.id),
  )
  const ids = [...new Set(rounds.map((row) => row.gspro_round_id))]
  const records: RoundShotRecord[] = []
  // One query per few rounds keeps each response well under the API row cap.
  for (let start = 0; start < ids.length; start += ROUNDS_PER_QUERY) {
    const chunk = ids.slice(start, start + ROUNDS_PER_QUERY)
    const rows = await awaitQuery<LiveCourseShotRow[]>(
      client
        .from<LiveCourseShotRow[]>('live_course_shots')
        .select(SHOT_COLUMNS)
        .eq('user_id', user.id)
        .in('gspro_round_id', chunk),
    )
    rows.forEach((row) => records.push(recordFromCloudRow(row)))
  }
  return records
}

const loadLocalRecords = (): RoundShotRecord[] =>
  loadLiveGsproRoundArchive().rounds.flatMap((round) =>
    round.shots.map((shot) => recordFromArchivedShot(shot)),
  )

export const loadRoundRecords = async (): Promise<RoundRecordsResult> => {
  const local = loadLocalRecords()
  let cloud: RoundShotRecord[] | null = null
  let cloudError: string | null = null
  try {
    cloud = await loadCloudRecords()
  } catch (error) {
    cloudError = error instanceof Error ? error.message : 'Could not load rounds.'
  }
  if (!cloud) return { records: local, source: 'local', cloudError }

  // Rounds the cloud doesn't have yet (or has fewer shots of) come from this browser.
  const cloudCounts = new Map<number, number>()
  cloud.forEach((record) => cloudCounts.set(record.roundId, (cloudCounts.get(record.roundId) ?? 0) + 1))
  const localCounts = new Map<number, number>()
  local.forEach((record) => localCounts.set(record.roundId, (localCounts.get(record.roundId) ?? 0) + 1))
  const preferLocal = new Set(
    [...localCounts.entries()]
      .filter(([roundId, count]) => count > (cloudCounts.get(roundId) ?? 0))
      .map(([roundId]) => roundId),
  )
  const merged = [
    ...cloud.filter((record) => !preferLocal.has(record.roundId)),
    ...local.filter((record) => preferLocal.has(record.roundId)),
  ]
  return { records: merged, source: preferLocal.size > 0 ? 'cloud+local' : 'cloud', cloudError }
}

// ---- course names and pars --------------------------------------------------

export type StoredCourseInfo = {
  name: string | null
  pars: Record<number, number>
  parSource: 'course-file' | 'course-package' | null
}

const readCourseCache = (): Record<string, StoredCourseInfo> => {
  try {
    const raw = window.localStorage.getItem(COURSE_INFO_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, StoredCourseInfo>) : {}
  } catch {
    return {}
  }
}

const writeCourseCache = (cache: Record<string, StoredCourseInfo>) => {
  try {
    window.localStorage.setItem(COURSE_INFO_STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Storage full or blocked: pars are re-read next time.
  }
}

const parsFromPackage = async (courseKey: string): Promise<StoredCourseInfo | null> => {
  const courseId = resolveCourseIdFromGsproName(courseKey)
  if (!courseId) return null
  const entry = courseRegistry.find((candidate) => candidate.id === courseId)
  const url = entry && 'staticPackageUrl' in entry ? entry.staticPackageUrl : null
  if (!entry || !url) return { name: entry?.name ?? null, pars: {}, parSource: null }
  const response = await fetch(url)
  if (!response.ok) return { name: entry.name, pars: {}, parSource: null }
  const data = (await response.json()) as { holes?: Record<string, { par?: number }> }
  const pars: Record<number, number> = {}
  Object.entries(data.holes ?? {}).forEach(([hole, value]) => {
    if (typeof value?.par === 'number') pars[Number(hole)] = value.par
  })
  return { name: entry.name, pars, parSource: Object.keys(pars).length > 0 ? 'course-package' : null }
}

const parsFromCourseFile = async (courseKey: string): Promise<StoredCourseInfo | null> => {
  const layouts = await companionSceneLayouts(courseKey)
  const main = layouts?.find((entry) => entry.file.kind === 'main') ?? layouts?.[0]
  if (!main) return null
  const pars: Record<number, number> = {}
  main.layout.holes.forEach((hole) => {
    if (typeof hole.par === 'number') pars[hole.hole] = hole.par
  })
  return {
    name: main.layout.courseName,
    pars,
    parSource: Object.keys(pars).length > 0 ? 'course-file' : null,
  }
}

type CourseInfoRow = {
  course_key: string
  course_name: string | null
  pars: Record<string, number> | null
  par_source: string | null
}

const sourceRank = (source: StoredCourseInfo['parSource']) =>
  source === 'course-file' ? 2 : source === 'course-package' ? 1 : 0

const storedFromRow = (row: CourseInfoRow): StoredCourseInfo => {
  const pars: Record<number, number> = {}
  Object.entries(row.pars ?? {}).forEach(([hole, par]) => {
    if (typeof par === 'number' && Number.isFinite(par)) pars[Number(hole)] = par
  })
  const parSource = row.par_source === 'course-file' || row.par_source === 'course-package' ? row.par_source : null
  return { name: row.course_name, pars, parSource }
}

/** Better of two records: a stronger par source wins; a name is never lost. */
const mergeInfo = (a: StoredCourseInfo | undefined, b: StoredCourseInfo | undefined): StoredCourseInfo | undefined => {
  if (!a) return b
  if (!b) return a
  const winner = sourceRank(b.parSource) > sourceRank(a.parSource) ? b : a
  const other = winner === a ? b : a
  return {
    name: winner.name ?? other.name,
    pars: Object.keys(winner.pars).length > 0 ? winner.pars : other.pars,
    parSource: winner.parSource ?? other.parSource,
  }
}

const sameInfo = (a: StoredCourseInfo | undefined, b: StoredCourseInfo | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Course info saved to the player's account, so every device sees it. */
const loadCloudCourseInfo = async (): Promise<{ userId: string; rows: Record<string, StoredCourseInfo> } | null> => {
  if (!isSupabaseConfigured()) return null
  const user = await getCurrentLooperUser()
  if (!user) return null
  const client = await getSupabaseClient()
  const rows = await awaitQuery<CourseInfoRow[]>(
    client
      .from<CourseInfoRow[]>('live_course_info')
      .select('course_key,course_name,pars,par_source')
      .eq('user_id', user.id),
  )
  return { userId: user.id, rows: Object.fromEntries(rows.map((row) => [row.course_key, storedFromRow(row)])) }
}

const saveCloudCourseInfo = async (userId: string, entries: Record<string, StoredCourseInfo>) => {
  const values = Object.entries(entries).map(([courseKey, info]) => ({
    user_id: userId,
    course_key: courseKey,
    course_name: info.name,
    pars: Object.fromEntries(Object.entries(info.pars).map(([hole, par]) => [String(hole), par])),
    par_source: info.parSource,
    updated_at: new Date().toISOString(),
  }))
  if (values.length === 0) return
  const client = await getSupabaseClient()
  const result = await client.from<unknown>('live_course_info').upsert(values, { onConflict: 'user_id,course_key' })
  if (result.error) throw new Error(result.error.message)
}

/**
 * Course name and par per hole. The GSPro course file (read by the companion
 * on the sim PC) wins; a loaded course package is next; the companion's course
 * list can still supply a name. Whatever a device works out is saved to the
 * player's account (live_course_info), so a MacBook or phone shows the same
 * names and pars the sim PC found.
 */
export const loadCourseInfo = async (
  courseKeys: readonly string[],
): Promise<Record<string, StoredCourseInfo>> => {
  const cache = readCourseCache()
  const keys = [...new Set(courseKeys.filter((key) => key && !/range/i.test(key)))]

  let cloud: Awaited<ReturnType<typeof loadCloudCourseInfo>> = null
  try {
    cloud = await loadCloudCourseInfo()
  } catch {
    cloud = null
  }
  const before: Record<string, StoredCourseInfo | undefined> = {}
  keys.forEach((key) => {
    before[key] = cloud?.rows[key]
    const merged = mergeInfo(cache[key], cloud?.rows[key])
    if (merged) cache[key] = merged
  })

  await Promise.all(keys.map(async (key) => {
    const cached = cache[key]
    if (cached?.parSource === 'course-file' && cached.name) return
    const [fromFile, fromPackage] = await Promise.all([
      parsFromCourseFile(key).catch(() => null),
      cached?.parSource === 'course-package' ? Promise.resolve(null) : parsFromPackage(key).catch(() => null),
    ])
    const merged = mergeInfo(mergeInfo(cached, fromPackage ?? undefined), fromFile ?? undefined)
    if (merged) cache[key] = { ...merged, name: fromFile?.name || merged.name }
  }))

  // Still nameless: the companion's installed-course list has every course's
  // name in one call, even when a course file couldn't be read for par.
  const nameless = keys.filter((key) => !cache[key]?.name)
  if (nameless.length > 0) {
    try {
      const library = await readLooperCompanionCourseLibrary(8000)
      const byKey = new Map(library.courses.map((course) => [course.courseKey.toLowerCase(), course]))
      nameless.forEach((key) => {
        const course = byKey.get(key.toLowerCase())
        if (!course?.courseName) return
        cache[key] = { name: course.courseName, pars: cache[key]?.pars ?? {}, parSource: cache[key]?.parSource ?? null }
      })
    } catch {
      // No companion on this device: names stay as saved or derived from the key.
    }
  }
  writeCourseCache(cache)

  // Share anything this device learned that the account didn't have yet.
  if (cloud) {
    const improved = Object.fromEntries(
      keys
        .filter((key) => cache[key] && (cache[key].name || cache[key].parSource) && !sameInfo(mergeInfo(before[key], cache[key]), before[key]))
        .map((key) => [key, mergeInfo(before[key], cache[key]) as StoredCourseInfo]),
    )
    await saveCloudCourseInfo(cloud.userId, improved).catch((error) => {
      console.warn('[Rounds] could not save course info to the account.', error)
    })
  }
  return cache
}

/** Course keys the page couldn't name: the sim PC with the companion hasn't seen them yet. */
export const unresolvedCourseKeys = (
  courseKeys: readonly string[],
  stored: Record<string, StoredCourseInfo>,
) => [...new Set(courseKeys)].filter((key) => key && !/range/i.test(key) && !stored[key]?.name)

export const toCourseInfoMap = (
  stored: Record<string, StoredCourseInfo>,
): Record<string, CourseInfo> =>
  Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { name: value.name, pars: value.pars }]))

// ---- per-round flags (auto putt) ---------------------------------------------

const flagsKey = () => `${ROUND_FLAGS_STORAGE_KEY}:${getActiveLocalUserId() ?? 'local'}`

export const loadRoundFlags = (): Record<number, RoundFlags> => {
  try {
    const raw = window.localStorage.getItem(flagsKey())
    return raw ? (JSON.parse(raw) as Record<number, RoundFlags>) : {}
  } catch {
    return {}
  }
}

export const saveRoundFlags = (flags: Record<number, RoundFlags>) => {
  try {
    window.localStorage.setItem(flagsKey(), JSON.stringify(flags))
  } catch {
    // Not fatal: the flag only changes what strokes gained includes.
  }
}

// ---- range numbers for "out here vs the range" -------------------------------

export type RangeClubNumbers = { carry: number; low: number | null; high: number | null; swings: number }

export const loadRangeCarries = (): Map<string, RangeClubNumbers> => {
  const now = Date.now()
  // Same session set and order as the dashboard's yardage book.
  const sessions = loadSavedSessions()
    .filter((session) => isSessionEligibleForAnalysis(session, now))
    .sort((left, right) => new Date(right.endedAt).getTime() - new Date(left.endedAt).getTime())
  const book = buildYardageBook(sessions, getActiveBagClubIds(), now)
  const out = new Map<string, RangeClubNumbers>()
  book.clubs.forEach((entry) => {
    const stock = entry.row.stock
    if (!stock || entry.row.needsData) return
    out.set(entry.club, {
      carry: stock.carry,
      low: entry.row.middleHalf?.low ?? null,
      high: entry.row.middleHalf?.high ?? null,
      swings: entry.row.swings,
    })
  })
  return out
}
