import type { BrowserGsproCourseArchiveRound, GsproPlayer } from '../adapters/browserGsproCourseArchive'
import { getAllowedUserRecord, getCurrentLooperUser, getSupabaseClient, isSupabaseConfigured } from '../cloud/supabaseClient'

/**
 * Which GSPro player this Looper account is, so a sim several people share only
 * sends each account its own shots.
 *
 * GSPro writes the player's name and their own player id on every shot. An
 * account claims players ('mine') or says a player isn't them ('not-mine');
 * both are saved in gspro_players and follow the account to any browser.
 *
 * A round is decided like this:
 * - a claimed player is in it: keep only the claimed players' shots;
 * - the account has never claimed anyone and the round has one player: claim them;
 * - every player in it was said not to be this account: skip it;
 * - otherwise ask once, "Which one is you?", and hold the round until answered.
 * Shots with no name and no id (old records) are kept, as before.
 */

export type PlayerVerdict = 'mine' | 'not-mine'
export type PlayerClaims = ReadonlyMap<string, { verdict: PlayerVerdict; name: string | null }>
export type RoundPlayer = GsproPlayer & { shots: number }

export type RoundDecision =
  | { kind: 'mine'; keys: ReadonlySet<string>; claim: RoundPlayer | null }
  | { kind: 'not-mine' }
  | { kind: 'ask'; players: readonly RoundPlayer[] }

const UNKNOWN = 'unknown'
const nameKey = (name: string | null) => (name ? `name:${name.toLowerCase()}` : null)

/** Whether a claim covers this player: by id, or by name for a claim made from a name alone. */
const verdictFor = (player: GsproPlayer, claims: PlayerClaims): PlayerVerdict | null => {
  const byKey = claims.get(player.key)?.verdict
  if (byKey) return byKey
  const byName = nameKey(player.name)
  return byName ? claims.get(byName)?.verdict ?? null : null
}

export const decideRound = (players: readonly RoundPlayer[], claims: PlayerClaims): RoundDecision => {
  const named = players.filter((player) => player.key !== UNKNOWN)
  if (named.length === 0) return { kind: 'mine', keys: new Set([UNKNOWN]), claim: null }
  const mine = named.filter((player) => verdictFor(player, claims) === 'mine')
  if (mine.length > 0) return { kind: 'mine', keys: new Set([UNKNOWN, ...mine.map((player) => player.key)]), claim: null }
  const claimedAnyone = [...claims.values()].some((claim) => claim.verdict === 'mine')
  if (!claimedAnyone && named.length === 1) {
    return { kind: 'mine', keys: new Set([UNKNOWN, named[0].key]), claim: named[0] }
  }
  const open = named.filter((player) => verdictFor(player, claims) == null)
  if (open.length === 0) return { kind: 'not-mine' }
  return { kind: 'ask', players: named }
}

/** The round with only these players' shots and putts. */
export const roundForPlayers = (
  round: BrowserGsproCourseArchiveRound,
  keys: ReadonlySet<string>,
): BrowserGsproCourseArchiveRound => ({
  ...round,
  players: round.players.filter((player) => keys.has(player.key)),
  shots: round.shots.filter((shot) => keys.has(shot.player.key)),
  puttDetails: round.puttDetails.filter((putt) => keys.has(putt.playerKey)),
})

// ---- Claims, per account --------------------------------------------------

const CACHE_PREFIX = 'looper.gspro-players.v1:'
const ASK_PREFIX = 'looper.gspro-player-ask.v1:'
const REFRESH_MS = 5 * 60 * 1000
export const GSPRO_PLAYER_EVENT = 'looper:gspro-players'

type ClaimRow = { player_guid: string; player_name: string | null; verdict: PlayerVerdict }
const cache = new Map<string, { at: number; claims: Map<string, { verdict: PlayerVerdict; name: string | null }> }>()

const readLocal = <T,>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

const writeLocal = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // The cloud copy is the real one; this only saves a fetch.
  }
}

const announce = () => {
  try {
    window.dispatchEvent(new Event(GSPRO_PLAYER_EVENT))
  } catch {
    // No window (tests).
  }
}

const toMap = (rows: readonly ClaimRow[]) => new Map(rows.map((row) => [row.player_guid, { verdict: row.verdict, name: row.player_name }]))

/** This account's claims, from the cloud (cached for a few minutes), or the last copy this browser saw. */
export const loadPlayerClaims = async (userId: string, { fresh = false } = {}): Promise<PlayerClaims> => {
  const cached = cache.get(userId)
  if (cached && !fresh && Date.now() - cached.at < REFRESH_MS) return cached.claims
  try {
    const client = await getSupabaseClient()
    const result = await client.from<ClaimRow[]>('gspro_players')
      .select('player_guid,player_name,verdict').eq('user_id', userId)
    if (result.error) throw new Error(result.error.message)
    const claims = toMap(result.data ?? [])
    cache.set(userId, { at: Date.now(), claims })
    writeLocal(`${CACHE_PREFIX}${userId}`, result.data ?? [])
    return claims
  } catch (error) {
    if (cached) return cached.claims
    // Offline: the last copy this browser saw. With none, nothing is claimed and
    // a multi-player round waits for an answer rather than guessing.
    console.warn('[GSPro players] claims not loaded; using this browser\'s copy.', error)
    return toMap(readLocal<ClaimRow[]>(`${CACHE_PREFIX}${userId}`, []))
  }
}

/** Save verdicts for players on this account. */
export const savePlayerVerdicts = async (
  userId: string,
  verdicts: readonly { player: Pick<GsproPlayer, 'key' | 'name'>; verdict: PlayerVerdict }[],
) => {
  if (verdicts.length === 0) return
  const now = new Date().toISOString()
  const rows = verdicts.map(({ player, verdict }) => ({
    user_id: userId, player_guid: player.key, player_name: player.name, verdict, updated_at: now,
  }))
  const client = await getSupabaseClient()
  const result = await client.from<unknown>('gspro_players').upsert(rows, { onConflict: 'user_id,player_guid' })
  if (result.error) throw new Error(result.error.message)
  const claims = new Map((await loadPlayerClaims(userId)) as Map<string, { verdict: PlayerVerdict; name: string | null }>)
  for (const { player, verdict } of verdicts) claims.set(player.key, { verdict, name: player.name })
  cache.set(userId, { at: Date.now(), claims })
  writeLocal(`${CACHE_PREFIX}${userId}`, [...claims.entries()].map(([key, claim]) => ({
    player_guid: key, player_name: claim.name, verdict: claim.verdict,
  })))
  announce()
}

// ---- Rounds waiting for "which one is you?" --------------------------------

export type PlayerQuestion = {
  roundId: number
  courseKey: string | null
  players: RoundPlayer[]
  askedAt: string
}

export const loadPlayerQuestions = (userId: string): PlayerQuestion[] =>
  readLocal<PlayerQuestion[]>(`${ASK_PREFIX}${userId}`, []).filter((question) => Array.isArray(question?.players))

const saveQuestions = (userId: string, questions: readonly PlayerQuestion[]) => {
  writeLocal(`${ASK_PREFIX}${userId}`, questions.slice(-10))
  announce()
}

/** Remember that this round needs an answer. Same round, same players: no change. */
export const askAboutRound = (userId: string, round: Pick<BrowserGsproCourseArchiveRound, 'roundId' | 'courseKey'>, players: readonly RoundPlayer[]) => {
  const questions = loadPlayerQuestions(userId)
  const known = questions.find((question) => question.roundId === round.roundId)
  const sameplayers = known && known.players.map((p) => p.key).join() === players.map((p) => p.key).join()
  if (sameplayers) return
  saveQuestions(userId, [
    ...questions.filter((question) => question.roundId !== round.roundId),
    { roundId: round.roundId, courseKey: round.courseKey, players: [...players], askedAt: new Date().toISOString() },
  ])
}

/**
 * The answer: `playerKey` is this account's player in that round, or null for
 * "none of these". The others in the round are marked not-mine so they aren't
 * asked about again.
 */
export const answerPlayerQuestion = async (roundId: number, playerKey: string | null) => {
  const user = await getCurrentLooperUser()
  if (!user) return
  const question = loadPlayerQuestions(user.id).find((q) => q.roundId === roundId)
  if (!question) return
  await savePlayerVerdicts(user.id, question.players.map((player) => ({
    player,
    verdict: player.key === playerKey ? 'mine' as const : 'not-mine' as const,
  })))
  saveQuestions(user.id, loadPlayerQuestions(user.id).filter((q) => q.roundId !== roundId))
}

/** Drop questions the account's claims now answer (answered in another browser, say). */
const pruneQuestions = (userId: string, claims: PlayerClaims) => {
  const questions = loadPlayerQuestions(userId)
  const open = questions.filter((question) => decideRound(question.players, claims).kind === 'ask')
  if (open.length !== questions.length) saveQuestions(userId, open)
}

/**
 * This account's part of a GSPro round, or null when it isn't theirs or is
 * waiting for "which one is you?". Saves the automatic first claim.
 */
export const myPartOfRound = async (
  round: BrowserGsproCourseArchiveRound,
): Promise<{ round: BrowserGsproCourseArchiveRound | null; waiting: boolean }> => {
  if (!isSupabaseConfigured()) return { round, waiting: false }
  const user = await getCurrentLooperUser()
  if (!user || !(await getAllowedUserRecord(user))) return { round, waiting: false }
  const claims = await loadPlayerClaims(user.id)
  pruneQuestions(user.id, claims)
  const decision = decideRound(round.players, claims)
  if (decision.kind === 'ask') {
    askAboutRound(user.id, round, decision.players)
    return { round: null, waiting: true }
  }
  if (decision.kind === 'not-mine') return { round: null, waiting: false }
  // The others in a round that is this account's: remembered as not-mine, so the account menu's
  // "Change" can list every name this account has played with.
  const others = round.players.filter((player) => player.key !== UNKNOWN && !decision.keys.has(player.key)
    && !claims.has(player.key))
  const verdicts = [
    ...(decision.claim ? [{ player: decision.claim, verdict: 'mine' as const }] : []),
    ...others.map((player) => ({ player, verdict: 'not-mine' as const })),
  ]
  if (verdicts.length) {
    await savePlayerVerdicts(user.id, verdicts).catch((error) => {
      console.warn('[GSPro players] claims not saved yet; will retry.', error)
    })
  }
  const mine = roundForPlayers(round, decision.keys)
  return { round: mine.shots.length > 0 ? mine : null, waiting: false }
}

/** The players this account has claimed, for the profile line. */
export const myGsproPlayerNames = async (): Promise<string[]> => {
  const user = await getCurrentLooperUser()
  if (!user) return []
  const claims = await loadPlayerClaims(user.id)
  return [...claims.values()].filter((claim) => claim.verdict === 'mine').flatMap((claim) => (claim.name ? [claim.name] : []))
}

/** "Not you?": forget this account's players; the next round claims or asks again. */
export const resetPlayerClaims = async () => {
  const user = await getCurrentLooperUser()
  if (!user) return
  const client = await getSupabaseClient()
  const result = await client.from<unknown>('gspro_players').delete().eq('user_id', user.id)
  if (result.error) throw new Error(result.error.message)
  cache.set(user.id, { at: Date.now(), claims: new Map() })
  writeLocal(`${CACHE_PREFIX}${user.id}`, [])
  announce()
}

/** Every GSPro player this account has seen, with whether it is theirs (account menu, "Change"). */
export const knownGsproPlayers = async (): Promise<{ key: string; name: string | null; mine: boolean }[]> => {
  const user = await getCurrentLooperUser()
  if (!user) return []
  const claims = await loadPlayerClaims(user.id)
  return [...claims.entries()]
    .filter(([key]) => !key.startsWith('name:'))
    .map(([key, claim]) => ({ key, name: claim.name, mine: claim.verdict === 'mine' }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || (a.name ?? '').localeCompare(b.name ?? ''))
}

/** "That's me": this player is the account's; every other known player is not. */
export const chooseMyGsproPlayer = async (playerKey: string) => {
  const user = await getCurrentLooperUser()
  if (!user) return
  const known = await knownGsproPlayers()
  await savePlayerVerdicts(user.id, known.map((player) => ({
    player: { key: player.key, name: player.name },
    verdict: player.key === playerKey ? 'mine' as const : 'not-mine' as const,
  })))
}
