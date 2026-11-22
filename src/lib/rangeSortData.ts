import { getCurrentLooperUser, getSupabaseClient, isSupabaseConfigured } from '../cloud/supabaseClient'
import { getActiveBagClubIds, type Club } from './bagConfig'
import { getActiveLocalUserId } from './localUserScope'
import { groupVisits, unsortedSwings, type RangeSwing, type RangeVisit } from './rangeSort'
import { loadSavedSessions, saveSessionHistory } from './sessions'
import type { SavedSession } from '../types'

/** GSPro's range has no round: its shots are saved under this id. */
const RANGE_ROUND_ID = -1
const MAX_ROWS = 1000
const METERS_TO_YARDS = 1.0936133
/** On this range the bays face +z, so sideways is x (right is positive). */
const STRAIGHT_RANGE_KEYS = new Set(['multi_range_gsp'])
const DISMISSED_KEY = 'looper-range-sort-dismissed-v1'

type Row = {
  shot_id: string
  hole_shot: number | null
  course_key: string | null
  observed_at: string | null
  ball_speed_mph: number | null
  carry_yards: number | null
  total_yards: number | null
  vertical_launch_angle_degrees: number | null
  horizontal_launch_angle_degrees: number | null
  total_spin_rpm: number | null
  spin_axis_degrees: number | null
  back_spin_rpm: number | null
  side_spin_rpm: number | null
  raw_metrics: Record<string, unknown> | null
  inferred_club: string | null
  inference_confidence: number | null
}

const COLUMNS = [
  'shot_id', 'hole_shot', 'course_key', 'observed_at', 'ball_speed_mph', 'carry_yards', 'total_yards',
  'vertical_launch_angle_degrees', 'horizontal_launch_angle_degrees', 'total_spin_rpm', 'spin_axis_degrees',
  'back_spin_rpm', 'side_spin_rpm', 'raw_metrics', 'inferred_club', 'inference_confidence',
].join(',')

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const pointX = (value: unknown) => {
  const x = value && typeof value === 'object' ? (value as { x?: unknown }).x : null
  return num(x)
}

/** A swing worth sorting: a real full shot with the numbers the bag needs. */
const MIN_CARRY_YDS = 20
const MIN_BALL_SPEED_MPH = 30

export const swingFromRow = (row: Row, bag: ReadonlySet<string>): RangeSwing | null => {
  const at = row.observed_at ? Date.parse(row.observed_at) : NaN
  const speed = num(row.ball_speed_mph)
  const carry = num(row.carry_yards)
  if (!Number.isFinite(at) || speed == null || carry == null) return null
  if (carry < MIN_CARRY_YDS || speed < MIN_BALL_SPEED_MPH) return null
  const raw = row.raw_metrics ?? {}
  const startX = pointX(raw.startingPositionMeters)
  const touchX = pointX(raw.touchdownPositionMeters)
  const offline = STRAIGHT_RANGE_KEYS.has(row.course_key ?? '') && startX != null && touchX != null
    ? (touchX - startX) * METERS_TO_YARDS : null
  return {
    id: row.shot_id,
    at,
    seq: num(row.hole_shot) ?? 0,
    ballSpeedMph: speed,
    launchDeg: num(row.vertical_launch_angle_degrees),
    startDirectionDeg: num(row.horizontal_launch_angle_degrees),
    spinRpm: num(row.total_spin_rpm),
    spinAxisDeg: num(row.spin_axis_degrees),
    backSpinRpm: num(row.back_spin_rpm),
    sideSpinRpm: num(row.side_spin_rpm),
    carryYds: carry,
    totalYds: num(row.total_yards),
    offlineYds: offline,
    guess: row.inferred_club && bag.has(row.inferred_club) ? row.inferred_club as Club : null,
    guessConfidence: num(row.inference_confidence),
  }
}

const dismissedKey = () => `${DISMISSED_KEY}:${getActiveLocalUserId() ?? 'local'}`

export const loadDismissedSwingIds = (): Set<string> => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(dismissedKey()) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Swings the player chose to leave out: not offered again in this browser. */
export const dismissSwings = (ids: readonly string[]) => {
  const all = loadDismissedSwingIds()
  ids.forEach((id) => all.add(id))
  try {
    window.localStorage.setItem(dismissedKey(), JSON.stringify([...all].slice(-5000)))
  } catch {
    // a convenience only: the swings may be offered again
  }
}

type QueryResult = { data: Row[] | null; error: { message: string } | null }

/** The player's range swings that aren't in the bag yet, grouped into visits and runs. Signed in only. */
export const loadUnsortedRangeVisits = async (): Promise<RangeVisit[]> => {
  if (!isSupabaseConfigured()) return []
  const user = await getCurrentLooperUser()
  if (!user) return []
  const client = await getSupabaseClient()
  const result = await (client
    .from<Row[]>('live_course_shots')
    .select(COLUMNS)
    .eq('user_id', user.id)
    .eq('gspro_round_id', RANGE_ROUND_ID)
    .order('observed_at', { ascending: false })
    .limit(MAX_ROWS) as unknown as Promise<QueryResult>)
  if (result.error) throw new Error(result.error.message)
  const bag = new Set<string>(getActiveBagClubIds())
  const swings = (result.data ?? [])
    .map((row) => swingFromRow(row, bag))
    .filter((swing): swing is RangeSwing => swing != null)
  return groupVisits(unsortedSwings(swings, loadSavedSessions(), loadDismissedSwingIds()))
}

/** Adds a sorted visit to the bag as a range session (synced to the account like any other). */
export const saveSortedVisit = (session: SavedSession) => {
  const saved = loadSavedSessions()
  const earlier = saved.find((existing) => existing.id === session.id)
  // The same visit sorted in two goes: keep the swings from the first go.
  const merged: SavedSession = earlier
    ? {
        ...session,
        shots: [...earlier.shots.filter((shot) => !session.shots.some((s) => s.id === shot.id)), ...session.shots]
          .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)),
      }
    : session
  const next = [...saved.filter((existing) => existing.id !== session.id), merged]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  saveSessionHistory(next)
}
