import {
  readBrowserGsproCourseRoundArchive,
  type BrowserGsproCourseArchiveShot,
} from '../adapters/browserGsproCourseArchive'
import {
  getAllowedUserRecord,
  getCurrentLooperUser,
  getSupabaseClient,
  isSupabaseConfigured,
} from '../cloud/supabaseClient'
import {
  LIVE_GSPRO_ROUND_ARCHIVE_STORAGE_KEY,
  persistWorkingCacheValueForActiveUser,
} from './localUserScope'

export type ArchivedGsproCourseShot = BrowserGsproCourseArchiveShot & {
  observedAt: string
}

export type ArchivedGsproRound = {
  id: string
  roundId: number
  courseKey: string | null
  firstObservedAt: string
  lastObservedAt: string
  shots: ArchivedGsproCourseShot[]
  schemaVersion: 1
}

export type LiveGsproRoundArchiveState = {
  version: 1
  rounds: ArchivedGsproRound[]
}

const MAX_ARCHIVED_ROUNDS = 20
const ARCHIVE_POLL_INTERVAL_MS = 3000

const emptyArchive = (): LiveGsproRoundArchiveState => ({
  version: 1,
  rounds: [],
})

const shotOrder = (left: ArchivedGsproCourseShot, right: ArchivedGsproCourseShot) => {
  const globalDelta = (left.globalShotNumber ?? Number.MAX_SAFE_INTEGER)
    - (right.globalShotNumber ?? Number.MAX_SAFE_INTEGER)
  if (globalDelta !== 0) return globalDelta
  const holeDelta = left.holeNumber - right.holeNumber
  if (holeDelta !== 0) return holeDelta
  return (left.holeShot ?? Number.MAX_SAFE_INTEGER) - (right.holeShot ?? Number.MAX_SAFE_INTEGER)
}

const shotPayloadFingerprint = (
  shot: BrowserGsproCourseArchiveShot | ArchivedGsproCourseShot,
) => {
  const { observedAt: _observedAt, ...payload } = shot as ArchivedGsproCourseShot
  return JSON.stringify(payload)
}

export const loadLiveGsproRoundArchive = (): LiveGsproRoundArchiveState => {
  if (typeof window === 'undefined') return emptyArchive()
  try {
    const raw = window.localStorage.getItem(LIVE_GSPRO_ROUND_ARCHIVE_STORAGE_KEY)
    if (!raw) return emptyArchive()
    const parsed = JSON.parse(raw) as Partial<LiveGsproRoundArchiveState>
    if (parsed.version !== 1 || !Array.isArray(parsed.rounds)) return emptyArchive()
    return {
      version: 1,
      rounds: parsed.rounds
        .filter((round): round is ArchivedGsproRound => (
          Boolean(round)
          && typeof round.roundId === 'number'
          && Number.isFinite(round.roundId)
          && Array.isArray(round.shots)
        ))
        .slice(0, MAX_ARCHIVED_ROUNDS),
    }
  } catch {
    return emptyArchive()
  }
}

const saveLiveGsproRoundArchive = (state: LiveGsproRoundArchiveState) => {
  if (typeof window === 'undefined') return
  const serialized = JSON.stringify(state)
  try {
    window.localStorage.setItem(LIVE_GSPRO_ROUND_ARCHIVE_STORAGE_KEY, serialized)
    persistWorkingCacheValueForActiveUser(LIVE_GSPRO_ROUND_ARCHIVE_STORAGE_KEY, serialized)
  } catch (error) {
    // The cloud archive is authoritative long-term. A browser quota failure must
    // not prevent the current round from continuing to sync to Supabase.
    console.warn('[GSPro course archive] local safety cache could not be updated.', error)
  }
}

export const upsertLiveGsproRoundArchive = ({
  roundId,
  courseKey,
  shots,
  observedAt,
}: {
  roundId: number | null
  courseKey: string | null
  shots: readonly BrowserGsproCourseArchiveShot[]
  observedAt: string
}): { round: ArchivedGsproRound | null; changed: boolean } => {
  if (roundId == null || !Number.isFinite(roundId) || shots.length === 0) {
    return { round: null, changed: false }
  }

  const state = loadLiveGsproRoundArchive()
  const existingIndex = state.rounds.findIndex((round) => round.roundId === roundId)
  const existing = existingIndex >= 0 ? state.rounds[existingIndex] : null
  const existingByKey = new Map(existing?.shots.map((shot) => [shot.key, shot]) ?? [])
  let changed = existing == null || (courseKey != null && courseKey !== existing?.courseKey)

  for (const incoming of shots) {
    const prior = existingByKey.get(incoming.key)
    if (!prior || shotPayloadFingerprint(prior) !== shotPayloadFingerprint(incoming)) {
      existingByKey.set(incoming.key, {
        ...incoming,
        observedAt: prior?.observedAt ?? observedAt,
      })
      changed = true
    }
  }

  if (!changed && existing) {
    return { round: existing, changed: false }
  }

  const round: ArchivedGsproRound = {
    id: `gspro-course-round-${roundId}`,
    roundId,
    courseKey: courseKey ?? existing?.courseKey ?? null,
    firstObservedAt: existing?.firstObservedAt ?? observedAt,
    lastObservedAt: observedAt,
    shots: [...existingByKey.values()].sort(shotOrder),
    schemaVersion: 1,
  }

  const rounds = existingIndex >= 0
    ? state.rounds.map((candidate, index) => index === existingIndex ? round : candidate)
    : [round, ...state.rounds]

  rounds.sort((left, right) => right.lastObservedAt.localeCompare(left.lastObservedAt))
  saveLiveGsproRoundArchive({
    version: 1,
    rounds: rounds.slice(0, MAX_ARCHIVED_ROUNDS),
  })

  return { round, changed: true }
}

const syncRoundToCloud = async (round: ArchivedGsproRound) => {
  if (!isSupabaseConfigured()) return

  const user = await getCurrentLooperUser()
  if (!user) return
  const allowed = await getAllowedUserRecord(user)
  if (!allowed) return

  const client = await getSupabaseClient()
  const roundResult = await client.from<unknown>('live_course_rounds').upsert(
    {
      user_id: user.id,
      gspro_round_id: round.roundId,
      course_key: round.courseKey,
      first_observed_at: round.firstObservedAt,
      last_observed_at: round.lastObservedAt,
      shot_count: round.shots.length,
      schema_version: round.schemaVersion,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,gspro_round_id' },
  )
  if (roundResult.error) throw new Error(roundResult.error.message)

  if (round.shots.length === 0) return
  const shotResult = await client.from<unknown>('live_course_shots').upsert(
    round.shots.map((shot) => ({
      user_id: user.id,
      gspro_round_id: round.roundId,
      shot_id: shot.shotId,
      course_key: shot.courseKey ?? round.courseKey,
      hole_number: shot.holeNumber,
      hole_shot: shot.holeShot,
      global_shot_number: shot.globalShotNumber,
      observed_at: shot.observedAt,
      starting_surface_raw: shot.startingSurfaceRaw,
      ending_surface_raw: shot.endingSurfaceRaw,
      distance_to_pin_yards: shot.distanceToPinYds,
      ball_speed_mph: shot.ballSpeedMph,
      carry_yards: shot.carryYards,
      total_yards: shot.totalYards,
      vertical_launch_angle_degrees: shot.verticalLaunchAngleDegrees,
      horizontal_launch_angle_degrees: shot.horizontalLaunchAngleDegrees,
      total_spin_rpm: shot.totalSpinRpm,
      spin_axis_degrees: shot.spinAxisDegrees,
      back_spin_rpm: shot.backSpinRpm,
      side_spin_rpm: shot.sideSpinRpm,
      gspro_club_index: shot.gsproClubIndex,
      raw_metrics: shot.rawMetrics,
      actual_club: null,
      club_source: null,
      include_in_analysis: false,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: 'user_id,gspro_round_id,shot_id' },
  )
  if (shotResult.error) throw new Error(shotResult.error.message)
}

export const captureAndPersistLiveGsproCourseRound = async (
  observedAt = new Date().toISOString(),
) => {
  const currentRound = await readBrowserGsproCourseRoundArchive()
  if (!currentRound) return null

  const result = upsertLiveGsproRoundArchive({
    roundId: currentRound.roundId,
    courseKey: currentRound.courseKey,
    shots: currentRound.shots,
    observedAt,
  })

  if (result.changed && result.round) {
    await syncRoundToCloud(result.round).catch((error) => {
      console.warn('[GSPro course archive] cloud sync failed; local archive retained.', error)
    })
  }

  return result.round
}

export const startLiveGsproCourseRoundArchiver = () => {
  let stopped = false
  let busy = false

  const poll = () => {
    if (stopped || busy) return
    busy = true
    void captureAndPersistLiveGsproCourseRound()
      .catch((error) => {
        console.warn('[GSPro course archive] capture attempt failed; will retry.', error)
      })
      .finally(() => {
        busy = false
      })
  }

  poll()
  const timer = window.setInterval(poll, ARCHIVE_POLL_INTERVAL_MS)

  return () => {
    if (stopped) return
    stopped = true
    window.clearInterval(timer)
  }
}
