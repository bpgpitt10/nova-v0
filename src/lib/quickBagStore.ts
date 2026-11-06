import {
  getAllowedUserRecord,
  getCurrentLooperUser,
  getSupabaseClient,
  isSupabaseConfigured,
} from '../cloud/supabaseClient'
import { getActiveBagClubIds, type Club } from './bagConfig'
import { QUICK_BAG_STORAGE_KEY, persistWorkingCacheValueForActiveUser } from './localUserScope'
import {
  ANCHOR_CLUBS,
  buildQuickBagPrior,
  type AnchorClub,
  type QuickBagInput,
  type QuickBagPrior,
  type ShotShape,
} from './quickBag'

/**
 * Where the Quick Bag lives: the browser's per-user cache (so the Live Caddie
 * workers get it synchronously) and the `quick_bags` table (one row per
 * account, so the sim PC and the MacBook agree).
 */

export const QUICK_BAG_UPDATED_EVENT = 'looper-quick-bag-updated'

const SHAPES: readonly ShotShape[] = ['draw', 'neutral', 'fade']

const parseInput = (value: unknown): QuickBagInput | null => {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const anchorsRaw = v.anchors as Record<string, unknown> | undefined
  if (!anchorsRaw || typeof anchorsRaw !== 'object') return null
  const anchors = {} as Record<AnchorClub, { carryYds: number; shape: ShotShape }>
  for (const club of ANCHOR_CLUBS) {
    const a = anchorsRaw[club] as Record<string, unknown> | undefined
    const carry = a?.carryYds
    if (typeof carry !== 'number' || !Number.isFinite(carry)) return null
    const shape = SHAPES.includes(a?.shape as ShotShape) ? (a!.shape as ShotShape) : 'neutral'
    anchors[club] = { carryYds: carry, shape }
  }
  const clubs = Array.isArray(v.clubs) ? (v.clubs.filter((c) => typeof c === 'string') as Club[]) : []
  const overridesRaw = v.carryOverrides as Record<string, unknown> | undefined
  const carryOverrides: Partial<Record<Club, number>> = {}
  if (overridesRaw && typeof overridesRaw === 'object') {
    for (const [club, carry] of Object.entries(overridesRaw)) {
      if (typeof carry === 'number' && Number.isFinite(carry)) carryOverrides[club as Club] = carry
    }
  }
  return {
    version: 1,
    handicap: typeof v.handicap === 'number' && Number.isFinite(v.handicap) ? v.handicap : null,
    anchors,
    clubs: clubs.length ? clubs : getActiveBagClubIds(),
    carryOverrides,
    handed: v.handed === 'left' ? 'left' : 'right',
    savedAt: typeof v.savedAt === 'string' ? v.savedAt : new Date(0).toISOString(),
  }
}

export const loadQuickBagInput = (): QuickBagInput | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(QUICK_BAG_STORAGE_KEY)
    return raw ? parseInput(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

let memo: { raw: string | null; clubsKey: string; prior: QuickBagPrior | null } | null = null

/**
 * The prior for the current bag, built from the saved inputs and the clubs in
 * the bag setup (the bag can change after the Quick Bag was saved; the prior
 * always covers the clubs the player carries now).
 */
export const loadQuickBagPrior = (): QuickBagPrior | null => {
  if (typeof window === 'undefined') return null
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(QUICK_BAG_STORAGE_KEY)
  } catch {
    return null
  }
  const clubs = getActiveBagClubIds()
  const clubsKey = clubs.join(',')
  if (memo && memo.raw === raw && memo.clubsKey === clubsKey) return memo.prior
  let prior: QuickBagPrior | null = null
  if (raw) {
    try {
      const input = parseInput(JSON.parse(raw))
      if (input) prior = buildQuickBagPrior({ ...input, clubs })
    } catch {
      prior = null
    }
  }
  memo = { raw, clubsKey, prior }
  return prior
}

export const hasQuickBag = (): boolean => loadQuickBagInput() != null

const writeLocal = (input: QuickBagInput | null) => {
  const serialized = input ? JSON.stringify(input) : null
  if (serialized) window.localStorage.setItem(QUICK_BAG_STORAGE_KEY, serialized)
  else window.localStorage.removeItem(QUICK_BAG_STORAGE_KEY)
  persistWorkingCacheValueForActiveUser(QUICK_BAG_STORAGE_KEY, serialized)
  memo = null
  window.dispatchEvent(new Event(QUICK_BAG_UPDATED_EVENT))
}

export type QuickBagSyncResult =
  | { status: 'synced' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string }

export const syncQuickBagToCloud = async (input: QuickBagInput): Promise<QuickBagSyncResult> => {
  if (!isSupabaseConfigured()) return { status: 'skipped', reason: 'not-configured' }
  try {
    const user = await getCurrentLooperUser()
    if (!user) return { status: 'skipped', reason: 'signed-out' }
    if (!(await getAllowedUserRecord(user))) return { status: 'skipped', reason: 'not-allowed' }
    const client = await getSupabaseClient()
    const result = await client.from<unknown>('quick_bags').upsert(
      {
        user_id: user.id,
        handicap: input.handicap,
        anchors: input.anchors,
        clubs: input.clubs,
        carry_overrides: input.carryOverrides ?? {},
        handed: input.handed,
        saved_at: input.savedAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    if (result.error) return { status: 'failed', error: result.error.message }
    return { status: 'synced' }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/** Save the player's answers locally and to the account. */
export const saveQuickBag = (input: Omit<QuickBagInput, 'version' | 'savedAt'>): QuickBagInput => {
  const full: QuickBagInput = { ...input, version: 1, savedAt: new Date().toISOString() }
  writeLocal(full)
  void syncQuickBagToCloud(full).then((result) => {
    if (result.status === 'failed') console.warn('[Quick Bag] cloud save failed; local copy kept', result.error)
  })
  return full
}

export const clearQuickBagLocal = () => {
  if (typeof window === 'undefined') return
  writeLocal(null)
}

type QuickBagRow = {
  handicap: number | null
  anchors: unknown
  clubs: unknown
  carry_overrides: unknown
  handed: string | null
  saved_at: string | null
}

/** The account's Quick Bag, applied to this browser when newer than the local copy. */
export const hydrateQuickBagForUser = async (userId: string): Promise<QuickBagInput | null> => {
  const client = await getSupabaseClient()
  const result = await client
    .from<QuickBagRow>('quick_bags')
    .select('handicap, anchors, clubs, carry_overrides, handed, saved_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (result.error) throw new Error(result.error.message)
  if (!result.data) return null
  const parsed = parseInput({
    handicap: result.data.handicap,
    anchors: result.data.anchors,
    clubs: result.data.clubs,
    carryOverrides: result.data.carry_overrides,
    handed: result.data.handed,
    savedAt: result.data.saved_at,
  })
  if (!parsed) return null
  const local = loadQuickBagInput()
  if (!local || new Date(parsed.savedAt).getTime() > new Date(local.savedAt).getTime()) {
    writeLocal(parsed)
  }
  return parsed
}
