import { getAllowedUserRecord, getCurrentLooperUser, getSupabaseClient, isSupabaseConfigured } from '../cloud/supabaseClient'

/**
 * Has a companion ever answered for this account, and has it ever seen GSPro?
 * Saved on the account (companion_connections) so "never installed" can be told
 * from "installed, never hit a shot". Written when the companion answers: once
 * a day per browser, and again when the release changes or GSPro is first seen.
 */
const SENT_KEY = 'looper.companion-connection-sent.v1'
let sending = false

type Sent = Readonly<{ user: string; day: string; release: string | null; gspro: boolean }>
type Row = { first_seen_at: string | null; gspro_seen_at: string | null }

/** Whether this sighting adds anything to what this browser already sent. */
export const connectionNeedsSaving = (
  sent: Sent | null, user: string, day: string, release: string | null, gsproConnected: boolean,
) => !sent || sent.user !== user || sent.day !== day || sent.release !== release || (gsproConnected && !sent.gspro)

const readSent = (): Sent | null => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SENT_KEY) ?? 'null') as Sent | null
    return parsed && typeof parsed.user === 'string' && typeof parsed.day === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** Call when the companion has just answered. Never throws; never blocks the page. */
export const noteCompanionConnected = (release: string | null, gsproConnected: boolean): void => {
  if (sending || !isSupabaseConfigured()) return
  sending = true
  void (async () => {
    const user = await getCurrentLooperUser()
    if (!user) return
    const now = new Date().toISOString()
    const day = now.slice(0, 10)
    if (!connectionNeedsSaving(readSent(), user.id, day, release, gsproConnected)) return
    if (!(await getAllowedUserRecord(user))) return
    const client = await getSupabaseClient()
    const existing = await client.from<Row[]>('companion_connections')
      .select('first_seen_at, gspro_seen_at').eq('user_id', user.id).limit(1)
    if (existing.error) throw new Error(existing.error.message)
    const before = existing.data?.[0] ?? null
    const saved = await client.from<unknown>('companion_connections').upsert({
      user_id: user.id,
      first_seen_at: before?.first_seen_at ?? now,
      last_seen_at: now,
      gspro_seen_at: before?.gspro_seen_at ?? (gsproConnected ? now : null),
      release: release ? release.slice(0, 60) : null,
      updated_at: now,
    }, { onConflict: 'user_id' })
    if (saved.error) throw new Error(saved.error.message)
    try {
      const sent: Sent = { user: user.id, day, release, gspro: gsproConnected || before?.gspro_seen_at != null }
      window.localStorage.setItem(SENT_KEY, JSON.stringify(sent))
    } catch {
      // storage unavailable: it is saved again on the next look, which is harmless
    }
  })().catch((error) => {
    console.warn('[Looper] companion connection not saved; will retry.', error)
  }).finally(() => { sending = false })
}
