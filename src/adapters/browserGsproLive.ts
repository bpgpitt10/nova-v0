import type {
  SimReadFinalShotEvent,
  SimReadResolvedShot,
  SimReadResolvedShotFieldSource,
} from './simreadFinalShot'
import {
  isBrowserGsproAccessSupported,
  loadGsproDirectoryHandle,
  queryGsproDirectoryPermission,
  readGsproDatabaseState,
  readLatestGsproRangeShot,
  type BrowserDirectoryHandle,
  type BrowserGsproLatestShot,
} from './browserGsproAccess'

type ShotDataObject = Record<string, unknown>

type BrowserGsproStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'waiting'
  | 'received-shot'
  | 'error'
  | 'disconnected'

type ConnectToBrowserGsproOptions = {
  onFinalShot: (event: SimReadFinalShotEvent) => void
  onStatusChange?: (status: BrowserGsproStatus) => void
  onError?: (error: unknown) => void
}

export type BrowserGsproLiveConnection = {
  mode: 'simread'
  disconnect: () => void
}

type AmbiguousClubField = 'clubPath' | 'clubAoa' | 'faceToTarget' | 'faceToPath'

type ResolvedClubField = {
  value?: number
  source: SimReadResolvedShotFieldSource
}

const POLL_INTERVAL_MS = 500
const ERROR_REPORT_THRESHOLD = 5

let preparedDirectoryHandle: BrowserDirectoryHandle | null = null

const toNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

const toStringValue = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

const firstNumber = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = toNumber(value)
    if (parsed !== undefined) {
      return parsed
    }
  }
  return undefined
}

const deriveTotalSpin = (shotData: ShotDataObject) => {
  const direct = firstNumber(shotData.TotalSpin, shotData.Spin)
  if (direct !== undefined) {
    return { value: direct, derived: false }
  }

  const backSpin = toNumber(shotData.BackSpin)
  const sideSpin = toNumber(shotData.SideSpin)
  if (backSpin === undefined || sideSpin === undefined) {
    return { value: undefined, derived: false }
  }

  return {
    value: Math.round(Math.sqrt(backSpin ** 2 + sideSpin ** 2) * 100) / 100,
    derived: true,
  }
}

const resolveClubField = (
  rawValue: unknown,
  field: AmbiguousClubField,
  knownSupportedFields: Set<AmbiguousClubField>,
): ResolvedClubField => {
  const value = toNumber(rawValue)
  if (value === undefined) {
    return { value: undefined, source: 'missing' }
  }

  if (value !== 0) {
    knownSupportedFields.add(field)
    return { value, source: 'gspro' }
  }

  // GSPro does not expose a separate measured/not-measured flag for these club
  // angles. Until this exact field has produced a non-zero value in the current
  // connection, a literal zero is preserved but marked ambiguous so OGC may fill
  // the canonical value without destroying the raw GSPro record.
  return {
    value,
    source: knownSupportedFields.has(field) ? 'gspro' : 'ambiguous',
  }
}

const buildResolvedShot = (
  shotData: ShotDataObject,
  knownSupportedClubFields: Set<AmbiguousClubField>,
): SimReadResolvedShot => {
  const carry = firstNumber(shotData.Carry, shotData.rawCarryGame, shotData.rawCarryLM)
  const totalDistance = toNumber(shotData.TotalDistance)
  const offline = toNumber(shotData.Offline)
  const ballSpeed = toNumber(shotData.BallSpeed)
  const vla = toNumber(shotData.VLA)
  const hla = toNumber(shotData.HLA)
  const spinAxis = firstNumber(shotData.rawSpinAxis, shotData.SpinAxis)
  const peakHeight = toNumber(shotData.PeakHeight)
  const descentAngle = firstNumber(shotData.Decent, shotData.Descent)
  const totalSpin = deriveTotalSpin(shotData)
  const clubSpeed = toNumber(shotData.ClubSpeed)
  const smashFactor = toNumber(shotData.SmashFactor)
  const clubPath = resolveClubField(
    shotData.Path,
    'clubPath',
    knownSupportedClubFields,
  )
  const clubAoa = resolveClubField(
    shotData.AoA,
    'clubAoa',
    knownSupportedClubFields,
  )
  const faceToTarget = resolveClubField(
    shotData.FaceToTarget,
    'faceToTarget',
    knownSupportedClubFields,
  )
  const faceToPath = resolveClubField(
    shotData.FaceToPath,
    'faceToPath',
    knownSupportedClubFields,
  )

  return {
    club: toStringValue(shotData.club),
    carry,
    carrySource: carry !== undefined ? 'gspro' : undefined,
    totalDistance,
    totalDistanceSource: totalDistance !== undefined ? 'gspro' : undefined,
    offline,
    offlineSource: offline !== undefined ? 'gspro' : undefined,
    ballSpeed,
    ballSpeedSource: ballSpeed !== undefined ? 'gspro' : undefined,
    vla,
    vlaSource: vla !== undefined ? 'gspro' : undefined,
    hla,
    hlaSource: hla !== undefined ? 'gspro' : undefined,
    spin: totalSpin.value,
    spinSource:
      totalSpin.value === undefined ? undefined : totalSpin.derived ? 'derived' : 'gspro',
    spinAxis,
    spinAxisSource: spinAxis !== undefined ? 'gspro' : undefined,
    peakHeight,
    peakHeightSource: peakHeight !== undefined ? 'gspro' : undefined,
    descentAngle,
    descentAngleSource: descentAngle !== undefined ? 'gspro' : undefined,
    backSpin: toNumber(shotData.BackSpin),
    sideSpin: toNumber(shotData.SideSpin),
    clubSpeed,
    clubSpeedSource:
      clubSpeed !== undefined && clubSpeed > 0 ? 'gspro' : 'missing',
    clubPath: clubPath.value,
    clubPathSource: clubPath.source,
    clubAoa: clubAoa.value,
    clubAoaSource: clubAoa.source,
    faceToTarget: faceToTarget.value,
    faceToTargetSource: faceToTarget.source,
    faceToPath: faceToPath.value,
    faceToPathSource: faceToPath.source,
    clubLie: toNumber(shotData.Lie),
    clubLoft: toNumber(shotData.Loft),
    dynamicLoft: toNumber(shotData.DynamicLoft),
    closureRate: toNumber(shotData.CR),
    clubFaceHImpact: toNumber(shotData.HI),
    clubFaceVImpact: toNumber(shotData.VI),
    smashFactor,
    smashFactorSource:
      smashFactor !== undefined && smashFactor > 0 ? 'gspro' : 'missing',
    distToPin: toNumber(shotData.DistanceToPin),
    distanceToPin: toNumber(shotData.DistanceToPin),
    shotName: toStringValue(shotData.shotName),
    shotRanking: firstNumber(shotData.shotRanking) ?? toStringValue(shotData.shotRanking),
  }
}

const buildFinalShotEvent = (
  latest: BrowserGsproLatestShot,
  knownSupportedClubFields: Set<AmbiguousClubField>,
): SimReadFinalShotEvent => {
  if (!latest.shotData || typeof latest.shotData !== 'object' || Array.isArray(latest.shotData)) {
    throw new Error('GSPro DrivingRangeShot.ShotData was not an object.')
  }

  const resolvedShot = buildResolvedShot(
    latest.shotData as ShotDataObject,
    knownSupportedClubFields,
  )
  const ogcCandidates = {
    ballSpeed: resolvedShot.ballSpeed,
    vla: resolvedShot.vla,
    hla: resolvedShot.hla,
    spin: resolvedShot.spin,
    spinAxis: resolvedShot.spinAxis,
  }
  const presentFields = Object.entries(ogcCandidates)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([key]) => key)
  const missingFields = Object.keys(ogcCandidates).filter(
    (key) => !presentFields.includes(key),
  )

  const requiredLayout = {
    carry: resolvedShot.carry,
    totalDistance: resolvedShot.totalDistance,
    offline: resolvedShot.offline,
  }
  const missingRequiredFields = Object.entries(requiredLayout)
    .filter(([, value]) => typeof value !== 'number' || !Number.isFinite(value))
    .map(([key]) => key)

  const visibleFields = Object.entries(resolvedShot)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort()
  const emitTimestamp = new Date().toISOString()

  return {
    event: 'final-shot',
    timestamp: emitTimestamp,
    source: 'gspro-range-db',
    rowId: latest.rowId,
    resolvedShot,
    visibleFields,
    ogcEligibility: {
      callable: missingFields.length === 0,
      recommended: missingFields.length === 0,
      presentFields,
      missingFields,
    },
    layoutSupport: {
      isSupported: missingRequiredFields.length === 0,
      missingRequiredFields,
      missingRecommendedFields: missingFields,
    },
    rangeDbTiming: {
      rowId: latest.rowId,
      dateCreated: latest.dateCreated,
      emitTimestamp,
    },
  }
}

export const prepareBrowserGsproRuntime = async () => {
  if (!isBrowserGsproAccessSupported()) {
    preparedDirectoryHandle = null
    return false
  }

  const handle = await loadGsproDirectoryHandle()
  if (!handle) {
    preparedDirectoryHandle = null
    return false
  }

  const permission = await queryGsproDirectoryPermission(handle, 'readwrite')
  if (permission !== 'granted') {
    preparedDirectoryHandle = null
    return false
  }

  // Validate both the expected file and the DrivingRangeShot table before normal app use.
  await readLatestGsproRangeShot(handle)
  preparedDirectoryHandle = handle
  return true
}

export const isBrowserGsproRuntimePrepared = () => preparedDirectoryHandle !== null

export const clearPreparedBrowserGsproRuntime = () => {
  preparedDirectoryHandle = null
}

export const connectToBrowserGsproEvents = ({
  onFinalShot,
  onStatusChange,
  onError,
}: ConnectToBrowserGsproOptions): BrowserGsproLiveConnection => {
  const directoryHandle = preparedDirectoryHandle
  if (!directoryHandle) {
    throw new Error('Browser GSPro access was not prepared before session start.')
  }

  let disconnected = false
  let pollBusy = false
  let consecutiveFailures = 0
  let errorReported = false
  let initialized = false
  let lastRowId: number | null = null
  let databaseState: { size: number; lastModified: number } | null = null
  const knownSupportedClubFields = new Set<AmbiguousClubField>()

  onStatusChange?.('connecting')

  const handleFailure = (error: unknown) => {
    consecutiveFailures += 1
    console.warn('[Browser GSPro] read attempt failed; will retry', {
      consecutiveFailures,
      error,
    })

    if (consecutiveFailures >= ERROR_REPORT_THRESHOLD && !errorReported) {
      errorReported = true
      onStatusChange?.('error')
      onError?.(error)
    }
  }

  const handleRecovery = () => {
    if (consecutiveFailures === 0) {
      return
    }
    consecutiveFailures = 0
    if (errorReported) {
      errorReported = false
      onStatusChange?.('connected')
      onStatusChange?.('waiting')
    }
  }

  const initialize = async () => {
    const latest = await readLatestGsproRangeShot(directoryHandle)
    if (disconnected) {
      return
    }

    lastRowId = latest?.rowId ?? null
    databaseState = latest
      ? {
          size: latest.databaseSizeBytes,
          lastModified: latest.databaseLastModified,
        }
      : await readGsproDatabaseState(directoryHandle)
    initialized = true
    handleRecovery()
    onStatusChange?.('connected')
    onStatusChange?.('waiting')
  }

  const pollOnce = async () => {
    if (!initialized || !databaseState) {
      await initialize()
      return
    }

    const nextState = await readGsproDatabaseState(directoryHandle)
    if (disconnected) {
      return
    }

    if (
      nextState.size === databaseState.size &&
      nextState.lastModified === databaseState.lastModified
    ) {
      handleRecovery()
      return
    }

    // Advance databaseState only after the SQLite read succeeds. If GSPro is mid-write,
    // the next poll retries the same change instead of silently missing the shot.
    const latest = await readLatestGsproRangeShot(directoryHandle)
    if (disconnected) {
      return
    }

    databaseState = {
      size: latest?.databaseSizeBytes ?? nextState.size,
      lastModified: latest?.databaseLastModified ?? nextState.lastModified,
    }
    handleRecovery()

    if (!latest) {
      return
    }

    if (lastRowId === null) {
      lastRowId = latest.rowId
      return
    }

    if (latest.rowId === lastRowId) {
      return
    }

    lastRowId = latest.rowId
    onStatusChange?.('received-shot')
    onFinalShot(buildFinalShotEvent(latest, knownSupportedClubFields))
    onStatusChange?.('waiting')
  }

  const runPoll = () => {
    if (disconnected || pollBusy) {
      return
    }
    pollBusy = true
    void pollOnce()
      .catch(handleFailure)
      .finally(() => {
        pollBusy = false
      })
  }

  runPoll()
  const pollTimer = window.setInterval(runPoll, POLL_INTERVAL_MS)

  return {
    mode: 'simread',
    disconnect: () => {
      if (disconnected) {
        return
      }
      disconnected = true
      window.clearInterval(pollTimer)
      onStatusChange?.('disconnected')
    },
  }
}
