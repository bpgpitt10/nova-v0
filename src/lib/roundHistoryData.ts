import {
  getCurrentLooperUser,
  getSupabaseClient,
  isSupabaseConfigured,
} from '../cloud/supabaseClient'
import {
  readLooperCompanionCourseLayouts,
  readLooperCompanionCourseLibrary,
  readLooperCompanionRoundPars,
  type LooperCompanionRoundPars,
} from '../adapters/looperCompanion'
import { courseRegistry, resolveCourseIdFromGsproName } from '../courseGeometry/courseCatalog'
import { NativeGkdError, parseGkdLayout } from '../courseGeometry/nativeGkd'
import { getActiveBagClubIds } from './bagConfig'
import { buildYardageBook } from './bagYardageBook'
import { getActiveLocalUserId } from './localUserScope'
import { loadLiveGsproRoundArchive, removeRoundsFromLiveGsproArchive } from './liveGsproRoundArchive'
import {
  recordFromArchivedShot,
  recordFromCloudRow,
  type CourseInfo,
  type LiveCourseShotRow,
  type RoundCountChoice,
  type RoundFlags,
  type RoundShotRecord,
} from './roundHistory'
import { isSessionEligibleForAnalysis, loadSavedSessions } from './sessions'
import { isBackdrop, type Backdrop } from './roundBackdrop'

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
  /** The player's count choices (account-wide, `live_course_rounds.count_state`); deleted rounds are left out of `records`. */
  countStates: ReadonlyMap<number, RoundCountChoice>
  /** Rounds that have a row in the cloud (a delete can update it; others need a tombstone row). */
  cloudRoundIds: ReadonlySet<number>
}

type RoundCountState = RoundCountChoice | 'deleted'
type CloudRoundRow = { gspro_round_id: number; count_state?: RoundCountState | null }

let cloudRoundRows: CloudRoundRow[] = []

const loadCloudRecords = async (): Promise<RoundShotRecord[] | null> => {
  if (!isSupabaseConfigured()) return null
  const user = await getCurrentLooperUser()
  if (!user) return null
  const client = await getSupabaseClient()
  const rounds = await awaitQuery<CloudRoundRow[]>(
    client
      .from<CloudRoundRow[]>('live_course_rounds')
      .select('gspro_round_id, count_state')
      .eq('user_id', user.id),
  )
  cloudRoundRows = rounds
  const ids = [...new Set(rounds.filter((row) => row.count_state !== 'deleted').map((row) => row.gspro_round_id))]
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
  let local = loadLocalRecords()
  let cloud: RoundShotRecord[] | null = null
  let cloudError: string | null = null
  try {
    cloud = await loadCloudRecords()
  } catch (error) {
    cloudError = error instanceof Error ? error.message : 'Could not load rounds.'
  }
  if (!cloud) return { records: local, source: 'local', cloudError, countStates: new Map(), cloudRoundIds: new Set() }
  const deleted = new Set(cloudRoundRows.filter((row) => row.count_state === 'deleted').map((row) => row.gspro_round_id))
  const countStates = new Map<number, RoundCountChoice>()
  cloudRoundRows.forEach((row) => {
    if (row.count_state === 'counts' || row.count_state === 'excluded') countStates.set(row.gspro_round_id, row.count_state)
  })
  const cloudRoundIds = new Set(cloudRoundRows.map((row) => row.gspro_round_id))
  // A deleted round may still be in this browser's archive: leave it out.
  local = local.filter((record) => !deleted.has(record.roundId))

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
  return { records: merged, source: preferLocal.size > 0 ? 'cloud+local' : 'cloud', cloudError, countStates, cloudRoundIds }
}

const signedInClient = async () => {
  if (!isSupabaseConfigured()) throw new Error('Sign in to manage rounds.')
  const user = await getCurrentLooperUser()
  if (!user) throw new Error('Sign in to manage rounds.')
  return { user, client: await getSupabaseClient() }
}

/** Sets whether rounds count (null: back to Looper's call). Account-wide. */
export const saveRoundCountState = async (roundIds: readonly number[], state: RoundCountChoice | null): Promise<void> => {
  if (roundIds.length === 0) return
  const { user, client } = await signedInClient()
  await awaitQuery<unknown>(
    client
      .from<unknown>('live_course_rounds')
      .update({ count_state: state })
      .eq('user_id', user.id)
      .in('gspro_round_id', [...roundIds]),
  )
}

/**
 * Deletes rounds from Looper: the round rows become tombstones (count_state
 * 'deleted') so the sim PC's copy isn't synced back, their shots are removed,
 * and this browser's copy goes too. Rounds only this browser had get a
 * tombstone row of their own.
 */
export const deleteRounds = async (
  rounds: ReadonlyArray<{ roundId: number; courseKey: string | null; playedAt: string | null }>,
  cloudRoundIds: ReadonlySet<number>,
): Promise<void> => {
  if (rounds.length === 0) return
  const { user, client } = await signedInClient()
  const inCloud = rounds.filter((round) => cloudRoundIds.has(round.roundId)).map((round) => round.roundId)
  const localOnly = rounds.filter((round) => !cloudRoundIds.has(round.roundId))
  if (inCloud.length > 0) {
    await awaitQuery<unknown>(
      client.from<unknown>('live_course_rounds').update({ count_state: 'deleted' })
        .eq('user_id', user.id).in('gspro_round_id', inCloud),
    )
  }
  if (localOnly.length > 0) {
    const now = new Date().toISOString()
    const result = await client.from<unknown>('live_course_rounds').upsert(
      localOnly.map((round) => ({
        user_id: user.id, gspro_round_id: round.roundId, course_key: round.courseKey,
        first_observed_at: round.playedAt ?? now, last_observed_at: round.playedAt ?? now,
        shot_count: 0, count_state: 'deleted',
      })),
      { onConflict: 'user_id,gspro_round_id' },
    )
    if (result.error) throw new Error(result.error.message)
  }
  await awaitQuery<unknown>(
    client.from<unknown>('live_course_shots').delete()
      .eq('user_id', user.id).in('gspro_round_id', rounds.map((round) => round.roundId)),
  )
  removeRoundsFromLiveGsproArchive(rounds.map((round) => round.roundId))
}

// ---- course names and pars --------------------------------------------------

export type StoredCourseInfo = {
  name: string | null
  pars: Record<number, number>
  /** scorecard: GSPro's own scorecard (beats the course file: The Old Game's
   * file says hole 7 is a par 4, GSPro scores it as a 5). */
  parSource: 'scorecard' | 'course-file' | 'course-package' | null
  /** GSPro designer style tags (links, parkland, mountain…), from companion courses.8+. */
  keywords?: string[]
  altitudeFt?: number | null
  /** The player's backdrop choice for this course; null = pick automatically. */
  backdrop?: Backdrop | null
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

const COURSE_FILE_TIMEOUT_MS = 12000
const COURSE_LIST_TIMEOUT_MS = 20000

/** One course's GKD via the companion; the slow path when the course list has no par. */
const parsFromCourseFile = async (courseKey: string): Promise<StoredCourseInfo | null> => {
  const response = await readLooperCompanionCourseLayouts(courseKey, COURSE_FILE_TIMEOUT_MS)
  if (response.status !== 'ready') return null
  const file = response.layouts.find((entry) => entry.kind === 'main') ?? response.layouts[0]
  if (!file) return null
  let layout
  try {
    layout = parseGkdLayout(file.text)
  } catch (error) {
    if (error instanceof NativeGkdError) return null
    throw error
  }
  const pars: Record<number, number> = {}
  layout.holes.forEach((hole) => {
    if (typeof hole.par === 'number') pars[hole.hole] = hole.par
  })
  return { name: layout.courseName, pars, parSource: Object.keys(pars).length > 0 ? 'course-file' : null }
}

/**
 * GSPro's own par per hole, per course, from the newest recorded round on it
 * (companion courses.10+: read from the hole layout GSPro logs, checked against
 * that round's pins). null when no companion answers or it's older.
 */
export const scorecardParsByCourse = (rounds: readonly LooperCompanionRoundPars[]): Map<string, Record<number, number>> => {
  const byCourse = new Map<string, Record<number, number>>()
  const newestFirst = [...rounds].sort((a, b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? ''))
  for (const round of newestFirst) {
    const key = round.courseKey?.toLowerCase()
    if (!key || byCourse.has(key)) continue
    const pars: Record<number, number> = {}
    Object.entries(round.pars ?? {}).forEach(([hole, par]) => {
      if (Number.isInteger(par) && par >= 2 && par <= 7 && Number(hole) >= 1 && Number(hole) <= 36) pars[Number(hole)] = par
    })
    if (Object.keys(pars).length >= 9) byCourse.set(key, pars)
  }
  return byCourse
}

const scorecardInfo = async (): Promise<Map<string, Record<number, number>> | null> => {
  try {
    return scorecardParsByCourse(await readLooperCompanionRoundPars())
  } catch {
    return null
  }
}

/**
 * Every installed course's name (and, from companion courses.7, par per hole)
 * in one request. null when no companion answers on this device.
 */
const courseLibraryInfo = async (): Promise<Map<string, StoredCourseInfo> | null> => {
  try {
    const library = await readLooperCompanionCourseLibrary(COURSE_LIST_TIMEOUT_MS)
    return new Map(library.courses.map((course) => {
      const pars: Record<number, number> = {}
      Object.entries(course.pars ?? {}).forEach(([hole, par]) => {
        if (Number.isFinite(par)) pars[Number(hole)] = par
      })
      return [course.courseKey.toLowerCase(), {
        name: course.courseName || null,
        pars,
        parSource: Object.keys(pars).length > 0 ? 'course-file' as const : null,
        ...(course.keywords?.length ? { keywords: course.keywords } : {}),
        ...(typeof course.altitude === 'number' ? { altitudeFt: course.altitude } : {}),
      }]
    }))
  } catch {
    return null
  }
}

type CourseInfoRow = {
  course_key: string
  course_name: string | null
  pars: Record<string, number> | null
  par_source: string | null
  style_keywords: string[] | null
  altitude_ft: number | null
  backdrop: string | null
}

const sourceRank = (source: StoredCourseInfo['parSource']) =>
  source === 'scorecard' ? 3 : source === 'course-file' ? 2 : source === 'course-package' ? 1 : 0

const storedFromRow = (row: CourseInfoRow): StoredCourseInfo => {
  const pars: Record<number, number> = {}
  Object.entries(row.pars ?? {}).forEach(([hole, par]) => {
    if (typeof par === 'number' && Number.isFinite(par)) pars[Number(hole)] = par
  })
  const parSource = row.par_source === 'scorecard' || row.par_source === 'course-file' || row.par_source === 'course-package'
    ? row.par_source : null
  return {
    name: row.course_name,
    pars,
    parSource,
    ...(Array.isArray(row.style_keywords) ? { keywords: row.style_keywords.filter((k) => typeof k === 'string') } : {}),
    ...(typeof row.altitude_ft === 'number' ? { altitudeFt: row.altitude_ft } : {}),
    backdrop: isBackdrop(row.backdrop) ? row.backdrop : null,
  }
}

/** Better of two records: a stronger par source wins; a name is never lost. */
const mergeInfo = (a: StoredCourseInfo | undefined, b: StoredCourseInfo | undefined): StoredCourseInfo | undefined => {
  if (!a) return b
  if (!b) return a
  // A stronger source wins; between two GSPro scorecards, the newer (b).
  const winner = sourceRank(b.parSource) > sourceRank(a.parSource)
    || (b.parSource === 'scorecard' && a.parSource === 'scorecard') ? b : a
  const other = winner === a ? b : a
  const keywords = b.keywords?.length ? b.keywords : a.keywords
  const altitudeFt = b.altitudeFt ?? a.altitudeFt
  // The newer record's choice wins, including an explicit null (back to automatic).
  const backdrop = b.backdrop !== undefined ? b.backdrop : a.backdrop
  return {
    name: winner.name ?? other.name,
    pars: Object.keys(winner.pars).length > 0 ? winner.pars : other.pars,
    parSource: winner.parSource ?? other.parSource,
    ...(keywords?.length ? { keywords } : {}),
    ...(altitudeFt != null ? { altitudeFt } : {}),
    ...(backdrop !== undefined ? { backdrop } : {}),
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
      .select('course_key,course_name,pars,par_source,style_keywords,altitude_ft,backdrop')
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
    // Every row carries every column (a key missing from one row of a batch
    // becomes NULL); rows are already merged with what the account had.
    style_keywords: info.keywords?.length ? info.keywords : null,
    altitude_ft: info.altitudeFt ?? null,
    backdrop: info.backdrop ?? null,
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

  // 0. GSPro's own scorecard par (companion courses.10+) beats the course file.
  const scorecards = await scorecardInfo()
  if (scorecards) {
    keys.forEach((key) => {
      const pars = scorecards.get(key.toLowerCase())
      if (!pars) return
      const merged = mergeInfo(cache[key], { name: cache[key]?.name ?? null, pars, parSource: 'scorecard' })
      if (merged) cache[key] = merged
    })
  }

  const needsLookup = (key: string) =>
    !((cache[key]?.parSource === 'course-file' || cache[key]?.parSource === 'scorecard') && cache[key]?.name)

  // 1. The companion's course list: every name, and par from courses.7 on.
  const library = keys.some(needsLookup) ? await courseLibraryInfo() : null
  if (library) {
    keys.forEach((key) => {
      const merged = mergeInfo(cache[key], library.get(key.toLowerCase()))
      if (merged) cache[key] = { ...merged, name: library.get(key.toLowerCase())?.name || merged.name }
    })
  }

  // 2. Loaded course packages (FarmLinks…): par without the companion.
  await Promise.all(keys.filter((key) => !cache[key]?.parSource).map(async (key) => {
    const fromPackage = await parsFromPackage(key).catch(() => null)
    const merged = mergeInfo(cache[key], fromPackage ?? undefined)
    if (merged) cache[key] = merged
  }))

  // 3. Older companions: read each course file, one at a time (the companion
  //    walks the library per request; six at once overran their timeouts).
  if (library) {
    for (const key of keys.filter(needsLookup)) {
      if (Object.keys(library.get(key.toLowerCase())?.pars ?? {}).length > 0) continue
      const fromFile = await parsFromCourseFile(key).catch(() => null)
      const merged = mergeInfo(cache[key], fromFile ?? undefined)
      if (merged) cache[key] = { ...merged, name: fromFile?.name || merged.name }
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

/**
 * Save the player's backdrop for a course (null = automatic) here and to the
 * account. One row, only this column: name, par and alignment stay as stored.
 */
export const saveCourseBackdrop = async (courseKey: string, backdrop: Backdrop | null) => {
  const cache = readCourseCache()
  cache[courseKey] = { ...(cache[courseKey] ?? { name: null, pars: {}, parSource: null }), backdrop }
  writeCourseCache(cache)
  if (!isSupabaseConfigured()) return
  const user = await getCurrentLooperUser()
  if (!user) return
  const client = await getSupabaseClient()
  const result = await client.from<unknown>('live_course_info').upsert(
    { user_id: user.id, course_key: courseKey, backdrop, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,course_key' },
  )
  if (result.error) throw new Error(result.error.message)
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
