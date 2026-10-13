import {
  GREYWOLF_COURSE_ID,
  getCourseCatalogEntry,
  resolveCourseIdFromGsproName,
  type CourseId,
} from '../courseGeometry/courseCatalog'
import { loadLastSelectedCourseId } from '../courseGeometry/courseSelection'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import { loadLiveTeeSessionAnchor } from '../courseGeometry/liveTeeSessionAnchor'
import { projectGsproWorldPointToHole, provisionalWorldPositionMatchesPinDistance } from '../courseGeometry/gsproWorldCourseProjection'
import { matchingTeeCandidates, courseGeometryFingerprint } from '../courseGeometry/shotOneTeeResolver'
import { loadTeeCalibration } from '../courseGeometry/teeCalibrationStore'
import { loadCourseHoleHeadingDegreesTrue } from '../liveState/courseHeading'
import { loadActiveLiveCaddieRound } from '../liveCaddie/roundRuntime'
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
  positionQuality?: 'verified' | 'provisional'
  endingSurface: string | null
  endingSurfaceRaw: number | null
  distanceToPinYds: number | null
}

export type BrowserGsproCourseSnapshot = {
  courseKey: string | null
  roundId: number | null
  holeNumber: number | null
  ballLocalYds: CoursePointYds | null
  ballSource: 'currentRound' | 'world-provisional' | 'cached-tee' | 'unavailable'
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
const GREYWOLF_LOCAL_GEOMETRY_BASE = '/course-geometry/greywolf/local-geometry'

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

const parseCurrentShotRecord = (text: string): RoundShotRecord | null => {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const root = parsed as Record<string, unknown>
  const candidate = root.CurrentShot ?? root.currentShot
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as RoundShotRecord
    : null
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

  const promise = fetch(`${GREYWOLF_LOCAL_GEOMETRY_BASE}/greywolf-hole-${String(holeNumber).padStart(2, '0')}.json`)
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

// Cache static geometry fetches, not tee hypotheses (which can change during
// the active round after a fresh native minimap reading).
const importedGeometryCache = new Map<string, Promise<Awaited<ReturnType<typeof loadCourseHoleGeometry>>>>()
const loadImportedHole = (courseId: CourseId, holeNumber: number, roundId: string) => {
  // The provider normalizes to the selected tee as part of loading geometry.
  // A new round can select a different tee without leaving this browser tab.
  // Keying only by course/hole silently reused the previous tee frame.
  const key = courseId + ':' + holeNumber + ':' + roundId
  const cached = importedGeometryCache.get(key)
  if (cached) return cached
  const work = loadCourseHoleGeometry(courseId, holeNumber).catch(error => {
    importedGeometryCache.delete(key)
    throw error
  })
  importedGeometryCache.set(key, work)
  return work
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
  let positionQuality: 'verified' | 'provisional' | undefined
  const sameHole = roundRecords
    .filter((item) => asNumber(item.Hole) === holeIndex)
    .sort((a, b) => recordSortValue(a) - recordSortValue(b))
  const firstStart = vec3(sameHole[0]?.StartingPOS)
  const start = vec3(record.StartingPOS)
  const end = vec3(record.EndingPOS)
  if (firstStart && start && end && coordinateCourseId === GREYWOLF_COURSE_ID) {
    ;[startLocalYds, endLocalYds] = await Promise.all([
      worldPointToHoleLocal(start, firstStart, holeNumber),
      worldPointToHoleLocal(end, firstStart, holeNumber),
    ])
    positionQuality = 'verified'
  } else if (firstStart && start && end && coordinateCourseId) {
    // New generic route: only align relative world movement after resolving
    // a genuine selected tee origin in our map frame. For an unmatched tee,
    // the native multi-waypoint ruler must first save a per-round tee anchor.
    // A bare package route/back-tee marker is NOT such an anchor.
    const round = loadActiveLiveCaddieRound()
    if (round?.courseId === coordinateCourseId) {
      try {
        const [geometry, heading] = await Promise.all([
          loadImportedHole(coordinateCourseId, holeNumber, round.id),
          loadCourseHoleHeadingDegreesTrue(coordinateCourseId, holeNumber),
        ])
        const locked = loadTeeCalibration(
          courseGeometryFingerprint(geometry), holeNumber, round.normalizedTeeSet,
        )
        const named = matchingTeeCandidates(geometry, round.normalizedTeeSet)
        const observed = loadLiveTeeSessionAnchor(round, holeNumber)
        const teeAnchor = locked?.status === 'locked'
          ? locked.courseLocalYds
          : observed?.point ?? (named.length === 1 ? named[0].coursePoint : null)
        if (teeAnchor && heading != null) {
          // Current FarmLinks H1 independent physical holdout: 227.1 yards
          // forward, 3.93 yards right vs GSPro 227.1 total / 3.9 offline.
          // For other imports 0° GSPro-world heading bias remains PROVISIONAL.
          startLocalYds = projectGsproWorldPointToHole(
            teeAnchor, firstStart, start, heading,
          )
          endLocalYds = projectGsproWorldPointToHole(
            teeAnchor, firstStart, end, heading,
          )
          const remainingYards = asNumber(record.DistanceToPin)
          const gsproRemainingYds = remainingYards == null ? null : remainingYards * METERS_TO_YARDS
          // Do not apply a world heading to any imported course blindly.
          // Independently cross-check current GSPro remaining straight distance
          // against the mapped GREEN centroid (not a supposedly exact pin).
          if (geometry.registration.status !== 'unavailable'
            && provisionalWorldPositionMatchesPinDistance(
              endLocalYds, geometry.markers.pin ?? null, gsproRemainingYds,
            ) && startLocalYds) {
            positionQuality = 'provisional'
          } else {
            startLocalYds = null
            endLocalYds = null
          }
        }
      } catch (error) {
        console.warn('[GSPro state] Imported-course world-to-map position unavailable.', error)
      }
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
    ...(positionQuality ? { positionQuality } : {}),
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
  const currentPreShot = parseCurrentShotRecord(roundText)
  const preShotRoundId = asNumber(currentPreShot?.RoundID)
  const preShotCourseKey = asString(currentPreShot?.CourseKey)
  const rawPreShotHole = asNumber(currentPreShot?.Hole)
  const preShotHole = rawPreShotHole == null ? null : Math.round(rawPreShotHole) + 1
  const preShotNumber = asNumber(currentPreShot?.HoleShot)
  const preShotSurface = surfaceFromRaw(asNumber(currentPreShot?.StartingSurface))
  const preShotDistanceMeters = asNumber(currentPreShot?.DistanceToPin)
  const preShotDistanceYds = preShotDistanceMeters == null
    ? null
    : preShotDistanceMeters * METERS_TO_YARDS
  const records = parseRoundRecords(roundText)
  const logState = parseOutputLogHoleState(logTail)

  if (records.length === 0) {
    const waitingHole = preShotHole ?? logState.holeNumber
    if (waitingHole != null) {
      return cachedTeeSnapshot({
        courseKey: preShotCourseKey,
        roundId: preShotRoundId,
        holeNumber: waitingHole,
        warnings: ['Waiting for the first physical shot; using the selected course tee position.'],
      })
    }

    return {
      courseKey: preShotCourseKey,
      roundId: preShotRoundId,
      holeNumber: null,
      ballLocalYds: null,
      ballSource: 'unavailable',
      surface: preShotSurface,
      surfaceSource: preShotSurface ? 'currentRound' : 'unavailable',
      distanceToPinYds: preShotDistanceYds,
      nextShotNumber: preShotNumber,
      latestShot: null,
      latestShotKey: null,
      warnings: ['currentRound.dat did not contain a physical shot record yet.'],
      observedAt: new Date().toISOString(),
    }
  }

  records.sort((a, b) => recordSortValue(a) - recordSortValue(b))
  const newest = records[records.length - 1]
  const activeRoundId = preShotRoundId ?? asNumber(newest.RoundID)
  const roundRecords = activeRoundId == null
    ? records
    : records.filter((record) => asNumber(record.RoundID) === activeRoundId)

  if (roundRecords.length === 0) {
    const waitingHole = preShotHole ?? logState.holeNumber
    if (waitingHole != null) {
      return cachedTeeSnapshot({
        courseKey: preShotCourseKey,
        roundId: activeRoundId,
        holeNumber: waitingHole,
        warnings: ['Current GSPro round has no completed physical shot yet; using the selected course tee position.'],
      })
    }
  }

  const latestRecord = roundRecords[roundRecords.length - 1] ?? newest
  const courseKey = preShotCourseKey ?? asString(latestRecord.CourseKey)
  const observedCourseId = courseKey ? resolveCourseIdFromGsproName(courseKey) : null
  const selectedCourse = getCourseCatalogEntry(selectedCourseId)
  const rawLatestHole = asNumber(latestRecord.Hole)
  const latestRecordHole = rawLatestHole == null ? null : Math.round(rawLatestHole) + 1
  const terminalHole = latestTerminalHoleForRound(roundText, activeRoundId)
  const logHole = logState.holeNumber

  let coordinateCourseId: CourseId | null = null
  if (observedCourseId === selectedCourseId) {
    coordinateCourseId = selectedCourseId
  } else if (
    selectedCourseId === GREYWOLF_COURSE_ID
    && courseKey?.trim().toLowerCase() === 'multi_range_gsp'
  ) {
    coordinateCourseId = selectedCourseId
    warnings.push(
      'GSPro reports the generic multi_range_gsp runtime key; using the user-selected Greywolf registration for live ball placement.',
    )
  } else if (courseKey && observedCourseId && observedCourseId !== selectedCourseId) {
    warnings.push(
      `Selected ${selectedCourse.name}, but GSPro reports ${courseKey}. Keeping the user-selected course until confirmed.`,
    )
  } else if (courseKey && !observedCourseId) {
    warnings.push(
      `GSPro reports ${courseKey}, which is not a reviewed Looper alias yet. Keeping the user-selected ${selectedCourse.name}.`,
    )
  }

  const latestShot = await buildShot(latestRecord, roundRecords, coordinateCourseId)
  if (observedCourseId === selectedCourseId && selectedCourseId !== GREYWOLF_COURSE_ID) {
    warnings.push(latestShot?.positionQuality === 'provisional'
      ? 'Imported-course ball uses provisional GSPro shot movement validated against GSPro remaining distance; OSM tee/pin alignment and exact hazard carries remain uncertain.'
      : 'Imported-course GSPro shot recognized, but no distance-consistent map registration is available; hazard/aim recommendations must stay paused.')
  }

  let holeNumber = preShotHole ?? latestRecordHole
  if (preShotHole == null && logHole != null) {
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
    preShotHole == null
    && latestRecordHole != null
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
      surface: preShotSurface,
      surfaceSource: preShotSurface ? 'currentRound' : 'unavailable',
      distanceToPinYds: preShotDistanceYds,
      nextShotNumber: preShotNumber,
      latestShot,
      latestShotKey: latestShot?.key ?? null,
      warnings,
      observedAt: new Date().toISOString(),
    }
  }

  if (latestRecordHole !== holeNumber) {
    const cached = cachedTeeSnapshot({
      courseKey,
      roundId: activeRoundId,
      holeNumber,
      warnings,
    })
    return {
      ...cached,
      surface: preShotSurface ?? cached.surface,
      surfaceSource: preShotSurface ? 'currentRound' : cached.surfaceSource,
      distanceToPinYds: preShotDistanceYds,
      nextShotNumber: preShotNumber ?? cached.nextShotNumber,
    }
  }

  const currentHoleRecords = roundRecords.filter((record) => asNumber(record.Hole) === holeNumber - 1)
  if (currentHoleRecords.length === 0) {
    const cached = cachedTeeSnapshot({
      courseKey,
      roundId: activeRoundId,
      holeNumber,
      warnings,
    })
    return {
      ...cached,
      surface: preShotSurface ?? cached.surface,
      surfaceSource: preShotSurface ? 'currentRound' : cached.surfaceSource,
      distanceToPinYds: preShotDistanceYds,
      nextShotNumber: preShotNumber ?? cached.nextShotNumber,
    }
  }

  currentHoleRecords.sort((a, b) => recordSortValue(a) - recordSortValue(b))
  const currentRecord = currentHoleRecords[currentHoleRecords.length - 1]
  const currentShot = currentRecord === latestRecord
    ? latestShot
    : await buildShot(currentRecord, roundRecords, coordinateCourseId)
  const currentSurfaceRaw = asNumber(currentRecord.EndingSurface)
  const currentSurface = surfaceFromRaw(currentSurfaceRaw)
  const completedHoleShot = currentShot?.holeShot
  const fallbackNextShotNumber = completedHoleShot != null
    ? Math.max(1, Math.round(completedHoleShot) + 1)
    : currentHoleRecords.length + 1

  return {
    courseKey,
    roundId: activeRoundId,
    holeNumber,
    ballLocalYds: currentShot?.endLocalYds ?? null,
    ballSource: currentShot?.endLocalYds
      ? currentShot.positionQuality === 'provisional' ? 'world-provisional' : 'currentRound'
      : 'unavailable',
    surface: preShotSurface ?? currentSurface,
    surfaceSource: preShotSurface || currentSurface ? 'currentRound' : 'unavailable',
    distanceToPinYds: preShotDistanceYds ?? currentShot?.distanceToPinYds ?? null,
    nextShotNumber: preShotNumber ?? fallbackNextShotNumber,
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
