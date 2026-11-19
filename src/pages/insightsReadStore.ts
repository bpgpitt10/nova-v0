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

type Table = {
  insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>
  select(columns: string): { maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }> }
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
      guess_yds: Math.round(read.guessYds),
      guess_side_yds: Math.round(read.guessSideYds),
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
