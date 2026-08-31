import {
  getSelectedGsproDatabase,
  gsproFileSignature,
  readGsproRangeShotsAfterIdFromFile,
  readLatestGsproRangeShot,
  type BrowserGsproRangeShot,
} from '../lib/browserGsproDb'
import {
  patchGsproRuntimeDiagnostics,
  recordGsproRuntimeError,
  resetGsproRuntimeDiagnostics,
} from '../lib/gsproRuntimeDiagnostics'
import type { SimReadFinalShotEvent, SimReadResolvedShot } from './simreadFinalShot'

const SIMREAD_FINAL_SHOT_EVENT = 'looper:simread-final-shot'
const SIMREAD_EVENT_TARGET_KEY = '__looperSimReadEventTarget'
const SIMREAD_DISPATCH_KEY = '__looperDispatchSimReadFinalShot'
const GSPRO_POLL_MS = 750
const GSPRO_CATCH_UP_BATCH_SIZE = 25

export const DEFAULT_SIMREAD_EVENTS_URL = 'browser-gspro-db'
export const DEV_SIMREAD_EVENTS_PROXY_URL = 'browser-gspro-db'

export type SimReadLiveStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'waiting'
  | 'received-shot'
  | 'error'
  | 'disconnected'

export type SimReadStatusSeverity = 'info' | 'warning' | 'error'

export type SimReadStructuredStatusEvent = {
  event: 'status'
  status: string
  severity: SimReadStatusSeverity
  message: string
  userAction?: string
}

export type SimReadLiveConnection = {
  mode: 'simread'
  disconnect: () => void
}

export type ConnectToSimReadEventsOptions = {
  onFinalShot: (event: SimReadFinalShotEvent) => void
  onStatusChange?: (status: SimReadLiveStatus) => void
  onStructuredStatus?: (event: SimReadStructuredStatusEvent) => void
  onError?: (error: unknown) => void
  eventsUrl?: string
}

type SimReadWindow = Window &
  typeof globalThis & {
    [SIMREAD_EVENT_TARGET_KEY]?: EventTarget
    [SIMREAD_DISPATCH_KEY]?: (event: SimReadFinalShotEvent) => void
  }

type ShotDataObject = Record<string, unknown>

const getWindow = (): SimReadWindow | null =>
  typeof window === 'undefined' ? null : (window as SimReadWindow)

const getSimReadEventTarget = () => {
  const simreadWindow = getWindow()
  if (!simreadWindow) {
    return new EventTarget()
  }

  simreadWindow[SIMREAD_EVENT_TARGET_KEY] ??= new EventTarget()
  return simreadWindow[SIMREAD_EVENT_TARGET_KEY]
}

export const dispatchSimReadFinalShotEvent = (event: SimReadFinalShotEvent) => {
  getSimReadEventTarget().dispatchEvent(
    new CustomEvent<SimReadFinalShotEvent>(SIMREAD_FINAL_SHOT_EVENT, {
      detail: event,
    }),
  )
}

const installDevDispatchHelper = () => {
  if (!import.meta.env.DEV) {
    return
  }

  const simreadWindow = getWindow()
  if (simreadWindow) {
    simreadWindow[SIMREAD_DISPATCH_KEY] = dispatchSimReadFinalShotEvent
  }
}

const toNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

const firstNumber = (data: ShotDataObject, ...keys: string[]) => {
  for (const key of keys) {
    const value = toNumber(data[key])
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

const toShotDataObject = (row: BrowserGsproRangeShot): ShotDataObject => {
  const parsed = row.parsedShotData
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GSPro DrivingRangeShot.ShotData was not a JSON object.')
  }
  return parsed as ShotDataObject
}

const mapRangeRowToFinalShot = (
  row: BrowserGsproRangeShot,
  sequence: number,
): SimReadFinalShotEvent => {
  const data = toShotDataObject(row)
  const backSpin = firstNumber(data, 'BackSpin')
  const sideSpin = firstNumber(data, 'SideSpin')
  const explicitSpin = firstNumber(data, 'TotalSpin', 'Spin')
  const derivedSpin =
    explicitSpin ??
    (backSpin !== undefined && sideSpin !== undefined
      ? Math.sqrt(backSpin ** 2 + sideSpin ** 2)
      : undefined)

  const resolvedShot: SimReadResolvedShot = {
    club: typeof data.club === 'string' && data.club.trim() ? data.club : undefined,
    carry: firstNumber(data, 'Carry', 'rawCarryGame', 'rawCarryLM'),
    carrySource: 'gspro',
    totalDistance: firstNumber(data, 'TotalDistance'),
    totalDistanceSource: 'gspro',
    offline: firstNumber(data, 'Offline'),
    offlineSource: 'gspro',
    ballSpeed: firstNumber(data, 'BallSpeed'),
    ballSpeedSource: 'gspro',
    vla: firstNumber(data, 'VLA'),
    vlaSource: 'gspro',
    hla: firstNumber(data, 'HLA'),
    hlaSource: 'gspro',
    spin: derivedSpin,
    spinSource: explicitSpin !== undefined ? 'gspro' : derivedSpin !== undefined ? 'derived' : 'missing',
    spinAxis: firstNumber(data, 'rawSpinAxis'),
    spinAxisSource: 'gspro',
    peakHeight: firstNumber(data, 'PeakHeight'),
    peakHeightSource: 'gspro',
    descentAngle: firstNumber(data, 'Decent'),
    descentAngleSource: 'gspro',
    backSpin,
    sideSpin,
    clubSpeed: firstNumber(data, 'ClubSpeed'),
    clubPath: firstNumber(data, 'Path'),
    clubAoa: firstNumber(data, 'AoA'),
    faceToTarget: firstNumber(data, 'FaceToTarget'),
    faceToPath: firstNumber(data, 'FaceToPath'),
    clubLie: firstNumber(data, 'Lie'),
    clubLoft: firstNumber(data, 'Loft'),
    dynamicLoft: firstNumber(data, 'DynamicLoft'),
    closureRate: firstNumber(data, 'CR'),
    clubFaceHImpact: firstNumber(data, 'HI'),
    clubFaceVImpact: firstNumber(data, 'VI'),
    smashFactor: firstNumber(data, 'SmashFactor'),
    distToPin: firstNumber(data, 'DistanceToPin'),
  }

  const visibleFields = Object.entries(resolvedShot)
    .filter(([, value]) => value !== undefined && value !== 'missing')
    .map(([key]) => key)
    .sort()
  const ogcFields = ['ballSpeed', 'vla', 'hla', 'spin', 'spinAxis'] as const
  const presentFields = ogcFields.filter((field) => typeof resolvedShot[field] === 'number')
  const missingFields = ogcFields.filter((field) => typeof resolvedShot[field] !== 'number')
  const requiredLayoutFields = ['carry', 'totalDistance', 'offline'] as const
  const missingRequiredFields = requiredLayoutFields.filter(
    (field) => typeof resolvedShot[field] !== 'number',
  )
  const emitTimestamp = new Date().toISOString()

  return {
    event: 'final-shot',
    timestamp: emitTimestamp,
    sequence,
    source: 'gspro-range-db',
    rowId: row.id,
    resolvedShot,
    visibleFields,
    ogcEligibility: {
      callable: missingFields.length === 0,
      recommended: missingFields.length === 0,
      presentFields: [...presentFields],
      missingFields: [...missingFields],
    },
    layoutSupport: {
      isSupported: missingRequiredFields.length === 0,
      missingRequiredFields: [...missingRequiredFields],
      missingRecommendedFields: [...missingFields],
    },
    rangeDbTiming: {
      rowId: row.id,
      dateCreated: row.dateCreated,
      emitTimestamp,
    },
  }
}

export const connectToSimReadEvents = ({
  onFinalShot,
  onStatusChange,
  onStructuredStatus,
  onError,
}: ConnectToSimReadEventsOptions): SimReadLiveConnection => {
  const target = getSimReadEventTarget()
  installDevDispatchHelper()
  resetGsproRuntimeDiagnostics()

  let disconnected = false
  let intervalId: number | null = null
  let pollInFlight = false
  let lastRowId = 0
  let lastSignature: string | null = null
  let sequence = 0
  let pollCount = 0
  let successfulReads = 0
  let readRetryCount = 0
  let rowsEmitted = 0

  const handleFinalShot = (event: SimReadFinalShotEvent) => {
    if (disconnected) {
      return
    }
    try {
      onStatusChange?.('received-shot')
      onFinalShot(event)
      rowsEmitted += 1
      patchGsproRuntimeDiagnostics({
        status: 'waiting',
        rowsEmitted,
        lastEmittedRowId: event.rowId,
        lastObservedRowId: Math.max(lastRowId, event.rowId),
        lastShotAt: new Date().toISOString(),
        lastError: null,
      })
      onStatusChange?.('waiting')
    } catch (error) {
      recordGsproRuntimeError(error)
      onStatusChange?.('error')
      onError?.(error)
    }
  }

  const handleManualFinalShot = (event: Event) => {
    handleFinalShot((event as CustomEvent<SimReadFinalShotEvent>).detail)
  }

  const fail = (error: unknown, message: string, userAction?: string) => {
    if (disconnected) {
      return
    }
    recordGsproRuntimeError(error)
    onStatusChange?.('error')
    onStructuredStatus?.({
      event: 'status',
      status: 'browser_gspro_error',
      severity: 'error',
      message,
      ...(userAction ? { userAction } : {}),
    })
    onError?.(error)
  }

  target.addEventListener(SIMREAD_FINAL_SHOT_EVENT, handleManualFinalShot)
  onStatusChange?.('connecting')

  const initialize = async () => {
    const handle = getSelectedGsproDatabase()
    if (!handle) {
      fail(
        new Error('GSPro database access has not been prepared.'),
        'GSPro database access is not connected.',
        'Return to the Looper home screen and reconnect the remembered GSPro folder.',
      )
      return
    }

    try {
      const initial = await readLatestGsproRangeShot(handle)
      if (disconnected) {
        return
      }
      successfulReads += 1
      lastRowId = initial.shot?.id ?? 0
      lastSignature = gsproFileSignature(initial.file)
      patchGsproRuntimeDiagnostics({
        status: 'waiting',
        successfulReads,
        baselineRowId: lastRowId,
        lastObservedRowId: lastRowId,
        lastFileSignature: lastSignature,
        lastFileModified: initial.file.lastModified,
        lastReadAt: new Date().toISOString(),
        lastError: null,
      })
      onStatusChange?.('connected')
      onStatusChange?.('waiting')

      intervalId = window.setInterval(() => {
        if (pollInFlight || disconnected) {
          return
        }

        pollInFlight = true
        pollCount += 1
        patchGsproRuntimeDiagnostics({
          pollCount,
          lastPollAt: new Date().toISOString(),
        })

        void (async () => {
          try {
            const file = await handle.getFile()
            const signature = gsproFileSignature(file)
            if (signature === lastSignature) {
              return
            }

            const newRows = await readGsproRangeShotsAfterIdFromFile(
              file,
              lastRowId,
              GSPRO_CATCH_UP_BATCH_SIZE,
            )
            if (disconnected) {
              return
            }

            successfulReads += 1
            const observedRowId = newRows.at(-1)?.id ?? lastRowId
            patchGsproRuntimeDiagnostics({
              status: 'waiting',
              successfulReads,
              lastObservedRowId: Math.max(lastRowId, observedRowId),
              lastFileSignature: signature,
              lastFileModified: file.lastModified,
              lastReadAt: new Date().toISOString(),
              lastError: null,
            })

            for (const row of newRows) {
              sequence += 1
              handleFinalShot(mapRangeRowToFinalShot(row, sequence))
              lastRowId = Math.max(lastRowId, row.id)
            }

            // If the batch filled, force another read on the next poll even if the
            // SQLite file metadata has not changed again. This drains every row that
            // accumulated while the tab was throttled or temporarily unable to read.
            lastSignature =
              newRows.length >= GSPRO_CATCH_UP_BATCH_SIZE ? null : signature
          } catch (error) {
            // GSPro may be writing the SQLite file while we snapshot it. Do not advance
            // the signature on failure; the next poll will retry the same change.
            readRetryCount += 1
            patchGsproRuntimeDiagnostics({
              status: 'waiting',
              readRetryCount,
              lastError: error instanceof Error ? error.message : String(error),
              lastErrorAt: new Date().toISOString(),
            })
            console.warn('[GSPro browser] database read retry', error)
          } finally {
            pollInFlight = false
          }
        })()
      }, GSPRO_POLL_MS)
    } catch (error) {
      fail(
        error,
        'Looper could not read GSPro.db from the connected GSPro folder.',
        'Reconnect the GSPro folder from the Looper home screen and try again.',
      )
    }
  }

  void initialize()

  return {
    mode: 'simread',
    disconnect: () => {
      disconnected = true
      if (intervalId !== null) {
        window.clearInterval(intervalId)
      }
      patchGsproRuntimeDiagnostics({ status: 'disconnected' })
      target.removeEventListener(SIMREAD_FINAL_SHOT_EVENT, handleManualFinalShot)
      onStatusChange?.('disconnected')
    },
  }
}
