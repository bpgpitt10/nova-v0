import type {
  SimReadFinalShotEvent,
  SimReadResolvedShot,
} from '../adapters/simreadFinalShot'
import { dispatchSimReadFinalShotEvent } from '../adapters/simreadLive'
import {
  loadGsproDirectoryHandle,
  queryGsproDirectoryPermission,
  readLatestGsproRangeShot,
  type BrowserDirectoryHandle,
  type BrowserGsproLatestShot,
} from './browserGsproAccess'

type ShotDataObject = Record<string, unknown>

type BrowserGsproDatabaseState = {
  size: number
  lastModified: number
}

const POLL_INTERVAL_MS = 500
const GSPRO_DATABASE_NAME = 'GSPro.db'

let pollTimer: number | null = null
let pollBusy = false
let runtimeRunning = false
let shimInstalled = false

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

const buildResolvedShot = (shotData: ShotDataObject): SimReadResolvedShot => {
  const carry = firstNumber(shotData.Carry, shotData.rawCarryGame, shotData.rawCarryLM)
  const totalDistance = toNumber(shotData.TotalDistance)
  const offline = toNumber(shotData.Offline)
  const ballSpeed = toNumber(shotData.BallSpeed)
  const vla = toNumber(shotData.VLA)
  const hla = toNumber(shotData.HLA)
  const spinAxis = toNumber(shotData.rawSpinAxis)
  const peakHeight = toNumber(shotData.PeakHeight)
  const descentAngle = toNumber(shotData.Decent)
  const totalSpin = deriveTotalSpin(shotData)

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
    clubSpeed: toNumber(shotData.ClubSpeed),
    clubPath: toNumber(shotData.Path),
    clubAoa: toNumber(shotData.AoA),
    faceToTarget: toNumber(shotData.FaceToTarget),
    faceToPath: toNumber(shotData.FaceToPath),
    clubLie: toNumber(shotData.Lie),
    clubLoft: toNumber(shotData.Loft),
    dynamicLoft: toNumber(shotData.DynamicLoft),
    closureRate: toNumber(shotData.CR),
    clubFaceHImpact: toNumber(shotData.HI),
    clubFaceVImpact: toNumber(shotData.VI),
    smashFactor: toNumber(shotData.SmashFactor),
    distToPin: toNumber(shotData.DistanceToPin),
    distanceToPin: toNumber(shotData.DistanceToPin),
  }
}

const buildFinalShotEvent = (latest: BrowserGsproLatestShot): SimReadFinalShotEvent => {
  if (!latest.shotData || typeof latest.shotData !== 'object' || Array.isArray(latest.shotData)) {
    throw new Error('GSPro DrivingRangeShot.ShotData was not an object.')
  }

  const resolvedShot = buildResolvedShot(latest.shotData as ShotDataObject)
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

const readDatabaseState = async (
  directoryHandle: BrowserDirectoryHandle,
): Promise<BrowserGsproDatabaseState> => {
  const databaseHandle = await directoryHandle.getFileHandle(GSPRO_DATABASE_NAME)
  const databaseFile = await databaseHandle.getFile()
  return {
    size: databaseFile.size,
    lastModified: databaseFile.lastModified,
  }
}

const isSimReadEventsUrl = (url: string) =>
  url.includes('127.0.0.1:8788/events') ||
  url.includes('localhost:8788/events') ||
  url.endsWith('/simread/events')

class LocalSimReadEventSource extends EventTarget {
  readonly url: string
  readonly withCredentials = false
  readyState = 0

  constructor(url: string) {
    super()
    this.url = url
    window.setTimeout(() => {
      if (this.readyState !== 0) {
        return
      }
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    }, 0)
  }

  close() {
    this.readyState = 2
  }
}

const installSimReadEventSourceShim = () => {
  if (shimInstalled || typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
    return
  }

  const NativeEventSource = window.EventSource
  const EventSourceProxy = function (
    this: EventSource,
    url: string | URL,
    eventSourceInitDict?: EventSourceInit,
  ) {
    const resolvedUrl = String(url)
    if (isSimReadEventsUrl(resolvedUrl)) {
      return new LocalSimReadEventSource(resolvedUrl) as unknown as EventSource
    }
    return new NativeEventSource(url, eventSourceInitDict)
  }

  Object.defineProperties(EventSourceProxy, {
    CONNECTING: { value: NativeEventSource.CONNECTING },
    OPEN: { value: NativeEventSource.OPEN },
    CLOSED: { value: NativeEventSource.CLOSED },
  })

  window.EventSource = EventSourceProxy as unknown as typeof EventSource
  shimInstalled = true
}

export const isBrowserGsproRuntimeRunning = () => runtimeRunning

export const startBrowserGsproRuntime = async () => {
  if (runtimeRunning) {
    return
  }

  const directoryHandle = await loadGsproDirectoryHandle()
  if (!directoryHandle) {
    throw new Error('No saved GSPro folder is available.')
  }

  const permission = await queryGsproDirectoryPermission(directoryHandle, 'readwrite')
  if (permission !== 'granted') {
    throw new Error('GSPro folder permission is not granted.')
  }

  installSimReadEventSourceShim()

  const baseline = await readLatestGsproRangeShot(directoryHandle)
  let lastRowId = baseline?.rowId ?? null
  let databaseState = baseline
    ? {
        size: baseline.databaseSizeBytes,
        lastModified: baseline.databaseLastModified,
      }
    : await readDatabaseState(directoryHandle)

  runtimeRunning = true
  pollTimer = window.setInterval(() => {
    if (pollBusy) {
      return
    }

    pollBusy = true
    void readDatabaseState(directoryHandle)
      .then(async (nextState) => {
        if (
          nextState.size === databaseState.size &&
          nextState.lastModified === databaseState.lastModified
        ) {
          return
        }

        databaseState = nextState
        const latest = await readLatestGsproRangeShot(directoryHandle)
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
        dispatchSimReadFinalShotEvent(buildFinalShotEvent(latest))
      })
      .catch((error) => {
        console.error('[Browser GSPro] polling failed', error)
      })
      .finally(() => {
        pollBusy = false
      })
  }, POLL_INTERVAL_MS)
}

export const stopBrowserGsproRuntime = () => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
  pollBusy = false
  runtimeRunning = false
}
