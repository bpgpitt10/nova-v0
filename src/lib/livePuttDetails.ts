import type { BrowserGsproPuttDetail } from '../adapters/browserGsproCourseArchive'
import {
  getAllowedUserRecord,
  getCurrentLooperUser,
  getSupabaseClient,
  isSupabaseConfigured,
} from '../cloud/supabaseClient'

/**
 * Full putt records (roll path and every field GSPro wrote) go straight to
 * the cloud table live_putt_details. They are too big for the browser's round
 * archive, so nothing is kept locally beyond "already sent this page load".
 */
const sent = new Map<string, { userId: string; fingerprint: string }>()
const BATCH = 40
let queue: Promise<void> = Promise.resolve()

const keyOf = (detail: BrowserGsproPuttDetail) => `${detail.roundId}:${detail.shotId}`

export const puttDetailRow = (detail: BrowserGsproPuttDetail, userId: string, now: string) => ({
  user_id: userId,
  gspro_round_id: detail.roundId,
  shot_id: detail.shotId,
  course_key: detail.courseKey,
  hole_number: detail.holeNumber,
  hole_shot: detail.holeShot,
  global_shot_number: detail.globalShotNumber,
  detail: detail.detail,
  updated_at: now,
})

/** Details not yet sent for this account (or changed since) this page load. */
export const unsentPuttDetails = (details: readonly BrowserGsproPuttDetail[], userId: string | null) =>
  details.filter((detail) => {
    const prior = sent.get(keyOf(detail))
    return !prior || (userId != null && prior.userId !== userId) || prior.fingerprint !== JSON.stringify(detail.detail)
  })

const upload = async (details: readonly BrowserGsproPuttDetail[]) => {
  const user = await getCurrentLooperUser()
  if (!user || !(await getAllowedUserRecord(user))) return 0
  const pending = unsentPuttDetails(details, user.id)
  const client = await getSupabaseClient()
  const now = new Date().toISOString()
  for (let start = 0; start < pending.length; start += BATCH) {
    const batch = pending.slice(start, start + BATCH)
    const result = await client.from<unknown>('live_putt_details').upsert(
      batch.map((detail) => puttDetailRow(detail, user.id, now)),
      { onConflict: 'user_id,gspro_round_id,shot_id' },
    )
    if (result.error) throw new Error(result.error.message)
    for (const detail of batch) {
      sent.set(keyOf(detail), { userId: user.id, fingerprint: JSON.stringify(detail.detail) })
    }
  }
  return pending.length
}

export const syncPuttDetailsToCloud = (details: readonly BrowserGsproPuttDetail[]): Promise<number> => {
  // Called on every round read: do nothing, and ask nothing, unless a putt is new.
  if (unsentPuttDetails(details, null).length === 0 || !isSupabaseConfigured()) return Promise.resolve(0)
  // One upload at a time, in order, so a putt is never sent twice at once.
  const run = queue.then(() => upload(details))
  queue = run.then(() => undefined, () => undefined)
  return run
}
