import {
  loadGsproDirectoryHandle,
  queryGsproDirectoryPermission,
  type BrowserDirectoryHandle,
} from './browserGsproAccess'
import {
  connectBrowserGsproCourseStateFolder as connectCoreGsproCourseStateFolder,
  connectToBrowserGsproCourseState as connectToCoreGsproCourseState,
  loadGsproCourseStateDirectoryHandle,
  prepareBrowserGsproCourseStateRuntime as prepareCoreGsproCourseStateRuntime,
  type BrowserGsproCourseConnection,
  type BrowserGsproCourseShot,
  type BrowserGsproCourseSnapshot as CoreBrowserGsproCourseSnapshot,
  type BrowserGsproCourseStatus,
} from './browserGsproCourseState'

export type { BrowserGsproCourseConnection, BrowserGsproCourseShot, BrowserGsproCourseStatus }

export type BrowserGsproSourceState = 'available' | 'missing' | 'invalid'

export type BrowserGsproSourceHealth = {
  state: BrowserGsproSourceState
  modifiedAt: string | null
  modifiedAgeMs: number | null
  sizeBytes: number | null
  signature: string | null
}

export type BrowserGsproLiveHealth = {
  epoch: number
  epochReason: string
  integrity: 'healthy' | 'degraded' | 'stale'
  currentRound: BrowserGsproSourceHealth
  outputLog: BrowserGsproSourceHealth & {
    fallbackActive: boolean
    fallbackExpired: boolean
    holeNumber: number | null
  }
  roundIdentity: {
    roundId: number | null
    courseKey: string | null
    holeNumber: number | null
    latestShotId: string | null
  } | null
  restartBoundaryAt: string | null
  observedAt: string
}

export type BrowserGsproCourseSnapshot = CoreBrowserGsproCourseSnapshot & {
  health: BrowserGsproLiveHealth
}

type RoundIdentity = NonNullable<BrowserGsproLiveHealth['roundIdentity']>

type RoundRecord = {
  ShotID?: unknown
  RoundID?: unknown
  Hole?: unknown
  HoleShot?: unknown
  GlobalShotNumber?: unknown
  CourseKey?: unknown
}

const CURRENT_ROUND_FILE = 'currentRound.dat'
const OUTPUT_LOG_FILE = 'output_log.txt'
const OUTPUT_LOG_TAIL_BYTES = 160_000
const HEALTH_POLL_INTERVAL_MS = 750
const OUTPUT_LOG_FALLBACK_GRACE_MS = 5_000

let preparedHealthHandle: BrowserDirectoryHandle | null = null

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const readOptionalFile = async (handle: BrowserDirectoryHandle, name: string) => {
  try {
    const fileHandle = await handle.getFileHandle(name)
    return await fileHandle.getFile()
  } catch {
    return null
  }
}

const fileHealth = (
  file: File | null,
  now: number,
  state: BrowserGsproSourceState = file ? 'available' : 'missing',
): BrowserGsproSourceHealth => ({
  state,
  modifiedAt: file ? new Date(file.lastModified).toISOString() : null,
  modifiedAgeMs: file ? Math.max(0, now - file.lastModified) : null,
  sizeBytes: file?.size ?? null,
  signature: file ? `${file.size}:${file.lastModified}` : null,
})

const parseRoundCandidates = (text: string): RoundRecord[] => {
  const parsed = JSON.parse(text) as unknown
  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>).flatMap((value) => Array.isArray(value) ? value : [])
      : []

  return candidates.flatMap((candidate): RoundRecord[] =>
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? [candidate as RoundRecord]
      : [],
  )
}

const recordSortValue = (record: RoundRecord) =>
  asNumber(record.GlobalShotNumber) ?? asNumber(record.HoleShot) ?? 0

const parseRoundIdentity = (text: string): RoundIdentity | null => {
  const records = parseRoundCandidates(text)
    .filter((record) => asString(record.ShotID) != null)
    .sort((left, right) => recordSortValue(left) - recordSortValue(right))

  const latest = records[records.length - 1]
  if (!latest) return null

  const rawHole = asNumber(latest.Hole)
  const holeNumber = rawHole == null ? null : Math.round(rawHole) + 1
  return {
    roundId: asNumber(latest.RoundID),
    courseKey: asString(latest.CourseKey),
    holeNumber: holeNumber != null && holeNumber >= 1 && holeNumber <= 18 ? holeNumber : null,
    latestShotId: asString(latest.ShotID),
  }
}

const parseOutputLogHole = (text: string) => {
  const matches = [...text.matchAll(/currentHole\s*:\s*(-?\d+)/gi)]
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const raw = Number(matches[index][1])
    if (Number.isFinite(raw) && raw >= 0 && raw < 18) return raw + 1
  }
  return null
}

const outputLogTail = async (file: File) => {
  const start = Math.max(0, file.size - OUTPUT_LOG_TAIL_BYTES)
  return file.slice(start).text()
}

const canReadCurrentRound = async (handle: BrowserDirectoryHandle) => {
  const file = await readOptionalFile(handle, CURRENT_ROUND_FILE)
  return file != null
}

const resolveHealthHandle = async () => {
  const primary = await loadGsproDirectoryHandle().catch(() => null)
  if (primary) {
    const permission = await queryGsproDirectoryPermission(primary, 'read')
    if (permission === 'granted' && await canReadCurrentRound(primary)) return primary
  }

  const stateHandle = await loadGsproCourseStateDirectoryHandle().catch(() => null)
  if (!stateHandle) return null
  const permission = await queryGsproDirectoryPermission(stateHandle, 'read')
  if (permission !== 'granted' || !await canReadCurrentRound(stateHandle)) return null
  return stateHandle
}

export const prepareBrowserGsproCourseStateRuntime = async () => {
  const prepared = await prepareCoreGsproCourseStateRuntime()
  preparedHealthHandle = prepared ? await resolveHealthHandle() : null
  return prepared
}

export const connectBrowserGsproCourseStateFolder = async () => {
  const connected = await connectCoreGsproCourseStateFolder()
  preparedHealthHandle = await resolveHealthHandle()
  return connected
}

const unknownHealth = (): BrowserGsproLiveHealth => ({
  epoch: 1,
  epochReason: 'connection-start',
  integrity: 'degraded',
  currentRound: {
    state: 'missing',
    modifiedAt: null,
    modifiedAgeMs: null,
    sizeBytes: null,
    signature: null,
  },
  outputLog: {
    state: 'missing',
    modifiedAt: null,
    modifiedAgeMs: null,
    sizeBytes: null,
    signature: null,
    fallbackActive: false,
    fallbackExpired: false,
    holeNumber: null,
  },
  roundIdentity: null,
  restartBoundaryAt: null,
  observedAt: new Date().toISOString(),
})

const healthFingerprint = (health: BrowserGsproLiveHealth) => JSON.stringify({
  epoch: health.epoch,
  integrity: health.integrity,
  roundState: health.currentRound.state,
  roundSignature: health.currentRound.signature,
  logState: health.outputLog.state,
  logSignature: health.outputLog.signature,
  logFallbackActive: health.outputLog.fallbackActive,
  logFallbackExpired: health.outputLog.fallbackExpired,
  logHole: health.outputLog.holeNumber,
  roundIdentity: health.roundIdentity,
  restartBoundaryAt: health.restartBoundaryAt,
})

const sanitizeSnapshot = (
  snapshot: CoreBrowserGsproCourseSnapshot,
  health: BrowserGsproLiveHealth,
): BrowserGsproCourseSnapshot => {
  const warnings = [...snapshot.warnings]
  const identity = health.roundIdentity

  if (health.outputLog.fallbackExpired) {
    warnings.push('output_log.txt is unavailable; expired log fallback and using currentRound.dat only.')
  } else if (health.outputLog.fallbackActive) {
    warnings.push('output_log.txt is temporarily unavailable; using a bounded recent-log fallback.')
  }

  const restartBoundaryMs = health.restartBoundaryAt
    ? new Date(health.restartBoundaryAt).getTime()
    : null
  const roundModifiedMs = health.currentRound.modifiedAt
    ? new Date(health.currentRound.modifiedAt).getTime()
    : null
  const quarantinePreRestartRound =
    restartBoundaryMs != null
    && roundModifiedMs != null
    && roundModifiedMs < restartBoundaryMs
    && health.outputLog.holeNumber == null

  if (quarantinePreRestartRound) {
    warnings.push('GSPro restart/log reset detected; quarantining pre-restart currentRound state until a fresh hole or shot appears.')
    return {
      ...snapshot,
      holeNumber: null,
      ballLocalYds: null,
      ballSource: 'unavailable',
      surface: null,
      surfaceSource: 'unavailable',
      distanceToPinYds: null,
      latestShot: null,
      latestShotKey: null,
      warnings,
      health: { ...health, integrity: 'stale' },
    }
  }

  if (
    health.outputLog.fallbackExpired
    && identity?.holeNumber != null
    && snapshot.holeNumber !== identity.holeNumber
  ) {
    const shotMatchesRoundHole = snapshot.latestShot?.holeNumber === identity.holeNumber
    warnings.push(
      `Ignoring stale output_log hole state; currentRound.dat says Hole ${identity.holeNumber}.`,
    )
    return {
      ...snapshot,
      holeNumber: identity.holeNumber,
      ballLocalYds: shotMatchesRoundHole ? snapshot.latestShot?.endLocalYds ?? null : null,
      ballSource: shotMatchesRoundHole && snapshot.latestShot?.endLocalYds ? 'currentRound' : 'unavailable',
      surface: shotMatchesRoundHole ? snapshot.latestShot?.endingSurface ?? null : null,
      surfaceSource: shotMatchesRoundHole && snapshot.latestShot?.endingSurface ? 'currentRound' : 'unavailable',
      distanceToPinYds: shotMatchesRoundHole ? snapshot.latestShot?.distanceToPinYds ?? null : null,
      warnings,
      health: { ...health, integrity: 'degraded' },
    }
  }

  return {
    ...snapshot,
    warnings,
    health,
  }
}

export const connectToBrowserGsproCourseState = ({
  onSnapshot,
  onStatusChange,
  onError,
}: {
  onSnapshot: (snapshot: BrowserGsproCourseSnapshot) => void
  onStatusChange?: (status: BrowserGsproCourseStatus) => void
  onError?: (error: unknown) => void
}): BrowserGsproCourseConnection => {
  let disconnected = false
  let healthBusy = false
  let health = unknownHealth()
  let healthHandle = preparedHealthHandle
  let lastCoreSnapshot: CoreBrowserGsproCourseSnapshot | null = null
  let lastHealthFingerprint = healthFingerprint(health)
  let epoch = 1
  let epochReason = 'connection-start'
  let previousRoundIdentityKey: string | null = null
  let previousLogSize: number | null = null
  let previousLogModified: number | null = null
  let lastLogSeenAt: number | null = null
  let restartBoundaryAt: number | null = null

  const emit = () => {
    if (disconnected || !lastCoreSnapshot) return
    onSnapshot(sanitizeSnapshot(lastCoreSnapshot, health))
  }

  const advanceEpoch = (reason: string, now: number) => {
    epoch += 1
    epochReason = reason
    if (reason.startsWith('output-log-')) restartBoundaryAt = now
    console.info('[GSPro Live] source epoch advanced', { epoch, reason })
  }

  const pollHealth = async () => {
    if (!healthHandle) healthHandle = await resolveHealthHandle()
    if (!healthHandle) return

    const now = Date.now()
    const [roundFile, logFile] = await Promise.all([
      readOptionalFile(healthHandle, CURRENT_ROUND_FILE),
      readOptionalFile(healthHandle, OUTPUT_LOG_FILE),
    ])

    let roundIdentity: RoundIdentity | null = null
    let roundState: BrowserGsproSourceState = roundFile ? 'available' : 'missing'
    if (roundFile) {
      try {
        roundIdentity = parseRoundIdentity(await roundFile.text())
      } catch {
        roundState = 'invalid'
      }
    }

    let logHole: number | null = null
    let logState: BrowserGsproSourceState = logFile ? 'available' : 'missing'
    if (logFile) {
      try {
        logHole = parseOutputLogHole(await outputLogTail(logFile))
      } catch {
        logState = 'invalid'
      }
    }

    const roundIdentityKey = roundIdentity
      ? `${roundIdentity.roundId ?? 'round'}:${roundIdentity.courseKey ?? 'course'}`
      : null
    if (
      previousRoundIdentityKey != null
      && roundIdentityKey != null
      && roundIdentityKey !== previousRoundIdentityKey
    ) {
      advanceEpoch('current-round-identity-change', now)
      restartBoundaryAt = null
    }
    previousRoundIdentityKey = roundIdentityKey ?? previousRoundIdentityKey

    if (logFile) {
      const logReset =
        previousLogSize != null
        && previousLogModified != null
        && (logFile.size < previousLogSize || logFile.lastModified < previousLogModified)
      const logRecreatedAfterGap =
        lastLogSeenAt != null
        && now - lastLogSeenAt > OUTPUT_LOG_FALLBACK_GRACE_MS
        && previousLogModified != null
        && logFile.lastModified > previousLogModified

      if (logReset) advanceEpoch('output-log-reset', now)
      else if (logRecreatedAfterGap) advanceEpoch('output-log-recreated', now)

      previousLogSize = logFile.size
      previousLogModified = logFile.lastModified
      lastLogSeenAt = now
    }

    const logMissingForMs = logFile
      ? 0
      : lastLogSeenAt == null
        ? Number.POSITIVE_INFINITY
        : now - lastLogSeenAt
    const fallbackActive = !logFile && logMissingForMs <= OUTPUT_LOG_FALLBACK_GRACE_MS
    const fallbackExpired = !logFile && !fallbackActive

    const currentRoundHealth = fileHealth(roundFile, now, roundState)
    const outputLogHealth = {
      ...fileHealth(logFile, now, logState),
      fallbackActive,
      fallbackExpired,
      holeNumber: logHole,
    }

    const restartBoundaryIso = restartBoundaryAt == null
      ? null
      : new Date(restartBoundaryAt).toISOString()
    const roundModifiedMs = roundFile?.lastModified ?? null
    const preRestartRound =
      restartBoundaryAt != null
      && roundModifiedMs != null
      && roundModifiedMs < restartBoundaryAt
      && logHole == null

    const integrity: BrowserGsproLiveHealth['integrity'] =
      roundState !== 'available' || preRestartRound
        ? 'stale'
        : fallbackExpired || logState === 'invalid'
          ? 'degraded'
          : 'healthy'

    const nextHealth: BrowserGsproLiveHealth = {
      epoch,
      epochReason,
      integrity,
      currentRound: currentRoundHealth,
      outputLog: outputLogHealth,
      roundIdentity,
      restartBoundaryAt: restartBoundaryIso,
      observedAt: new Date(now).toISOString(),
    }

    const nextFingerprint = healthFingerprint(nextHealth)
    const changed = nextFingerprint !== lastHealthFingerprint
    health = nextHealth
    if (changed) {
      lastHealthFingerprint = nextFingerprint
      if (health.integrity !== 'healthy') {
        console.warn('[GSPro Live] source health degraded', health)
      }
      emit()
    }
  }

  const runHealthPoll = () => {
    if (disconnected || healthBusy) return
    healthBusy = true
    void pollHealth()
      .catch((error) => console.warn('[GSPro Live] health poll failed; core watcher remains active', error))
      .finally(() => {
        healthBusy = false
      })
  }

  runHealthPoll()
  const healthTimer = window.setInterval(runHealthPoll, HEALTH_POLL_INTERVAL_MS)

  const coreConnection = connectToCoreGsproCourseState({
    onStatusChange,
    onError,
    onSnapshot: (snapshot) => {
      lastCoreSnapshot = snapshot
      emit()
    },
  })

  return {
    disconnect: () => {
      if (disconnected) return
      disconnected = true
      window.clearInterval(healthTimer)
      coreConnection.disconnect()
    },
  }
}
