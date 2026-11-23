import { getAllowedUserRecord, getCurrentLooperUser, getSupabaseClient, isSupabaseConfigured } from '../cloud/supabaseClient'
import { latestGsproLogConditions, type GsproLogConditions } from '../adapters/gsproLogConditions'
import { hasRoundConditions } from '../liveCaddie/roundConditions'
import { loadActiveLiveCaddieRound, type ActiveLiveCaddieRound } from '../liveCaddie/roundRuntime'

/**
 * What the player said at Start a Round (course type, firmness, stimp, tees,
 * pins) saved on the GSPro round it belongs to: live_course_rounds.round_settings.
 * Only the browser that started the round knows these, so only it writes them,
 * and only to the first GSPro round seen after Start Round.
 *
 * A round played without Start a Round still gets what GSPro's own log says
 * (course type, firmness, altitude; never stimp), so its shots can be sorted by
 * conditions later (23 Nov). That never replaces what Start a Round saved.
 */
const MAX_ROUND_AGE_MS = 12 * 60 * 60 * 1000
/** A shot can be read a moment before Start Round is pressed. */
const START_SLACK_MS = 60 * 1000
const BOUND_KEY_PREFIX = 'looper.round-settings.bound:'
/** GSPro's log settings belong to the round being played: one whose last shot is this recent. */
const LOG_ROUND_FRESH_MS = 10 * 60 * 1000
const sent = new Map<number, string>()

export type RoundSettingsPayload = Readonly<{
  schema: 'looper-round-settings-v1'
  /** start-round: picked by the player (GSPro's log values replace the picks once seen). gspro-log: GSPro's log alone. */
  source: 'start-round' | 'gspro-log'
  recordedAt: string
  teeSet: string | null
  pinDay: string | null
  courseType: string | null
  greenFirmness: string | null
  fairwayFirmness: string | null
  stimp: number | null
  /** True when course type and firmness are GSPro's own, not the player's picks. */
  conditionsFromGspro: boolean
  /** GSPro's altitude for the round, feet; null when not seen. */
  altitudeFt: number | null
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
    conditionsFromGspro: active.conditionsFromGspro === true,
    altitudeFt: active.gsproAltitudeFt ?? null,
  }
}

/**
 * The settings to save from GSPro's log alone, for a round with no Start a Round behind it.
 * Only for the round being played now: `seen` is from shots hit while this page watched.
 */
export const gsproLogSettingsFor = (
  seen: GsproLogConditions | null,
  lastObservedAt: string | null,
  now: number = Date.now(),
): RoundSettingsPayload | null => {
  const last = lastObservedAt ? Date.parse(lastObservedAt) : NaN
  if (!seen || !Number.isFinite(last) || now - last > LOG_ROUND_FRESH_MS || last - now > START_SLACK_MS) return null
  return {
    schema: 'looper-round-settings-v1',
    source: 'gspro-log',
    recordedAt: new Date(last).toISOString(),
    teeSet: null,
    pinDay: null,
    courseType: seen.courseType,
    greenFirmness: seen.greenFirmness,
    fairwayFirmness: seen.fairwayFirmness,
    stimp: null,
    conditionsFromGspro: true,
    altitudeFt: seen.altitudeFt,
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

export const syncRoundSettingsToCloud = async (
  roundId: number,
  firstObservedAt: string | null,
  lastObservedAt: string | null = null,
) => {
  if (!isSupabaseConfigured()) return false
  const active = loadActiveLiveCaddieRound()
  const picked = roundSettingsFor(active, firstObservedAt)
  const fromStart = active && picked && !boundToAnotherRound(active.id, roundId) ? picked : null
  const settings = fromStart ?? gsproLogSettingsFor(latestGsproLogConditions(), lastObservedAt)
  if (!settings) return false
  // The time moves with every shot; the settings are what count.
  const fingerprint = JSON.stringify({ ...settings, recordedAt: settings.source === 'gspro-log' ? '' : settings.recordedAt })
  if (sent.get(roundId) === fingerprint) return false
  const user = await getCurrentLooperUser()
  if (!user || !(await getAllowedUserRecord(user))) return false
  const client = await getSupabaseClient()
  if (settings.source === 'gspro-log') {
    // Another browser may have started this round with Start a Round: its settings (stimp, tees) stay.
    const existing = await client.from<Array<{ round_settings: { source?: string } | null }>>('live_course_rounds')
      .select('round_settings').eq('user_id', user.id).eq('gspro_round_id', roundId).limit(1)
    if (existing.error) throw new Error(existing.error.message)
    if (!existing.data?.[0]) return false
    if (existing.data[0].round_settings?.source === 'start-round') {
      sent.set(roundId, fingerprint)
      return false
    }
  }
  const result = await client.from<unknown>('live_course_rounds').update({ round_settings: settings })
    .eq('user_id', user.id).eq('gspro_round_id', roundId)
  if (result.error) throw new Error(result.error.message)
  sent.set(roundId, fingerprint)
  return true
}
