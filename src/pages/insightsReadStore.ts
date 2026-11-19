import { getSupabaseClient, isSupabaseConfigured } from '../cloud/supabaseClient'

/**
 * Reads people make in "Test your read" on the insights page, kept so the page
 * can say how far off people are on average. Nothing about the visitor is
 * stored: only the shot, the answer and the guess.
 */

export type InsightRead = Readonly<{
  club: string
  baseYds: number
  actualYds: number
  actualSideYds: number
  guessYds: number
  guessSideYds: number
  conditions: Record<string, unknown>
}>

export type InsightReadStats = Readonly<{
  reads: number
  /** Average miss in distance, yards. */
  missYds: number
  /** The same as a share of how far the shot went, percent. */
  missPct: number
  sideMissYds: number
}>

type Rows = PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }> & {
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>
}

type Table = {
  insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>
  select(columns: string): Rows
}

const table = async (name: string): Promise<Table | null> => {
  if (!isSupabaseConfigured()) return null
  const client = (await getSupabaseClient()) as unknown as { from(table: string): Table }
  return client.from(name)
}

/** Save one read. Never throws: the quiz works the same if this fails. */
export const saveInsightRead = async (read: InsightRead): Promise<boolean> => {
  try {
    const guesses = await table('insight_read_guesses')
    if (!guesses) return false
    const { error } = await guesses.insert({
      club: read.club,
      base_yds: Math.round(read.baseYds),
      actual_yds: Math.round(read.actualYds * 10) / 10,
      actual_side_yds: Math.round(read.actualSideYds * 10) / 10,
      guess_yds: Math.round(read.guessYds * 10) / 10,
      guess_side_yds: Math.round(read.guessSideYds * 10) / 10,
      conditions: read.conditions,
    })
    return !error
  } catch {
    return false
  }
}

const number = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN)

/** How everyone has done so far, or null when it can't be read. */
export const loadInsightReadStats = async (): Promise<InsightReadStats | null> => {
  try {
    const stats = await table('insight_read_stats')
    if (!stats) return null
    const { data, error } = await stats.select('reads, avg_miss_yds, avg_miss_pct, avg_side_miss_yds').maybeSingle()
    if (error || !data) return null
    const out = { reads: number(data.reads), missYds: number(data.avg_miss_yds), missPct: number(data.avg_miss_pct), sideMissYds: number(data.avg_side_miss_yds) }
    return Object.values(out).every(Number.isFinite) ? out : null
  } catch {
    return null
  }
}

// ---- The 20 closest reads ---------------------------------------------------

export type InsightTopRead = Readonly<{ initials: string; missYds: number; club: string }>

/** Three-letter words nobody needs on a leaderboard. The database refuses them too. */
const NOT_INITIALS = /^(ASS|FUK|FUC|FCK|KKK|NIG|FAG|CUM|TIT|DIK|COK)$/

/** One to three capital letters, or null when what was typed can't be used. */
export const cleanInitials = (typed: string): string | null => {
  const letters = typed.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)
  return letters && !NOT_INITIALS.test(letters) ? letters : null
}

/** The straight line, in yards to one decimal, from a read to where the ball finished. */
export const readMissYds = (read: Pick<InsightRead, 'actualYds' | 'actualSideYds' | 'guessYds' | 'guessSideYds'>) =>
  Math.round(Math.hypot(read.actualYds - read.guessYds, read.actualSideYds - read.guessSideYds) * 10) / 10

/** A shot has to move this far from the club's normal for its read to count. */
export const LEADERBOARD_MIN_MOVE_YDS = 8

export const loadTopReads = async (): Promise<InsightTopRead[] | null> => {
  try {
    const top = await table('insight_read_top20')
    if (!top) return null
    const { data, error } = await top.select('initials, miss_yds, club')
    if (error || !data) return null
    return data
      .map((row) => ({ initials: String(row.initials ?? ''), missYds: number(row.miss_yds), club: String(row.club ?? '') }))
      .filter((row) => row.initials && Number.isFinite(row.missYds))
      .sort((a, b) => a.missYds - b.missYds)
  } catch {
    return null
  }
}

/** Post a read to the leaderboard. Returns whether it was taken. */
export const postTopRead = async (initials: string, read: InsightRead): Promise<boolean> => {
  try {
    const board = await table('insight_read_leaderboard')
    const clean = cleanInitials(initials)
    if (!board || !clean) return false
    const rounded = {
      actualYds: Math.round(read.actualYds * 10) / 10,
      actualSideYds: Math.round(read.actualSideYds * 10) / 10,
      guessYds: Math.round(read.guessYds * 10) / 10,
      guessSideYds: Math.round(read.guessSideYds * 10) / 10,
    }
    const { error } = await board.insert({
      initials: clean,
      miss_yds: readMissYds(rounded),
      club: read.club,
      base_yds: Math.round(read.baseYds),
      actual_yds: rounded.actualYds,
      actual_side_yds: rounded.actualSideYds,
      guess_yds: rounded.guessYds,
      guess_side_yds: rounded.guessSideYds,
    })
    return !error
  } catch {
    return false
  }
}
