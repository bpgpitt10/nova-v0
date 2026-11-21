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
  isPutt?: unknown
  TargetDirection?: unknown
  bounceForce?: Vec3
  path?: unknown
}

type GhostData = {
  lmfSP?: unknown
  lmfEL?: unknown
  lmfAZ?: unknown
  lmfSS?: unknown
  lmfTS?: unknown
  lmfBS?: unknown
  lmfSA?: unknown
  az?: unknown
  ballDirection?: unknown
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
  PlayerName?: unknown
  UserGuid?: unknown
  StartingPOS?: Vec3
  EndingPOS?: Vec3
  GhostData?: GhostData
  activeShot?: ActiveShot
}

/**
 * Who hit a shot. GSPro writes the player's name and GSPro account id on every
 * record; on a shared sim one round holds several players (each with their own
 * id, seen in real rounds 21 Nov 2026). `key` is the id, or the name when a
 * record has no id.
 */
export type GsproPlayer = { key: string; name: string | null; guid: string | null }

export type BrowserGsproCourseArchiveShot = {
  key: string
  player: GsproPlayer
  roundId: number
  holeNumber: number
  holeShot: number | null
  globalShotNumber: number | null
  shotId: string
  courseKey: string | null
  startingSurfaceRaw: number | null
  endingSurfaceRaw: number | null
  distanceToPinYds: number | null
  isHoled: boolean
  isGimme: boolean
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

/**
 * Everything GSPro wrote about one putt, kept whole for putting analysis:
 * the roll path and every plain field on the record. Too big for the browser's
 * round archive, so it goes to its own cloud table (see livePuttDetails.ts).
 */
export type BrowserGsproPuttDetail = {
  playerKey: string
  roundId: number
  shotId: string
  courseKey: string | null
  holeNumber: number
  holeShot: number | null
  globalShotNumber: number | null
  detail: {
    schema: 'gspro-putt-detail-v1'
    /** [seconds, x, y, z] in GSPro world metres, as GSPro recorded the roll. */
    path: number[][]
    record: Record<string, unknown>
    shotData: Record<string, unknown>
    ghost: Record<string, unknown>
    ghostShotData: Record<string, unknown>
  }
}

export type BrowserGsproCourseArchiveRound = {
  roundId: number
  courseKey: string | null
  /** Everyone with a shot in the round, in order of their first shot. */
  players: Array<GsproPlayer & { shots: number }>
  shots: BrowserGsproCourseArchiveShot[]
  puttDetails: BrowserGsproPuttDetail[]
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

const EMPTY_GUID = /^[0-]*$/

export const gsproPlayerOf = (record: { PlayerName?: unknown; UserGuid?: unknown }): GsproPlayer => {
  const rawGuid = asString(record.UserGuid)
  const guid = rawGuid && !EMPTY_GUID.test(rawGuid) ? rawGuid.toLowerCase() : null
  const name = asString(record.PlayerName)
  return { key: guid ?? (name ? `name:${name.toLowerCase()}` : 'unknown'), name, guid }
}

/** The players in a round's shots, in order of their first shot, with how many shots each hit. */
export const gsproPlayersOf = (shots: readonly { player: GsproPlayer }[]) => {
  const players = new Map<string, GsproPlayer & { shots: number }>()
  for (const { player } of shots) {
    const known = players.get(player.key)
    if (known) {
      known.shots += 1
      if (!known.name && player.name) known.name = player.name
    } else {
      players.set(player.key, { ...player, shots: 1 })
    }
  }
  return [...players.values()]
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

const parsePhysicalRoundRecords = (text: string): RoundShotRecord[] =>
  filterPhysicalRoundRecords(parseRoundCandidates(text))

const filterPhysicalRoundRecords = (candidates: readonly RoundShotRecord[]): RoundShotRecord[] => {
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

/** GSPro surface code for the green. */
const GREEN_SURFACE_RAW = 5
const MAX_PUTT_PATH_POINTS = 400

const isPuttRecord = (record: RoundShotRecord) =>
  asBoolean(record.activeShot?.sd?.isPutt)
  || asBoolean(record.GhostData?.atShotData?.isPutt)
  || asNumber(record.StartingSurface) === GREEN_SURFACE_RAW

/** Plain fields of a GSPro object: numbers, text, true/false and x/y/z points. Lists and nested objects are left out. */
const plainFields = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (typeof field === 'number') { if (Number.isFinite(field)) out[key] = field }
    else if (typeof field === 'boolean') out[key] = field
    else if (typeof field === 'string') { if (field.length <= 200) out[key] = field }
    else { const point = vec3(field); if (point) out[key] = point }
  }
  return out
}

const round4 = (value: number) => Math.round(value * 10000) / 10000

const puttPath = (record: RoundShotRecord): number[][] => {
  const raw = record.activeShot?.sd?.path ?? record.GhostData?.atShotData?.path
  if (!Array.isArray(raw)) return []
  return raw.slice(0, MAX_PUTT_PATH_POINTS).flatMap((point): number[][] => {
    if (!point || typeof point !== 'object') return []
    const time = asNumber((point as { time?: unknown }).time)
    const pos = vec3((point as { pos?: unknown }).pos)
    return time == null || !pos ? [] : [[round4(time), round4(pos.x), round4(pos.y), round4(pos.z)]]
  })
}

/**
 * Where the ball was as it passed the hole: the point on the roll path level
 * with the cup along the start-to-cup line. Null when the putt never got there.
 * A ball keeps breaking after the hole, so this, not where it stopped, is the
 * sideways miss (checked on 200 stored putts, 18 Nov: 6 in apart on average).
 */
export const puttPassPoint = (
  path: readonly (readonly number[])[],
  start: { x: number; z: number } | null,
  cup: { x: number; z: number } | null,
): { x: number; y: number; z: number } | null => {
  if (!start || !cup || path.length < 2) return null
  const dx = cup.x - start.x
  const dz = cup.z - start.z
  const length = Math.hypot(dx, dz)
  if (length < 0.05) return null
  const along = (point: readonly number[]) => ((point[1] - start.x) * dx + (point[3] - start.z) * dz) / length
  for (let index = 1; index < path.length; index += 1) {
    const before = along(path[index - 1])
    const after = along(path[index])
    if (before < length && after >= length) {
      const share = (length - before) / (after - before)
      const at = (axis: number) => round4(path[index - 1][axis] + (path[index][axis] - path[index - 1][axis]) * share)
      return { x: at(1), y: at(2), z: at(3) }
    }
  }
  return null
}

const buildPuttDetail = (record: RoundShotRecord): BrowserGsproPuttDetail | null => {
  if (!isPuttRecord(record)) return null
  const roundId = asNumber(record.RoundID)
  const holeIndex = asNumber(record.Hole)
  const shotId = asString(record.ShotID)
  if (roundId == null || holeIndex == null || !shotId) return null
  return {
    playerKey: gsproPlayerOf(record).key,
    roundId,
    shotId,
    courseKey: asString(record.CourseKey),
    holeNumber: Math.round(holeIndex) + 1,
    holeShot: asNumber(record.HoleShot),
    globalShotNumber: asNumber(record.GlobalShotNumber),
    detail: {
      schema: 'gspro-putt-detail-v1',
      path: puttPath(record),
      record: plainFields(record),
      shotData: plainFields(record.activeShot?.sd),
      ghost: plainFields(record.GhostData),
      ghostShotData: plainFields(record.GhostData?.atShotData),
    },
  }
}

const buildPuttDetails = (records: readonly RoundShotRecord[]) =>
  records.flatMap((record): BrowserGsproPuttDetail[] => {
    const detail = buildPuttDetail(record)
    return detail ? [detail] : []
  })

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
  const isHoled = asBoolean(record.activeShot?.sd?.isHoled)
    || asBoolean(ghost?.atShotData?.isHoled)
  const isGimme = asBoolean(record.activeShot?.sd?.isGimme)
    || asBoolean(ghost?.atShotData?.isGimme)
  const lmfSP = asNumber(ghost?.lmfSP)
  const lmfEL = asNumber(ghost?.lmfEL)
  const lmfAZ = asNumber(ghost?.lmfAZ)
  const lmfSS = asNumber(ghost?.lmfSS)
  const lmfTS = asNumber(ghost?.lmfTS)
  const lmfBS = asNumber(ghost?.lmfBS)
  const lmfSA = asNumber(ghost?.lmfSA)
  // Putts: where GSPro was aimed and where the ball actually started, small
  // enough to keep with the shot. The roll path is in the putt detail.
  const sd = record.activeShot?.sd ?? ghost?.atShotData
  const putt = isPuttRecord(record)
    ? {
        isPutt: true,
        targetDirectionDeg: asNumber(sd?.TargetDirection),
        ballDirectionDeg: asNumber(ghost?.ballDirection),
        startOffsetDeg: asNumber(ghost?.az) ?? lmfAZ,
        puttVector: vec3(sd?.bounceForce),
        pathPoints: puttPath(record).length,
        passHole: puttPassPoint(puttPath(record), startingPositionMeters, touchdownPositionMeters),
      }
    : null

  const player = gsproPlayerOf(record)
  return {
    key: `${roundId}:${holeNumber}:${shotId}`,
    player,
    roundId,
    holeNumber,
    holeShot: asNumber(record.HoleShot),
    globalShotNumber: asNumber(record.GlobalShotNumber),
    shotId,
    courseKey: asString(record.CourseKey),
    startingSurfaceRaw: asNumber(record.StartingSurface),
    endingSurfaceRaw: asNumber(record.EndingSurface),
    distanceToPinYds: distanceToPinMeters == null ? null : distanceToPinMeters * METERS_TO_YARDS,
    isHoled,
    isGimme,
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
      gsproPlayer: player.name,
      ballSpeedRaw: rawBallSpeed,
      totalDistanceMeters,
      distanceToPinMeters,
      isHoled,
      isGimme,
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
      ...(putt ? { putt } : {}),
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
    players: gsproPlayersOf(shots),
    shots,
    puttDetails: buildPuttDetails(activeRoundRecords),
  }
}

/**
 * Rounds from raw currentRound.dat records kept by the Looper Companion's
 * round recorder. Same filters and shot mapping as the live file, every round
 * (not only the newest). Later entries win for a repeated ShotID.
 */
export const archiveRoundsFromRecords = (
  records: readonly unknown[],
): BrowserGsproCourseArchiveRound[] => {
  const latestByShot = new Map<string, RoundShotRecord>()
  for (const candidate of records) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as RoundShotRecord
    const key = `${asNumber(record.RoundID)}:${asString(record.ShotID)}`
    latestByShot.delete(key)
    latestByShot.set(key, record)
  }

  const byRound = new Map<number, RoundShotRecord[]>()
  for (const record of latestByShot.values()) {
    const roundId = asNumber(record.RoundID)
    if (roundId == null) continue
    const list = byRound.get(roundId) ?? []
    list.push(record)
    byRound.set(roundId, list)
  }

  return [...byRound.entries()].flatMap(([roundId, candidates]) => {
    // Filter per round: shot IDs are only guaranteed unique within a round.
    const roundRecords = filterPhysicalRoundRecords(candidates)
    roundRecords.sort((left, right) => recordSortValue(left) - recordSortValue(right))
    const shots = roundRecords.flatMap((record): BrowserGsproCourseArchiveShot[] => {
      const shot = buildArchiveShot(record)
      return shot ? [shot] : []
    })
    if (shots.length === 0) return []
    return [{
      roundId,
      courseKey: asString(roundRecords[roundRecords.length - 1]?.CourseKey),
      players: gsproPlayersOf(shots),
      shots,
      puttDetails: buildPuttDetails(roundRecords),
    }]
  })
}
