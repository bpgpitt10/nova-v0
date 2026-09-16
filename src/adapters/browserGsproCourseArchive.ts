import {
  loadGsproDirectoryHandle,
  queryGsproDirectoryPermission,
  type BrowserDirectoryHandle,
} from './browserGsproAccess'
import { loadGsproCourseStateDirectoryHandle } from './browserGsproCourseState'

type Vec3 = {
  x?: unknown
  y?: unknown
  z?: unknown
}

type ShotData = {
  tdpoint?: Vec3
  isHoled?: unknown
  isGimme?: unknown
}

type GhostData = {
  lmfSP?: unknown
  lmfEL?: unknown
  lmfAZ?: unknown
  lmfSS?: unknown
  lmfTS?: unknown
  lmfBS?: unknown
  lmfSA?: unknown
  atShotData?: ShotData
}

type ActiveShot = {
  sd?: ShotData
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
  ClubIndex?: unknown
  StartingPOS?: Vec3
  EndingPOS?: Vec3
  GhostData?: GhostData
  activeShot?: ActiveShot
}

export type BrowserGsproCourseArchiveShot = {
  key: string
  roundId: number
  holeNumber: number
  holeShot: number | null
  globalShotNumber: number | null
  shotId: string
  courseKey: string | null
  startingSurfaceRaw: number | null
  endingSurfaceRaw: number | null
  distanceToPinYds: number | null
  ballSpeedMph: number | null
  carryYards: number | null
  totalYards: number | null
  verticalLaunchAngleDegrees: number | null
  horizontalLaunchAngleDegrees: number | null
  totalSpinRpm: number | null
  spinAxisDegrees: number | null
  backSpinRpm: number | null
  sideSpinRpm: number | null
  gsproClubIndex: number | null
  rawMetrics: Record<string, unknown>
}

export type BrowserGsproCourseArchiveRound = {
  roundId: number
  courseKey: string | null
  shots: BrowserGsproCourseArchiveShot[]
}

const CURRENT_ROUND_FILE = 'currentRound.dat'
const METERS_TO_YARDS = 1.0936132983377078

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

const vec3 = (value: unknown): { x: number; y: number; z: number } | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Vec3
  const x = asNumber(candidate.x)
  const y = asNumber(candidate.y)
  const z = asNumber(candidate.z)
  return x == null || y == null || z == null ? null : { x, y, z }
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

const parsePhysicalRoundRecords = (text: string): RoundShotRecord[] => {
  const seen = new Set<string>()
  return parseRoundCandidates(text).flatMap((record): RoundShotRecord[] => {
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

const touchdownPoint = (record: RoundShotRecord) =>
  vec3(record.GhostData?.atShotData?.tdpoint)
    ?? vec3(record.activeShot?.sd?.tdpoint)

const carryDistanceYards = (record: RoundShotRecord) => {
  const start = vec3(record.StartingPOS)
  const touchdown = touchdownPoint(record)
  if (!start || !touchdown) return null
  const meters = Math.hypot(touchdown.x - start.x, touchdown.z - start.z)
  return Number.isFinite(meters) ? meters * METERS_TO_YARDS : null
}

const buildArchiveShot = (record: RoundShotRecord): BrowserGsproCourseArchiveShot | null => {
  const roundId = asNumber(record.RoundID)
  const holeIndex = asNumber(record.Hole)
  const shotId = asString(record.ShotID)
  if (roundId == null || holeIndex == null || !shotId) return null

  const holeNumber = Math.round(holeIndex) + 1
  if (holeNumber < 1 || holeNumber > 18) return null

  const ghost = record.GhostData
  const startingPositionMeters = vec3(record.StartingPOS)
  const endingPositionMeters = vec3(record.EndingPOS)
  const touchdownPositionMeters = touchdownPoint(record)
  const distanceToPinMeters = asNumber(record.DistanceToPin)
  const totalDistanceMeters = asNumber(record.TotalDistance)
  const rawBallSpeed = asNumber(record.BallSpeed)
  const lmfSP = asNumber(ghost?.lmfSP)
  const lmfEL = asNumber(ghost?.lmfEL)
  const lmfAZ = asNumber(ghost?.lmfAZ)
  const lmfSS = asNumber(ghost?.lmfSS)
  const lmfTS = asNumber(ghost?.lmfTS)
  const lmfBS = asNumber(ghost?.lmfBS)
  const lmfSA = asNumber(ghost?.lmfSA)

  return {
    key: `${roundId}:${holeNumber}:${shotId}`,
    roundId,
    holeNumber,
    holeShot: asNumber(record.HoleShot),
    globalShotNumber: asNumber(record.GlobalShotNumber),
    shotId,
    courseKey: asString(record.CourseKey),
    startingSurfaceRaw: asNumber(record.StartingSurface),
    endingSurfaceRaw: asNumber(record.EndingSurface),
    distanceToPinYds: distanceToPinMeters == null ? null : distanceToPinMeters * METERS_TO_YARDS,
    ballSpeedMph: lmfSP ?? rawBallSpeed,
    carryYards: carryDistanceYards(record),
    totalYards: totalDistanceMeters == null ? null : totalDistanceMeters * METERS_TO_YARDS,
    verticalLaunchAngleDegrees: lmfEL,
    horizontalLaunchAngleDegrees: lmfAZ,
    totalSpinRpm: lmfTS,
    spinAxisDegrees: lmfSA,
    backSpinRpm: lmfBS,
    sideSpinRpm: lmfSS,
    gsproClubIndex: asNumber(record.ClubIndex),
    rawMetrics: {
      ballSpeedRaw: rawBallSpeed,
      totalDistanceMeters,
      distanceToPinMeters,
      lmfSP,
      lmfEL,
      lmfAZ,
      lmfSS,
      lmfTS,
      lmfBS,
      lmfSA,
      startingPositionMeters,
      endingPositionMeters,
      touchdownPositionMeters,
    },
  }
}

const readableHandle = async (handle: BrowserDirectoryHandle | null) => {
  if (!handle) return null
  const permission = await queryGsproDirectoryPermission(handle, 'read').catch(() => 'denied' as const)
  if (permission !== 'granted') return null
  try {
    const fileHandle = await handle.getFileHandle(CURRENT_ROUND_FILE)
    await fileHandle.getFile()
    return handle
  } catch {
    return null
  }
}

const resolveCourseStateHandle = async () => {
  const primary = await loadGsproDirectoryHandle().catch(() => null)
  const readablePrimary = await readableHandle(primary)
  if (readablePrimary) return readablePrimary

  const fallback = await loadGsproCourseStateDirectoryHandle().catch(() => null)
  return readableHandle(fallback)
}

export const readBrowserGsproCourseRoundArchive = async (): Promise<BrowserGsproCourseArchiveRound | null> => {
  const handle = await resolveCourseStateHandle()
  if (!handle) return null

  const fileHandle = await handle.getFileHandle(CURRENT_ROUND_FILE)
  const roundText = await (await fileHandle.getFile()).text()
  const records = parsePhysicalRoundRecords(roundText)
  if (records.length === 0) return null

  records.sort((left, right) => recordSortValue(left) - recordSortValue(right))
  const newest = records[records.length - 1]
  const roundId = asNumber(newest.RoundID)
  if (roundId == null) return null

  const activeRoundRecords = records
    .filter((record) => asNumber(record.RoundID) === roundId)
    .sort((left, right) => recordSortValue(left) - recordSortValue(right))
  const shots = activeRoundRecords.flatMap((record): BrowserGsproCourseArchiveShot[] => {
    const shot = buildArchiveShot(record)
    return shot ? [shot] : []
  })

  if (shots.length === 0) return null
  return {
    roundId,
    courseKey: asString(activeRoundRecords[activeRoundRecords.length - 1]?.CourseKey),
    shots,
  }
}
