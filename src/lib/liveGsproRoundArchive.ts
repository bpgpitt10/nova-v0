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
import type { Club } from './bagConfig'
import {
  clearArmedLiveClub,
  inferClubForGsproShot,
  loadArmedLiveClub,
  type ClubInferenceResult,
} from './liveClubAttribution'
import {
  LIVE_GSPRO_ROUND_ARCHIVE_STORAGE_KEY,
  persistWorkingCacheValueForActiveUser,
} from './localUserScope'
import {
  loadSavedSessions,
  saveSessionHistory,
} from './sessions'
import type { SavedSession, Shot } from '../types'

export type ArchivedGsproCourseShot = BrowserGsproCourseArchiveShot & {
  observedAt: string
  actualClub: Club | null
  clubSource: 'user' | null
  includeInAnalysis: boolean
  attributedAt: string | null
  clubInference: ClubInferenceResult | null
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
const ARMED_CLUB_MAX_AGE_MS = 30 * 60 * 1000

const emptyArchive = (): LiveGsproRoundArchiveState => ({
  version: 1,
  rounds: [],
})

const shotOrder = (left: BrowserGsproCourseArchiveShot, right: BrowserGsproCourseArchiveShot) => {
  const globalDelta = (left.globalShotNumber ?? Number.MAX_SAFE_INTEGER)
    - (right.globalShotNumber ?? Number.MAX_SAFE_INTEGER)
  if (globalDelta !== 0) return globalDelta
  const holeDelta = left.holeNumber - right.holeNumber
  if (holeDelta !== 0) return holeDelta
  return (left.holeShot ?? Number.MAX_SAFE_INTEGER) - (right.holeShot ?? Number.MAX_SAFE_INTEGER)
}

const rawShotPayload = (
  shot: BrowserGsproCourseArchiveShot | ArchivedGsproCourseShot,
): BrowserGsproCourseArchiveShot => ({
  key: shot.key,
  roundId: shot.roundId,
  holeNumber: shot.holeNumber,
  holeShot: shot.holeShot,
  globalShotNumber: shot.globalShotNumber,
  shotId: shot.shotId,
  courseKey: shot.courseKey,
  startingSurfaceRaw: shot.startingSurfaceRaw,
  endingSurfaceRaw: shot.endingSurfaceRaw,
  distanceToPinYds: shot.distanceToPinYds,
  ballSpeedMph: shot.ballSpeedMph,
  carryYards: shot.carryYards,
  totalYards: shot.totalYards,
  verticalLaunchAngleDegrees: shot.verticalLaunchAngleDegrees,
  horizontalLaunchAngleDegrees: shot.horizontalLaunchAngleDegrees,
  totalSpinRpm: shot.totalSpinRpm,
  spinAxisDegrees: shot.spinAxisDegrees,
  backSpinRpm: shot.backSpinRpm,
  sideSpinRpm: shot.sideSpinRpm,
  gsproClubIndex: shot.gsproClubIndex,
  rawMetrics: shot.rawMetrics,
})

const shotPayloadFingerprint = (
  shot: BrowserGsproCourseArchiveShot | ArchivedGsproCourseShot,
) => JSON.stringify(rawShotPayload(shot))

const normalizeArchivedShot = (shot: ArchivedGsproCourseShot): ArchivedGsproCourseShot => ({
  ...shot,
  actualClub: typeof shot.actualClub === 'string' ? shot.actualClub as Club : null,
  clubSource: shot.clubSource === 'user' ? 'user' : null,
  includeInAnalysis: shot.includeInAnalysis === true,
  attributedAt: typeof shot.attributedAt === 'string' ? shot.attributedAt : null,
  clubInference: shot.clubInference && typeof shot.clubInference === 'object'
    ? shot.clubInference
    : null,
})

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
        .map((round) => ({
          ...round,
          shots: round.shots.map(normalizeArchivedShot),
        }))
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

const archivedFromIncoming = (
  incoming: BrowserGsproCourseArchiveShot,
  observedAt: string,
  prior: ArchivedGsproCourseShot | undefined,
): ArchivedGsproCourseShot => ({
  ...incoming,
  observedAt: prior?.observedAt ?? observedAt,
  actualClub: prior?.actualClub ?? null,
  clubSource: prior?.clubSource ?? null,
  includeInAnalysis: prior?.includeInAnalysis ?? false,
  attributedAt: prior?.attributedAt ?? null,
  clubInference: prior?.clubInference ?? null,
})

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
      existingByKey.set(incoming.key, archivedFromIncoming(incoming, observedAt, prior))
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

const replaceRoundInArchive = (round: ArchivedGsproRound) => {
  const state = loadLiveGsproRoundArchive()
  const existingIndex = state.rounds.findIndex((candidate) => candidate.roundId === round.roundId)
  const rounds = existingIndex >= 0
    ? state.rounds.map((candidate, index) => index === existingIndex ? round : candidate)
    : [round, ...state.rounds]
  rounds.sort((left, right) => right.lastObservedAt.localeCompare(left.lastObservedAt))
  saveLiveGsproRoundArchive({
    version: 1,
    rounds: rounds.slice(0, MAX_ARCHIVED_ROUNDS),
  })
}

const isFreshArmedSelection = (armedAt: string, observedAt: string) => {
  const armedMs = Date.parse(armedAt)
  const observedMs = Date.parse(observedAt)
  if (!Number.isFinite(armedMs) || !Number.isFinite(observedMs)) return false
  return observedMs >= armedMs && observedMs - armedMs <= ARMED_CLUB_MAX_AGE_MS
}

const toPlayerModelShot = (round: ArchivedGsproRound, shot: ArchivedGsproCourseShot): Shot | null => {
  if (!shot.actualClub || !shot.includeInAnalysis) return null
  return {
    id: `gspro-live:${round.roundId}:${shot.shotId}`,
    club: shot.actualClub,
    included: true,
    capturedAt: shot.observedAt,
    enrichmentStatus: 'enriched',
    ballSpeedMph: shot.ballSpeedMph ?? undefined,
    carryYards: shot.carryYards ?? undefined,
    totalYards: shot.totalYards ?? undefined,
    verticalLaunchAngleDegrees: shot.verticalLaunchAngleDegrees ?? undefined,
    horizontalLaunchAngleDegrees: shot.horizontalLaunchAngleDegrees ?? undefined,
    totalSpinRpm: shot.totalSpinRpm ?? undefined,
    spinAxisDegrees: shot.spinAxisDegrees ?? undefined,
    backSpin: shot.backSpinRpm ?? undefined,
    sideSpin: shot.sideSpinRpm ?? undefined,
    openGolfCoach: {
      live_course_archive: {
        gspro_round_id: round.roundId,
        shot_id: shot.shotId,
        course_key: shot.courseKey ?? round.courseKey,
        hole_number: shot.holeNumber,
        hole_shot: shot.holeShot,
        club_source: shot.clubSource,
        inferred_club: shot.clubInference?.predictedClub ?? null,
        inference_confidence: shot.clubInference?.confidence ?? null,
        inference_model_version: shot.clubInference?.modelVersion ?? null,
      },
    },
    source: 'simread',
  }
}

const promoteAttributedRoundToPlayerHistory = (round: ArchivedGsproRound) => {
  const promotedShots = round.shots.flatMap((shot) => {
    const promoted = toPlayerModelShot(round, shot)
    return promoted ? [promoted] : []
  })
  if (promotedShots.length === 0) return

  const sessions = loadSavedSessions()
  const sessionId = `gspro-live-round-${round.roundId}`
  const existingIndex = sessions.findIndex((session) => session.id === sessionId)
  const existing = existingIndex >= 0 ? sessions[existingIndex] : null
  const byId = new Map(existing?.shots.map((shot) => [shot.id, shot]) ?? [])
  promotedShots.forEach((shot) => byId.set(shot.id, shot))

  const nextSession: SavedSession = {
    id: sessionId,
    startedAt: existing?.startedAt ?? round.firstObservedAt,
    endedAt: round.lastObservedAt,
    shots: [...byId.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)),
    metadata: {
      app: 'nova-validation',
      schemaVersion: 1,
      source: 'gspro',
      includeInAnalysis: true,
    },
  }

  const nextSessions = existingIndex >= 0
    ? sessions.map((session, index) => index === existingIndex ? nextSession : session)
    : [nextSession, ...sessions]
  saveSessionHistory(nextSessions)
}

const annotateNewShots = ({
  round,
  newShots,
  observedAt,
}: {
  round: ArchivedGsproRound
  newShots: readonly BrowserGsproCourseArchiveShot[]
  observedAt: string
}): { round: ArchivedGsproRound; changed: boolean; consumedArmedClub: boolean } => {
  if (newShots.length === 0) return { round, changed: false, consumedArmedClub: false }

  const sessions = loadSavedSessions()
  const armed = loadArmedLiveClub()
  const usableArmed = armed && isFreshArmedSelection(armed.armedAt, observedAt) ? armed : null
  if (armed && !usableArmed) clearArmedLiveClub()

  const orderedNewKeys = new Set([...newShots].sort(shotOrder).map((shot) => shot.key))
  let mayConsumeArm = Boolean(usableArmed)
  let consumedArmedClub = false
  let changed = false

  const shots = round.shots.map((archived) => {
    if (!orderedNewKeys.has(archived.key)) return archived
    const raw = rawShotPayload(archived)
    const inference = inferClubForGsproShot(sessions, raw, observedAt)
    const shouldApplyArm = mayConsumeArm && usableArmed != null
    if (shouldApplyArm) {
      mayConsumeArm = false
      consumedArmedClub = true
    }

    const next: ArchivedGsproCourseShot = {
      ...archived,
      clubInference: inference,
      ...(shouldApplyArm ? {
        actualClub: usableArmed.club,
        clubSource: 'user' as const,
        includeInAnalysis: true,
        attributedAt: observedAt,
      } : {}),
    }
    if (JSON.stringify(next) !== JSON.stringify(archived)) changed = true
    return next
  })

  const annotated = changed ? { ...round, shots } : round
  if (changed) replaceRoundInArchive(annotated)
  if (consumedArmedClub) clearArmedLiveClub()
  return { round: annotated, changed, consumedArmedClub }
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
      actual_club: shot.actualClub,
      club_source: shot.clubSource,
      include_in_analysis: shot.includeInAnalysis,
      attributed_at: shot.attributedAt,
      inferred_club: shot.clubInference?.predictedClub ?? null,
      inference_confidence: shot.clubInference?.confidence ?? null,
      inference_alternatives: shot.clubInference?.alternatives ?? [],
      inference_model_version: shot.clubInference?.modelVersion ?? null,
      inference_evaluated_at: shot.clubInference?.evaluatedAt ?? null,
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

  const before = loadLiveGsproRoundArchive().rounds.find(
    (round) => round.roundId === currentRound.roundId,
  )
  const knownKeys = new Set(before?.shots.map((shot) => shot.key) ?? [])
  const newShots = currentRound.shots.filter((shot) => !knownKeys.has(shot.key))

  const result = upsertLiveGsproRoundArchive({
    roundId: currentRound.roundId,
    courseKey: currentRound.courseKey,
    shots: currentRound.shots,
    observedAt,
  })
  if (!result.round) return null

  const annotated = annotateNewShots({
    round: result.round,
    newShots,
    observedAt,
  })
  const finalRound = annotated.round

  if (annotated.consumedArmedClub) {
    promoteAttributedRoundToPlayerHistory(finalRound)
  }

  if (result.changed || annotated.changed) {
    await syncRoundToCloud(finalRound).catch((error) => {
      console.warn('[GSPro course archive] cloud sync failed; local archive retained.', error)
    })
  }

  return finalRound
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
