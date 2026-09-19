import {
  GREYWOLF_COURSE_ID,
  getCourseCatalogEntry,
  resolveCourseIdFromGsproName,
  type CourseId,
} from '../courseGeometry/courseCatalog'
import { loadLastSelectedCourseId } from '../courseGeometry/courseSelection'
import type { CoursePointYds } from '../courseGeometry/types'
import {
  isBrowserGsproAccessSupported,
  loadGsproDirectoryHandle,
  queryGsproDirectoryPermission,
  requestGsproDirectoryPermission,
  type BrowserDirectoryHandle,
} from './browserGsproAccess'

export type BrowserGsproCourseStatus =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'received-state'
  | 'error'
  | 'disconnected'

export type BrowserGsproCourseShot = {
  key: string
  roundId: number | null
  holeNumber: number
  holeShot: number | null
  shotId: string
  courseKey: string | null
  startLocalYds: CoursePointYds | null
  endLocalYds: CoursePointYds | null
  endingSurface: string | null
  endingSurfaceRaw: number | null
  distanceToPinYds: number | null
}

export type BrowserGsproCourseSnapshot = {
  courseKey: string | null
  roundId: number | null
  holeNumber: number | null
  ballLocalYds: CoursePointYds | null
  ballSource: 'currentRound' | 'cached-tee' | 'unavailable'
  surface: string | null
  surfaceSource: 'currentRound' | 'cached-tee' | 'unavailable'
  distanceToPinYds: number | null
  nextShotNumber: number | null
  latestShot: BrowserGsproCourseShot | null
  latestShotKey: string | null
  warnings: string[]
  observedAt: string
}

export type BrowserGsproCourseConnection = {
  disconnect: () => void
}

type CourseStatePickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: unknown
  }) => Promise<BrowserDirectoryHandle>
}

type Vec3 = {
  x?: unknown
  y?: unknown
  z?: unknown
}

type RoundShotData = {
  isHoled?: unknown
  isGimme?: unknown
}

type ActiveShot = {
  sd?: RoundShotData
}

type RoundShotRecord = {
  ShotID?: unknown
  RoundID?: unknown
  Hole?: unknown
  HoleShot?: unknown
  GlobalShotNumber?: unknown
  CourseKey?: unknown
  StartingSurface?: unknown
  EndingSurface?: unknown
  DistanceToPin?: unknown
  BallSpeed?: unknown
  TotalDistance?: unknown
  StartingPOS?: Vec3
  EndingPOS?: Vec3
  activeShot?: ActiveShot
}

type HoleAnchorArtifact = {
  anchors?: {
    selected_tee_latlon?: unknown
    target_green_latlon?: unknown
  }
}

type OutputLogHoleState = {
  holeNumber: number | null
  terminalAfterLatestHoleMarker: boolean
}

const STATE_HANDLE_DB = 'looper-browser-gspro-course-state'
const STATE_HANDLE_STORE = 'handles'
const STATE_HANDLE_KEY = 'gspro-course-state-directory'
const CURRENT_ROUND_FILE = 'currentRound.dat'
const OUTPUT_LOG_FILE = 'output_log.txt'
const OUTPUT_LOG_TAIL_BYTES = 160_000
const POLL_INTERVAL_MS = 750
const ERROR_REPORT_THRESHOLD = 5
const METERS_TO_YARDS = 1.0936132983377078
const WORLD_ROTATION_DEG = 0.5319220319046369
const RAW_GEOMETRY_BASE =
  'https://raw.githubusercontent.com/bpgpitt10/nova-v0/hazard-field-lab-v0/artifacts/osm-proof/local-geometry'

let preparedStateHandle: BrowserDirectoryHandle | null = null
const holeForwardCache = new Map<number, Promise<readonly [east: number, north: number]>>()

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const asNumber = (value: unknown): number | null => {
  if (finite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const asBoolean = (value: unknown) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1'
  }
  return false
}

const vec3 = (value: unknown): { x: number; y: number; z: number } | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Vec3
  const x = asNumber(candidate.x)
  const y = asNumber(candidate.y)
  const z = asNumber(candidate.z)
  return x == null || y == null || z == null ? null : { x, y, z }
}

const openStateHandleDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(STATE_HANDLE_DB, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STATE_HANDLE_STORE)) {
        database.createObjectStore(STATE_HANDLE_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open GSPro course-state handle storage.'))
  })

export const chooseGsproCourseStateDirectory = async () => {
  const picker = (window as CourseStatePickerWindow).showDirectoryPicker
  if (!picker) {
    throw new Error('Direct GSPro course-state access requires desktop Chrome or Edge.')
  }
  return picker({ id: 'looper-gspro-course-state', mode: 'read' })
}

export const saveGsproCourseStateDirectoryHandle = async (handle: BrowserDirectoryHandle) => {
  const database = await openStateHandleDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STATE_HANDLE_STORE, 'readwrite')
      const request = transaction.objectStore(STATE_HANDLE_STORE).put(handle, STATE_HANDLE_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('Could not save the GSPro course-state folder.'))
    })
  } finally {
    database.close()
  }
}

export const loadGsproCourseStateDirectoryHandle = async () => {
  const database = await openStateHandleDatabase()
  try {
    return await new Promise<BrowserDirectoryHandle | null>((resolve, reject) => {
      const transaction = database.transaction(STATE_HANDLE_STORE, 'readonly')
      const request = transaction.objectStore(STATE_HANDLE_STORE).get(STATE_HANDLE_KEY)
      request.onsuccess = () => resolve((request.result as BrowserDirectoryHandle | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error('Could not restore the GSPro course-state folder.'))
    })
  } finally {
    database.close()
  }
}

const canReadCurrentRound = async (handle: BrowserDirectoryHandle) => {
  try {
    const fileHandle = await handle.getFileHandle(CURRENT_ROUND_FILE)
    await fileHandle.getFile()
    return true
  } catch {
    return false
  }
}

export const prepareBrowserGsproCourseStateRuntime = async () => {
  preparedStateHandle = null
  if (!isBrowserGsproAccessSupported()) return false

  const primaryHandle = await loadGsproDirectoryHandle().catch(() => null)
  if (primaryHandle) {
    const permission = await queryGsproDirectoryPermission(primaryHandle, 'read')
    if (permission === 'granted' && await canReadCurrentRound(primaryHandle)) {
      preparedStateHandle = primaryHandle
      return true
    }
  }

  const savedStateHandle = await loadGsproCourseStateDirectoryHandle().catch(() => null)
  if (!savedStateHandle) return false
  const permission = await queryGsproDirectoryPermission(savedStateHandle, 'read')
  if (permission !== 'granted' || !await canReadCurrentRound(savedStateHandle)) return false

  preparedStateHandle = savedStateHandle
  return true
}

export const connectBrowserGsproCourseStateFolder = async () => {
  const handle = await chooseGsproCourseStateDirectory()
  const permission = await requestGsproDirectoryPermission(handle, 'read')
  if (permission !== 'granted') {
    throw new Error('Read permission was not granted for the GSPro course-state folder.')
  }
  if (!await canReadCurrentRound(handle)) {
    throw new Error('That folder does not contain currentRound.dat. Choose the GSPro LocalLow runtime folder.')
  }
  await saveGsproCourseStateDirectoryHandle(handle)
  preparedStateHandle = handle
  return true
}

export const isBrowserGsproCourseStatePrepared = () => preparedStateHandle !== null

const surfaceFromRaw = (value: number | null) => {
  switch (value) {
    case 1: return 'rough'
    case 2: return 'fairway'
    case 3: return 'sand'
    case 5: return 'green'
    case 18: return 'tee'
    default: return null
  }
}

const parseRoundCandidates = (text: string): RoundShotRecord[] => {
  const parsed = JSON.parse(text) as unknown
  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>).flatMap((value) => Array.isArray(value) ? value : [])
      : []

  return candidates.flatMap((candidate): RoundShotRecord[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    return [candidate as RoundShotRecord]
  })
}

const parseRoundRecords = (text: string): RoundShotRecord[] => {
  const candidates = parseRoundCandidates(text)
  const seen = new Set<string>()
  return candidates.flatMap((record): RoundShotRecord[] => {
    const shotId = asString(record.ShotID)
    if (!shotId || seen.has(shotId) || !vec3(record.StartingPOS) || !vec3(record.EndingPOS)) return []
    const ballSpeed = asNumber(record.BallSpeed) ?? 0
    const totalDistance = asNumber(record.TotalDistance) ?? 0
    if (ballSpeed <= 0 && totalDistance <= 0) return []
    seen.add(shotId)
    return [record]
  })
}

const recordSortValue = (record: RoundShotRecord) =>
  asNumber(record.GlobalShotNumber) ?? asNumber(record.HoleShot) ?? 0

const recordIsTerminal = (record: RoundShotRecord) => {
  const activeShot = record.activeShot
  if (!activeShot || typeof activeShot !== 'object' || Array.isArray(activeShot)) return false
  const sd = activeShot.sd
  if (!sd || typeof sd !== 'object' || Array.isArray(sd)) return false
  return asBoolean(sd.isHoled) || asBoolean(sd.isGimme)
}

const latestTerminalHoleForRound = (text: string, roundId: number | null) => {
  const candidates = parseRoundCandidates(text)
    .filter((record) => roundId == null || asNumber(record.RoundID) === roundId)
    .sort((a, b) => recordSortValue(a) - recordSortValue(b))

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const record = candidates[index]
    if (!recordIsTerminal(record)) continue
    const rawHole = asNumber(record.Hole)
    if (rawHole == null) return null
    const holeNumber = Math.round(rawHole) + 1
    return holeNumber >= 1 && holeNumber <= 18 ? holeNumber : null
  }
  return null
}

const parseOutputLogHoleState = (text: string): OutputLogHoleState => {
  const holeMatches = [...text.matchAll(/currentHole\s*:\s*(-?\d+)/gi)]
  const validHoleMatches = holeMatches.filter((match) => {
    const raw = Number(match[1])
    return Number.isFinite(raw) && raw >= 0 && raw < 18
  })

  const latestValidHole = validHoleMatches[validHoleMatches.length - 1]
  const holeNumber = latestValidHole ? Number(latestValidHole[1]) + 1 : null
  const latestHoleMarkerIndex = latestValidHole?.index ?? -1
  const terminalMatches = [...text.matchAll(/AllPlayersHoledOut\s*:\s*1\b/gi)]
  const latestTerminalIndex = terminalMatches.length > 0
    ? terminalMatches[terminalMatches.length - 1].index ?? -1
    : -1

  return {
    holeNumber,
    terminalAfterLatestHoleMarker:
      holeNumber != null && latestTerminalIndex > latestHoleMarkerIndex,
  }
}

const latLonPair = (value: unknown): readonly [number, number] | null => {
  if (!Array.isArray(value) || value.length < 2) return null
  const lat = asNumber(value[0])
  const lon = asNumber(value[1])
  return lat == null || lon == null ? null : [lat, lon]
}

const loadHoleForwardEastNorth = (holeNumber: number) => {
  const existing = holeForwardCache.get(holeNumber)
  if (existing) return existing

  const promise = fetch(`${RAW_GEOMETRY_BASE}/greywolf-hole-${String(holeNumber).padStart(2, '0')}.json`)
    .then((response) => {
      if (!response.ok) throw new Error(`Greywolf H${holeNumber} anchor package returned ${response.status}.`)
      return response.json() as Promise<HoleAnchorArtifact>
    })
    .then((raw): readonly [number, number] => {
      const tee = latLonPair(raw.anchors?.selected_tee_latlon)
      const green = latLonPair(raw.anchors?.target_green_latlon)
      if (!tee || !green) throw new Error(`Greywolf H${holeNumber} anchor package did not include tee/green coordinates.`)
      const meanLatRad = ((tee[0] + green[0]) / 2) * Math.PI / 180
      const east = (green[1] - tee[1]) * Math.cos(meanLatRad)
      const north = green[0] - tee[0]
      const length = Math.hypot(east, north)
      if (length <= 1e-12) throw new Error(`Greywolf H${holeNumber} tee/green bearing was degenerate.`)
      return [east / length, north / length]
    })
    .catch((error) => {
      holeForwardCache.delete(holeNumber)
      throw error
    })

  holeForwardCache.set(holeNumber, promise)
  return promise
}

const worldDeltaToEastNorthYards = (dx: number, dz: number) => {
  const radians = WORLD_ROTATION_DEG * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    east: METERS_TO_YARDS * (cos * dx - sin * dz),
    north: METERS_TO_YARDS * (sin * dx + cos * dz),
  }
}

const worldPointToHoleLocal = async (
  point: { x: number; z: number },
  teeWorld: { x: number; z: number },
  holeNumber: number,
): Promise<CoursePointYds> => {
  const forward = await loadHoleForwardEastNorth(holeNumber)
  const delta = worldDeltaToEastNorthYards(point.x - teeWorld.x, point.z - teeWorld.z)
  const rightEast = forward[1]
  const rightNorth = -forward[0]
  const rightYds = delta.east * rightEast + delta.north * rightNorth
  const forwardYds = delta.east * forward[0] + delta.north * forward[1]
  return [rightYds, forwardYds]
}

const buildShot = async (
  record: RoundShotRecord,
  roundRecords: RoundShotRecord[],
  coordinateCourseId: CourseId | null,
): Promise<BrowserGsproCourseShot | null> => {
  const holeIndex = asNumber(record.Hole)
  const shotId = asString(record.ShotID)
  if (holeIndex == null || shotId == null) return null
  const holeNumber = Math.round(holeIndex) + 1
  if (holeNumber < 1 || holeNumber > 18) return null

  let startLocalYds: CoursePointYds | null = null
  let endLocalYds: CoursePointYds | null = null
  if (coordinateCourseId === GREYWOLF_COURSE_ID) {
    const sameHole = roundRecords
      .filter((item) => asNumber(item.Hole) === holeIndex)
      .sort((a, b) => recordSortValue(a) - recordSortValue(b))
    const firstStart = vec3(sameHole[0]?.StartingPOS)
    const start = vec3(record.StartingPOS)
    const end = vec3(record.EndingPOS)
    if (firstStart && start && end) {
      ;[startLocalYds, endLocalYds] = await Promise.all([
        worldPointToHoleLocal(start, firstStart, holeNumber),
        worldPointToHoleLocal(end, firstStart, holeNumber),
      ])
    }
  }

  const roundId = asNumber(record.RoundID)
  const endingSurfaceRaw = asNumber(record.EndingSurface)
  const distanceToPin = asNumber(record.DistanceToPin)

  return {
    key: `${roundId ?? 'round'}:${holeNumber}:${shotId}`,
    roundId,
    holeNumber,
    holeShot: asNumber(record.HoleShot),
    shotId,
    courseKey: asString(record.CourseKey),
    startLocalYds,
    endLocalYds,
    endingSurface: surfaceFromRaw(endingSurfaceRaw),
    endingSurfaceRaw,
    distanceToPinYds: distanceToPin == null ? null : distanceToPin * METERS_TO_YARDS,
  }
}

const readOptionalFile = async (handle: BrowserDirectoryHandle, name: string) => {
  try {
    const fileHandle = await handle.getFileHandle(name)
    return await fileHandle.getFile()
  } catch {
    return null
  }
}

const outputLogTail = async (file: File | null) => {
  if (!file) return ''
  const start = Math.max(0, file.size - OUTPUT_LOG_TAIL_BYTES)
  return file.slice(start).text()
}

const cachedTeeSnapshot = ({
  courseKey,
  roundId,
  holeNumber,
  warnings,
}: {
  courseKey: string | null
  roundId: number | null
  holeNumber: number
  warnings: string[]
}): BrowserGsproCourseSnapshot => ({
  courseKey,
  roundId,
  holeNumber,
  ballLocalYds: null,
  ballSource: 'cached-tee',
  surface: 'tee',
  surfaceSource: 'cached-tee',
  distanceToPinYds: null,
  nextShotNumber: 1,
  latestShot: null,
  latestShotKey: null,
  warnings,
  observedAt: new Date().toISOString(),
})

const buildSnapshot = async (
  roundText: string,
  logTail: string,
  selectedCourseId: CourseId,
): Promise<BrowserGsproCourseSnapshot> => {
  const warnings: string[] = []
  const records = parseRoundRecords(roundText)
  const logState = parseOutputLogHoleState(logTail)

  if (records.length === 0) {
    if (logState.holeNumber != null) {
      return cachedTeeSnapshot({
        courseKey: null,
        roundId: null,
        holeNumber: logState.holeNumber,
        warnings: ['Waiting for the first physical shot; using the selected course tee position.'],
      })
    }

    return {
      courseKey: null,
      roundId: null,
      holeNumber: null,
      ballLocalYds: null,
      ballSource: 'unavailable',
      surface: null,
      surfaceSource: 'unavailable',
      distanceToPinYds: null,
      nextShotNumber: null,
      latestShot: null,
      latestShotKey: null,
      warnings: ['currentRound.dat did not contain a physical shot record yet.'],
      observedAt: new Date().toISOString(),
    }
  }

  records.sort((a, b) => recordSortValue(a) - recordSortValue(b))
  const newest = records[records.length - 1]
  const activeRoundId = asNumber(newest.RoundID)
  const roundRecords = activeRoundId == null
    ? records
    : records.filter((record) => asNumber(record.RoundID) === activeRoundId)
  const latestRecord = roundRecords[roundRecords.length - 1]
  const courseKey = asString(latestRecord.CourseKey)
  const observedCourseId = courseKey ? resolveCourseIdFromGsproName(courseKey) : null
  const selectedCourse = getCourseCatalogEntry(selectedCourseId)
  const rawLatestHole = asNumber(latestRecord.Hole)
  const latestRecordHole = rawLatestHole == null ? null : Math.round(rawLatestHole) + 1
  const terminalHole = latestTerminalHoleForRound(roundText, activeRoundId)
  const logHole = logState.holeNumber

  let coordinateCourseId: CourseId | null = null
  if (observedCourseId === selectedCourseId) {
    coordinateCourseId = selectedCourseId
  } else if (courseKey && observedCourseId && observedCourseId !== selectedCourseId) {
    warnings.push(
      `Selected ${selectedCourse.name}, but GSPro reports ${courseKey}. Keeping the user-selected course until confirmed.`,
    )
  } else if (courseKey && !observedCourseId) {
    warnings.push(
      `GSPro reports ${courseKey}, which is not a reviewed Looper alias yet. Keeping the user-selected ${selectedCourse.name}.`,
    )
  }

  if (observedCourseId === selectedCourseId && selectedCourseId !== GREYWOLF_COURSE_ID) {
    warnings.push(
      `${selectedCourse.name} is selected and validated, but GSPro-world shot coordinates are not registered for this course yet. Shot ingestion continues without live ball placement.`,
    )
  }

  const latestShot = await buildShot(latestRecord, roundRecords, coordinateCourseId)

  let holeNumber = latestRecordHole
  if (logHole != null) {
    if (latestRecordHole == null) {
      holeNumber = logHole
    } else if (logHole === latestRecordHole) {
      holeNumber = logHole
      if (logState.terminalAfterLatestHoleMarker && logHole < 18) {
        holeNumber = logHole + 1
        warnings.push(`Hole ${logHole} is complete; preloading Hole ${holeNumber} from the selected course tee.`)
      }
    } else if (logHole > latestRecordHole) {
      holeNumber = logHole
      warnings.push(`Tee transition detected from output_log: currentRound is still on H${latestRecordHole}.`)
    } else if (latestRecordHole === 18 && logHole === 1) {
      holeNumber = 1
      warnings.push('New-round Hole 1 detected while currentRound still contains the prior Hole 18.')
    } else {
      holeNumber = latestRecordHole
    }
  }

  if (
    latestRecordHole != null
    && latestRecordHole < 18
    && terminalHole === latestRecordHole
    && holeNumber === latestRecordHole
  ) {
    holeNumber = latestRecordHole + 1
    warnings.push(
      `Hole ${latestRecordHole} terminal state detected in currentRound; preloading Hole ${holeNumber} from the selected course tee.`,
    )
  }

  if (holeNumber == null || holeNumber < 1 || holeNumber > 18) {
    return {
      courseKey,
      roundId: activeRoundId,
      holeNumber: null,
      ballLocalYds: null,
      ballSource: 'unavailable',
      surface: null,
      surfaceSource: 'unavailable',
      distanceToPinYds: null,
      nextShotNumber: null,
      latestShot,
      latestShotKey: latestShot?.key ?? null,
      warnings,
      observedAt: new Date().toISOString(),
    }
  }

  if (latestRecordHole !== holeNumber) {
    return cachedTeeSnapshot({
      courseKey,
      roundId: activeRoundId,
      holeNumber,
      warnings,
    })
  }

  const currentHoleRecords = roundRecords.filter((record) => asNumber(record.Hole) === holeNumber - 1)
  if (currentHoleRecords.length === 0) {
    return cachedTeeSnapshot({
      courseKey,
      roundId: activeRoundId,
      holeNumber,
      warnings,
    })
  }

  currentHoleRecords.sort((a, b) => recordSortValue(a) - recordSortValue(b))
  const currentRecord = currentHoleRecords[currentHoleRecords.length - 1]
  const currentShot = currentRecord === latestRecord
    ? latestShot
    : await buildShot(currentRecord, roundRecords, coordinateCourseId)
  const currentSurfaceRaw = asNumber(currentRecord.EndingSurface)
  const currentSurface = surfaceFromRaw(currentSurfaceRaw)

  return {
    courseKey,
    roundId: activeRoundId,
    holeNumber,
    ballLocalYds: currentShot?.endLocalYds ?? null,
    ballSource: currentShot?.endLocalYds ? 'currentRound' : 'unavailable',
    surface: currentSurface,
    surfaceSource: currentSurface ? 'currentRound' : 'unavailable',
    distanceToPinYds: currentShot?.distanceToPinYds ?? null,
    nextShotNumber: currentHoleRecords.length + 1,
    latestShot,
    latestShotKey: latestShot?.key ?? null,
    warnings,
    observedAt: new Date().toISOString(),
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
  const handle = preparedStateHandle
  if (!handle) throw new Error('GSPro course-state access was not prepared.')

  let disconnected = false
  let busy = false
  let consecutiveFailures = 0
  let errorReported = false
  let lastRoundSignature = ''
  let lastLogSignature = ''
  let lastGoodLogTail = ''

  onStatusChange?.('connecting')

  const poll = async () => {
    const roundFile = await readOptionalFile(handle, CURRENT_ROUND_FILE)
    if (!roundFile) throw new Error('currentRound.dat is unavailable in the selected GSPro state folder.')

    const logFile = await readOptionalFile(handle, OUTPUT_LOG_FILE)
    const roundSignature = `${roundFile.size}:${roundFile.lastModified}`
    const logSignature = logFile ? `${logFile.size}:${logFile.lastModified}` : 'missing'
    if (roundSignature === lastRoundSignature && logSignature === lastLogSignature) return

    const roundTextPromise = roundFile.text()
    const logTailPromise = logFile
      ? outputLogTail(logFile).then((tail) => {
          lastGoodLogTail = tail
          return tail
        })
      : Promise.resolve(lastGoodLogTail)

    const [roundText, logTail] = await Promise.all([roundTextPromise, logTailPromise])
    const snapshot = await buildSnapshot(roundText, logTail, loadLastSelectedCourseId())
    if (disconnected) return

    lastRoundSignature = roundSignature
    lastLogSignature = logSignature
    consecutiveFailures = 0
    errorReported = false
    onStatusChange?.('received-state')
    onSnapshot(snapshot)
    onStatusChange?.('waiting')
  }

  const runPoll = () => {
    if (disconnected || busy) return
    busy = true
    void poll()
      .catch((error) => {
        consecutiveFailures += 1
        console.warn('[Browser GSPro course state] read failed; will retry', error)
        if (consecutiveFailures >= ERROR_REPORT_THRESHOLD && !errorReported) {
          errorReported = true
          onStatusChange?.('error')
          onError?.(error)
        }
      })
      .finally(() => {
        busy = false
      })
  }

  runPoll()
  const timer = window.setInterval(runPoll, POLL_INTERVAL_MS)

  return {
    disconnect: () => {
      if (disconnected) return
      disconnected = true
      window.clearInterval(timer)
      onStatusChange?.('disconnected')
    },
  }
}
