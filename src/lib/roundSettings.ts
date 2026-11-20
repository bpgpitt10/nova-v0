import { getAllowedUserRecord, getCurrentLooperUser, getSupabaseClient, isSupabaseConfigured } from '../cloud/supabaseClient'
import { hasRoundConditions } from '../liveCaddie/roundConditions'
import { loadActiveLiveCaddieRound, type ActiveLiveCaddieRound } from '../liveCaddie/roundRuntime'

/**
 * What the player said at Start a Round (course type, firmness, stimp, tees,
 * pins) saved on the GSPro round it belongs to: live_course_rounds.round_settings.
 * Only the browser that started the round knows these, so only it writes them,
 * and only to the first GSPro round seen after Start Round.
 */
const MAX_ROUND_AGE_MS = 12 * 60 * 60 * 1000
/** A shot can be read a moment before Start Round is pressed. */
const START_SLACK_MS = 60 * 1000
const BOUND_KEY_PREFIX = 'looper.round-settings.bound:'
const sent = new Map<number, string>()

export type RoundSettingsPayload = Readonly<{
  schema: 'looper-round-settings-v1'
  source: 'start-round'
  recordedAt: string
  teeSet: string
  pinDay: string | null
  courseType: string | null
  greenFirmness: string | null
  fairwayFirmness: string | null
  stimp: number | null
}>

/** The settings to save on a GSPro round first seen at `firstObservedAt`, or null when Start Round doesn't cover it. */
export const roundSettingsFor = (
  active: ActiveLiveCaddieRound | null,
  firstObservedAt: string | null,
  now: number = Date.now(),
): RoundSettingsPayload | null => {
  if (!active || !hasRoundConditions(active.conditions)) return null
  const started = Date.parse(active.startedAt)
  const first = firstObservedAt ? Date.parse(firstObservedAt) : NaN
  if (!Number.isFinite(started) || !Number.isFinite(first)) return null
  if (now - started > MAX_ROUND_AGE_MS || first < started - START_SLACK_MS) return null
  return {
    schema: 'looper-round-settings-v1',
    source: 'start-round',
    recordedAt: active.startedAt,
    teeSet: active.teeSet,
    pinDay: active.pinDay ?? null,
    courseType: active.conditions?.courseType ?? null,
    greenFirmness: active.conditions?.greenFirmness ?? null,
    fairwayFirmness: active.conditions?.fairwayFirmness ?? null,
    stimp: active.conditions?.stimp ?? null,
  }
}

/** One Start Round covers one GSPro round: the first seen after it. */
const boundToAnotherRound = (activeId: string, roundId: number) => {
  try {
    const key = `${BOUND_KEY_PREFIX}${activeId}`
    const bound = window.localStorage.getItem(key)
    if (bound == null) {
      window.localStorage.setItem(key, String(roundId))
      return false
    }
    return bound !== String(roundId)
  } catch {
    return false
  }
}

export const syncRoundSettingsToCloud = async (roundId: number, firstObservedAt: string | null) => {
  if (!isSupabaseConfigured()) return false
  const active = loadActiveLiveCaddieRound()
  const settings = roundSettingsFor(active, firstObservedAt)
  if (!active || !settings) return false
  const fingerprint = JSON.stringify(settings)
  if (sent.get(roundId) === fingerprint) return false
  if (boundToAnotherRound(active.id, roundId)) return false
  const user = await getCurrentLooperUser()
  if (!user || !(await getAllowedUserRecord(user))) return false
  const client = await getSupabaseClient()
  const result = await client.from<unknown>('live_course_rounds').update({ round_settings: settings })
    .eq('user_id', user.id).eq('gspro_round_id', roundId)
  if (result.error) throw new Error(result.error.message)
  sent.set(roundId, fingerprint)
  return true
}
