import {
  getAllowedUserRecord,
  getCurrentLooperUser,
  getSupabaseClient,
  isSupabaseConfigured,
} from '../cloud/supabaseClient'
import {
  loadArmedLiveClub,
  LIVE_CADDIE_ARMED_CLUB_UPDATED_EVENT,
} from '../lib/liveClubAttribution'
import { loadLiveGsproRoundArchive, type ArchivedGsproCourseShot } from '../lib/liveGsproRoundArchive'
import {
  LIVE_CADDIE_LINEAGE_STORAGE_KEY,
  persistWorkingCacheValueForActiveUser,
} from '../lib/localUserScope'
import { loadSavedSessions } from '../lib/sessions'
import { buildLiveCaddieProfileSet } from './profileProvider'
import {
  LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT,
  LIVE_CADDIE_START_ROUND_EVENT,
  type LiveCaddieShotStateChangedDetail,
  type LiveCaddieStartRoundDetail,
} from './roundRuntime'

export type LiveCaddieLineageRecordType =
  | 'round'
  | 'state'
  | 'decision'
  | 'shot_spec'
  | 'shot_attempt'
  | 'shot_outcome'

export type LiveCaddieLineageRecord = {
  id: string
  lineageRoundId: string
  recordType: LiveCaddieLineageRecordType
  createdAt: string
  supersedesId: string | null
  stateId: string | null
  decisionId: string | null
  shotSpecId: string | null
  attemptId: string | null
  outcomeId: string | null
  gsproRoundId: number | null
  gsproShotId: string | null
  payload: Record<string, unknown>
}

export type LiveCaddieLineageStore = {
  version: 1
  activeRoundId: string | null
  records: LiveCaddieLineageRecord[]
}

const MAX_LOCAL_RECORDS = 4000
const ARCHIVE_RECONCILE_MS = 1000
const CLOUD_FLUSH_DELAY_MS = 250

const emptyStore = (): LiveCaddieLineageStore => ({
  version: 1,
  activeRoundId: null,
  records: [],
})

const uuid = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16)
    const value = character === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const rawSurfaceLabel = (value: number | null | undefined) => {
  switch (value) {
    case 1: return 'rough'
    case 2: return 'fairway'
    case 3: return 'sand'
    // GSPro also uses 11 for the bunker/sand state seen in live course play.
    case 11: return 'sand'
    case 5: return 'green'
    case 18: return 'tee'
    default: return null
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

export const loadLiveCaddieLineageStore = (): LiveCaddieLineageStore => {
  if (typeof window === 'undefined') return emptyStore()
  try {
    const raw = window.localStorage.getItem(LIVE_CADDIE_LINEAGE_STORAGE_KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw) as Partial<LiveCaddieLineageStore>
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) return emptyStore()
    const records = parsed.records.flatMap((record): LiveCaddieLineageRecord[] => {
      if (!record || typeof record !== 'object') return []
      const candidate = record as Partial<LiveCaddieLineageRecord>
      const payload = asRecord(candidate.payload)
      if (
        typeof candidate.id !== 'string'
        || typeof candidate.lineageRoundId !== 'string'
        || typeof candidate.recordType !== 'string'
        || typeof candidate.createdAt !== 'string'
        || !payload
      ) return []
      if (!['round', 'state', 'decision', 'shot_spec', 'shot_attempt', 'shot_outcome'].includes(candidate.recordType)) {
        return []
      }
      return [{
        id: candidate.id,
        lineageRoundId: candidate.lineageRoundId,
        recordType: candidate.recordType as LiveCaddieLineageRecordType,
        createdAt: candidate.createdAt,
        supersedesId: typeof candidate.supersedesId === 'string' ? candidate.supersedesId : null,
        stateId: typeof candidate.stateId === 'string' ? candidate.stateId : null,
        decisionId: typeof candidate.decisionId === 'string' ? candidate.decisionId : null,
        shotSpecId: typeof candidate.shotSpecId === 'string' ? candidate.shotSpecId : null,
        attemptId: typeof candidate.attemptId === 'string' ? candidate.attemptId : null,
        outcomeId: typeof candidate.outcomeId === 'string' ? candidate.outcomeId : null,
        gsproRoundId: finite(candidate.gsproRoundId) ? candidate.gsproRoundId : null,
        gsproShotId: typeof candidate.gsproShotId === 'string' ? candidate.gsproShotId : null,
        payload,
      }]
    })
    return {
      version: 1,
      activeRoundId: typeof parsed.activeRoundId === 'string' ? parsed.activeRoundId : null,
      records: records.slice(-MAX_LOCAL_RECORDS),
    }
  } catch {
    return emptyStore()
  }
}

const saveStore = (store: LiveCaddieLineageStore) => {
  if (typeof window === 'undefined') return
  if (store.records.length > MAX_LOCAL_RECORDS) {
    store.records = store.records.slice(-MAX_LOCAL_RECORDS)
  }
  const serialized = JSON.stringify(store)
  window.localStorage.setItem(LIVE_CADDIE_LINEAGE_STORAGE_KEY, serialized)
  persistWorkingCacheValueForActiveUser(LIVE_CADDIE_LINEAGE_STORAGE_KEY, serialized)
}

const newestRecord = (
  store: LiveCaddieLineageStore,
  predicate: (record: LiveCaddieLineageRecord) => boolean,
) => {
  for (let index = store.records.length - 1; index >= 0; index -= 1) {
    const record = store.records[index]
    if (predicate(record)) return record
  }
  return null
}

const activeRecords = (store: LiveCaddieLineageStore) =>
  store.activeRoundId
    ? store.records.filter((record) => record.lineageRoundId === store.activeRoundId)
    : []

const pendingCloud = new Map<string, LiveCaddieLineageRecord>()
let cloudTimer: number | null = null

const syncRecordsToCloud = async (records: readonly LiveCaddieLineageRecord[]) => {
  if (!isSupabaseConfigured() || records.length === 0) return
  const user = await getCurrentLooperUser()
  if (!user) return
  const allowed = await getAllowedUserRecord(user)
  if (!allowed) return
  const client = await getSupabaseClient()
  const result = await client.from<unknown>('live_caddie_lineage_records').upsert(
    records.map((record) => ({
      id: record.id,
      user_id: user.id,
      lineage_round_id: record.lineageRoundId,
      record_type: record.recordType,
      created_at: record.createdAt,
      supersedes_id: record.supersedesId,
      state_id: record.stateId,
      decision_id: record.decisionId,
      shot_spec_id: record.shotSpecId,
      attempt_id: record.attemptId,
      outcome_id: record.outcomeId,
      gspro_round_id: record.gsproRoundId,
      gspro_shot_id: record.gsproShotId,
      payload: record.payload,
    })),
    { onConflict: 'id' },
  )
  if (result.error) throw new Error(result.error.message)
}

const flushCloud = () => {
  cloudTimer = null
  const batch = [...pendingCloud.values()]
  if (batch.length === 0) return
  void syncRecordsToCloud(batch)
    .then(() => batch.forEach((record) => pendingCloud.delete(record.id)))
    .catch((error) => {
      console.warn('[Live Caddie lineage] cloud sync failed; local lineage retained.', error)
      if (cloudTimer == null && typeof window !== 'undefined') {
        cloudTimer = window.setTimeout(flushCloud, 5000)
      }
    })
}

const queueCloudRecord = (record: LiveCaddieLineageRecord) => {
  pendingCloud.set(record.id, record)
  if (cloudTimer == null && typeof window !== 'undefined') {
    cloudTimer = window.setTimeout(flushCloud, CLOUD_FLUSH_DELAY_MS)
  }
}

const appendRecord = (
  store: LiveCaddieLineageStore,
  input: Omit<LiveCaddieLineageRecord, 'id'> & { id?: string },
) => {
  const record: LiveCaddieLineageRecord = {
    ...input,
    id: input.id ?? uuid(),
  }
  store.records.push(record)
  saveStore(store)
  queueCloudRecord(record)
  return record
}

const createRound = (
  store: LiveCaddieLineageStore,
  createdAt: string,
  source: 'manual-start' | 'implicit-resume',
) => {
  const lineageRoundId = uuid()
  store.activeRoundId = lineageRoundId
  const baselinePhysicalKeys = loadLiveGsproRoundArchive().rounds.flatMap(
    (round) => round.shots.map((shot) => shot.key),
  )
  appendRecord(store, {
    id: lineageRoundId,
    lineageRoundId,
    recordType: 'round',
    createdAt,
    supersedesId: null,
    stateId: null,
    decisionId: null,
    shotSpecId: null,
    attemptId: null,
    outcomeId: null,
    gsproRoundId: null,
    gsproShotId: null,
    payload: {
      source,
      startedAt: createdAt,
      baselinePhysicalKeys,
    },
  })
  return lineageRoundId
}

const ensureActiveRound = (store: LiveCaddieLineageStore, createdAt = new Date().toISOString()) =>
  store.activeRoundId ?? createRound(store, createdAt, 'implicit-resume')

const readUiSurface = () => {
  if (typeof document === 'undefined') return null
  const spans = document.querySelectorAll<HTMLElement>('.live-caddie-secondary-context span')
  for (const span of spans) {
    const match = span.textContent?.trim().match(/^Shot\s+\d+\s*[·-]\s*(.+)$/i)
    if (match?.[1]) return match[1].trim().toLowerCase()
  }
  return null
}

const readUiExpectedCarry = () => {
  if (typeof document === 'undefined') return null
  const rows = document.querySelectorAll<HTMLElement>('.live-shot-stat-grid > div')
  for (const row of rows) {
    const label = row.querySelector('span')?.textContent?.trim().toLowerCase()
    if (label !== 'carry') continue
    const value = row.querySelector('strong')?.textContent?.match(/-?\d+(?:\.\d+)?/)
    if (!value) return null
    const parsed = Number(value[0])
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const readUiAimOffset = () => {
  if (typeof document === 'undefined') return null
  const text = document.querySelector<HTMLElement>('.live-aim-hero')?.textContent?.trim() ?? ''
  if (/center line/i.test(text)) return 0
  const match = text.match(/(\d+(?:\.\d+)?)\s*yd\s*(left|right)/i)
  if (!match) return null
  const yards = Number(match[1])
  if (!Number.isFinite(yards)) return null
  return match[2].toLowerCase() === 'left' ? -yards : yards
}

const profileStockCarry = (club: string | null) => {
  if (!club) return null
  const profile = buildLiveCaddieProfileSet(loadSavedSessions(), Date.now()).clubs.find(
    (candidate) => candidate.club === club,
  )
  return profile && finite(profile.stock_carry_yds) ? profile.stock_carry_yds : null
}

const decisionFingerprint = (payload: Record<string, unknown>) => JSON.stringify({
  stateId: payload.stateId,
  recommendedClub: payload.recommendedClub,
  recommendedStockCarryYds: payload.recommendedStockCarryYds,
  modeledSurface: payload.modeledSurface,
})

const handleArmedClubChanged = () => {
  // Let React finish switching the displayed evaluation when the user selects
  // an alternate club before freezing the spec snapshot.
  window.setTimeout(() => {
    const armed = loadArmedLiveClub()
    if (!armed) return
    const store = loadLiveCaddieLineageStore()
    const lineageRoundId = ensureActiveRound(store, armed.armedAt)
    const currentState = newestRecord(
      store,
      (record) => record.lineageRoundId === lineageRoundId && record.recordType === 'state',
    )
    if (!currentState) return

    const modeledSurface = readUiSurface()
    const recommendedStockCarryYds = profileStockCarry(armed.recommendedClub)
    const decisionPayload: Record<string, unknown> = {
      stateId: currentState.id,
      recommendedClub: armed.recommendedClub,
      recommendedStockCarryYds,
      modeledSurface,
      capturedAtArm: true,
    }
    const fingerprint = decisionFingerprint(decisionPayload)
    const existingDecision = newestRecord(store, (record) => (
      record.lineageRoundId === lineageRoundId
      && record.recordType === 'decision'
      && record.stateId === currentState.id
      && record.payload.fingerprint === fingerprint
    ))
    const decision = existingDecision ?? appendRecord(store, {
      lineageRoundId,
      recordType: 'decision',
      createdAt: armed.armedAt,
      supersedesId: null,
      stateId: currentState.id,
      decisionId: null,
      shotSpecId: null,
      attemptId: null,
      outcomeId: null,
      gsproRoundId: null,
      gsproShotId: null,
      payload: {
        ...decisionPayload,
        fingerprint,
      },
    })

    const priorSpec = newestRecord(store, (record) => (
      record.lineageRoundId === lineageRoundId
      && record.recordType === 'shot_spec'
      && record.stateId === currentState.id
    ))
    const modeledCarryYds = readUiExpectedCarry()
    const aimOffsetYds = readUiAimOffset()
    const stockCarryYds = profileStockCarry(armed.club)
    appendRecord(store, {
      lineageRoundId,
      recordType: 'shot_spec',
      createdAt: armed.armedAt,
      supersedesId: priorSpec?.id ?? null,
      stateId: currentState.id,
      decisionId: decision.id,
      shotSpecId: null,
      attemptId: null,
      outcomeId: null,
      gsproRoundId: null,
      gsproShotId: null,
      payload: {
        stateId: currentState.id,
        decisionId: decision.id,
        club: armed.club,
        recommendedClub: armed.recommendedClub,
        stockCarryYds,
        modeledCarryYds,
        requestedCarryYds: null,
        yardageAdjustmentYds: finite(stockCarryYds) && finite(modeledCarryYds)
          ? modeledCarryYds - stockCarryYds
          : null,
        shotMode: 'stock',
        aimOffsetYds,
        modeledSurface,
        modeledSurfaceSource: currentState.payload.surfaceSource ?? 'live-caddie',
        armedAt: armed.armedAt,
        status: 'armed',
      },
    })
  }, 0)
}

const stateForPhysicalPreShot = (
  store: LiveCaddieLineageStore,
  shot: ArchivedGsproCourseShot,
  postState: LiveCaddieLineageRecord | null,
) => {
  const active = activeRecords(store)
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const record = active[index]
    if (record.recordType !== 'state' || record.id === postState?.id) continue
    if (record.payload.holeNumber !== shot.holeNumber) continue
    if (shot.holeShot != null && record.payload.nextShotNumber !== shot.holeShot) continue
    if (postState && record.createdAt > postState.createdAt) continue
    return record
  }
  return null
}

const latestArmedSpecForState = (
  store: LiveCaddieLineageStore,
  stateId: string,
) => newestRecord(store, (record) => (
  record.lineageRoundId === store.activeRoundId
  && record.recordType === 'shot_spec'
  && record.stateId === stateId
  && record.payload.status === 'armed'
))

const createOutcome = (
  store: LiveCaddieLineageStore,
  attempt: LiveCaddieLineageRecord,
  shot: ArchivedGsproCourseShot,
  postState: LiveCaddieLineageRecord,
) => {
  const existing = newestRecord(store, (record) => (
    record.lineageRoundId === attempt.lineageRoundId
    && record.recordType === 'shot_outcome'
    && record.attemptId === attempt.id
  ))
  if (existing) return existing

  return appendRecord(store, {
    lineageRoundId: attempt.lineageRoundId,
    recordType: 'shot_outcome',
    createdAt: shot.observedAt,
    supersedesId: null,
    stateId: postState.id,
    decisionId: attempt.decisionId,
    shotSpecId: attempt.shotSpecId,
    attemptId: attempt.id,
    outcomeId: null,
    gsproRoundId: shot.roundId,
    gsproShotId: shot.shotId,
    payload: {
      attemptId: attempt.id,
      preStateId: attempt.stateId,
      postStateId: postState.id,
      carryYards: shot.carryYards,
      totalYards: shot.totalYards,
      ballSpeedMph: shot.ballSpeedMph,
      verticalLaunchAngleDegrees: shot.verticalLaunchAngleDegrees,
      horizontalLaunchAngleDegrees: shot.horizontalLaunchAngleDegrees,
      totalSpinRpm: shot.totalSpinRpm,
      spinAxisDegrees: shot.spinAxisDegrees,
      startingSurfaceRaw: shot.startingSurfaceRaw,
      startingSurface: rawSurfaceLabel(shot.startingSurfaceRaw),
      endingSurfaceRaw: shot.endingSurfaceRaw,
      endingSurface: rawSurfaceLabel(shot.endingSurfaceRaw),
      completedAt: postState.createdAt,
    },
  })
}

const processPhysicalShot = (store: LiveCaddieLineageStore, shot: ArchivedGsproCourseShot) => {
  if (!store.activeRoundId) return
  const existingAttempt = newestRecord(store, (record) => (
    record.lineageRoundId === store.activeRoundId
    && record.recordType === 'shot_attempt'
    && record.gsproRoundId === shot.roundId
    && record.gsproShotId === shot.shotId
  ))
  if (existingAttempt) {
    const postState = newestRecord(store, (record) => (
      record.lineageRoundId === store.activeRoundId
      && record.recordType === 'state'
      && record.payload.latestShotKey === shot.key
    ))
    if (postState) createOutcome(store, existingAttempt, shot, postState)
    return
  }

  let postState = newestRecord(store, (record) => (
    record.lineageRoundId === store.activeRoundId
    && record.recordType === 'state'
    && record.payload.latestShotKey === shot.key
  ))

  let preState = stateForPhysicalPreShot(store, shot, postState)
  if (!preState) {
    const inferredStateId = uuid()
    preState = appendRecord(store, {
      id: inferredStateId,
      lineageRoundId: store.activeRoundId,
      recordType: 'state',
      createdAt: shot.observedAt,
      supersedesId: null,
      stateId: inferredStateId,
      decisionId: null,
      shotSpecId: null,
      attemptId: null,
      outcomeId: null,
      gsproRoundId: shot.roundId,
      gsproShotId: null,
      payload: {
        shotStateKey: `inferred-pre:${shot.key}`,
        courseKey: shot.courseKey,
        roundId: shot.roundId,
        holeNumber: shot.holeNumber,
        nextShotNumber: shot.holeShot,
        surface: rawSurfaceLabel(shot.startingSurfaceRaw),
        surfaceSource: 'gspro-archive-starting-surface',
        distanceToPinYds: shot.distanceToPinYds,
        source: 'gspro-inferred-pre',
        latestShotKey: null,
      },
    })
  }

  const spec = latestArmedSpecForState(store, preState.id)
  const decision = spec?.decisionId
    ? store.records.find((record) => record.id === spec.decisionId) ?? null
    : null
  const priorSameSlot = newestRecord(store, (record) => (
    record.lineageRoundId === store.activeRoundId
    && record.recordType === 'shot_attempt'
    && record.payload.holeNumber === shot.holeNumber
    && record.payload.holeShot === shot.holeShot
  ))
  const attemptId = uuid()
  const actualClub = shot.actualClub
    ?? (typeof spec?.payload.club === 'string' ? spec.payload.club : null)
  const recommendedClub = shot.recommendedClub
    ?? (typeof spec?.payload.recommendedClub === 'string' ? spec.payload.recommendedClub : null)
    ?? (typeof decision?.payload.recommendedClub === 'string' ? decision.payload.recommendedClub : null)

  const attempt = appendRecord(store, {
    id: attemptId,
    lineageRoundId: store.activeRoundId,
    recordType: 'shot_attempt',
    createdAt: shot.observedAt,
    supersedesId: priorSameSlot?.id ?? null,
    stateId: preState.id,
    decisionId: decision?.id ?? null,
    shotSpecId: spec?.id ?? null,
    attemptId,
    outcomeId: null,
    gsproRoundId: shot.roundId,
    gsproShotId: shot.shotId,
    payload: {
      preStateId: preState.id,
      decisionId: decision?.id ?? null,
      shotSpecId: spec?.id ?? null,
      physicalShotKey: shot.key,
      courseKey: shot.courseKey,
      holeNumber: shot.holeNumber,
      holeShot: shot.holeShot,
      globalShotNumber: shot.globalShotNumber,
      actualClub,
      recommendedClub,
      modeledSurface: spec?.payload.modeledSurface ?? preState.payload.surface ?? null,
      modeledSurfaceSource: spec?.payload.modeledSurfaceSource ?? preState.payload.surfaceSource ?? null,
      gsproStartingSurfaceRaw: shot.startingSurfaceRaw,
      gsproStartingSurface: rawSurfaceLabel(shot.startingSurfaceRaw),
      gsproEndingSurfaceRaw: shot.endingSurfaceRaw,
      gsproEndingSurface: rawSurfaceLabel(shot.endingSurfaceRaw),
      capturedAt: shot.observedAt,
    },
  })

  postState = postState ?? newestRecord(store, (record) => (
    record.lineageRoundId === store.activeRoundId
    && record.recordType === 'state'
    && record.payload.latestShotKey === shot.key
  ))
  if (postState) createOutcome(store, attempt, shot, postState)
}

const reconcileArchive = (acceptedPhysicalKeys: Set<string>) => {
  const store = loadLiveCaddieLineageStore()
  if (!store.activeRoundId || acceptedPhysicalKeys.size === 0) return
  const archive = loadLiveGsproRoundArchive()
  for (const round of archive.rounds) {
    for (const shot of round.shots) {
      if (!acceptedPhysicalKeys.has(shot.key)) continue
      processPhysicalShot(store, shot)
    }
  }
}

export const startLiveCaddieShotLineage = () => {
  if (typeof window === 'undefined') return () => undefined
  let stopped = false
  const acceptedPhysicalKeys = new Set<string>()

  // Retry any locally durable lineage records that may have missed cloud sync
  // during a prior disconnect/reload. Upsert-by-ID keeps this idempotent.
  const existing = loadLiveCaddieLineageStore()
  existing.records.slice(-500).forEach(queueCloudRecord)

  const onStartRound = (event: Event) => {
    const detail = (event as CustomEvent<LiveCaddieStartRoundDetail>).detail
    const store = loadLiveCaddieLineageStore()
    acceptedPhysicalKeys.clear()
    createRound(store, detail?.startedAt ?? new Date().toISOString(), 'manual-start')
  }

  const onShotStateChanged = (event: Event) => {
    const detail = (event as CustomEvent<LiveCaddieShotStateChangedDetail>).detail
    if (!detail?.key) return
    const store = loadLiveCaddieLineageStore()
    const lineageRoundId = ensureActiveRound(store)
    const existingState = newestRecord(store, (record) => (
      record.lineageRoundId === lineageRoundId
      && record.recordType === 'state'
      && record.payload.shotStateKey === detail.key
    ))
    if (!existingState) {
      const stateId = uuid()
      appendRecord(store, {
        id: stateId,
        lineageRoundId,
        recordType: 'state',
        createdAt: new Date().toISOString(),
        supersedesId: null,
        stateId,
        decisionId: null,
        shotSpecId: null,
        attemptId: null,
        outcomeId: null,
        gsproRoundId: finite(detail.roundId) ? detail.roundId : null,
        gsproShotId: null,
        payload: {
          shotStateKey: detail.key,
          courseKey: detail.courseKey ?? null,
          roundId: detail.roundId ?? null,
          holeNumber: detail.holeNumber,
          nextShotNumber: detail.nextShotNumber,
          surface: detail.surface ?? (detail.nextShotNumber === 1 ? 'tee' : null),
          surfaceSource: detail.surfaceSource ?? (detail.nextShotNumber === 1 ? 'tee-invariant' : null),
          distanceToPinYds: detail.distanceToPinYds ?? null,
          ballLocalYds: detail.ballLocalYds ?? null,
          source: detail.source,
          latestShotKey: detail.latestShotKey ?? null,
        },
      })
    }
    if (detail.latestShotKey) acceptedPhysicalKeys.add(detail.latestShotKey)
    window.setTimeout(() => reconcileArchive(acceptedPhysicalKeys), 0)
  }

  window.addEventListener(LIVE_CADDIE_START_ROUND_EVENT, onStartRound)
  window.addEventListener(LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT, onShotStateChanged)
  window.addEventListener(LIVE_CADDIE_ARMED_CLUB_UPDATED_EVENT, handleArmedClubChanged)

  const timer = window.setInterval(() => {
    if (!stopped) reconcileArchive(acceptedPhysicalKeys)
  }, ARCHIVE_RECONCILE_MS)

  return () => {
    if (stopped) return
    stopped = true
    window.clearInterval(timer)
    window.removeEventListener(LIVE_CADDIE_START_ROUND_EVENT, onStartRound)
    window.removeEventListener(LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT, onShotStateChanged)
    window.removeEventListener(LIVE_CADDIE_ARMED_CLUB_UPDATED_EVENT, handleArmedClubChanged)
  }
}
