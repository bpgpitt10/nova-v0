import {
  loadGsproDirectoryHandle,
  type BrowserDirectoryHandle,
} from '../adapters/browserGsproAccess'
import { loadGsproCourseStateDirectoryHandle } from '../adapters/browserGsproCourseStateCore'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import { matchingTeeCandidates, courseGeometryFingerprint } from '../courseGeometry/shotOneTeeResolver'
import {
  confirmTeeCalibration,
  loadTeeCalibration,
  saveTeeCalibrationCandidate,
} from '../courseGeometry/teeCalibrationStore'
import {
  LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT,
  loadActiveLiveCaddieRound,
  type LiveCaddieShotStateChangedDetail,
} from './roundRuntime'

const CURRENT_ROUND_FILE = 'currentRound.dat'
const SAME_TEE_WORLD_TOLERANCE = 5

type RawShot = {
  ShotID?: unknown
  RoundID?: unknown
  Hole?: unknown
  HoleShot?: unknown
  GlobalShotNumber?: unknown
  BallSpeed?: unknown
  TotalDistance?: unknown
  StartingPOS?: unknown
}

type WorldPoint = { x: number; y: number; z: number }

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const asNumber = (value: unknown) => {
  if (finite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const worldPoint = (value: unknown): WorldPoint | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const x = asNumber(raw.x)
  const y = asNumber(raw.y)
  const z = asNumber(raw.z)
  return x == null || y == null || z == null ? null : { x, y, z }
}

const roundCandidates = (text: string): RawShot[] => {
  const parsed = JSON.parse(text) as unknown
  if (Array.isArray(parsed)) {
    return parsed.filter((value): value is RawShot => Boolean(value && typeof value === 'object' && !Array.isArray(value)))
  }
  if (!parsed || typeof parsed !== 'object') return []
  return Object.values(parsed as Record<string, unknown>).flatMap((value) =>
    Array.isArray(value)
      ? value.filter((item): item is RawShot => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      : [],
  )
}

const completedShotOneStart = (
  text: string,
  holeNumber: number,
  roundId: number | null | undefined,
) => {
  const candidates = roundCandidates(text)
    .filter((shot) => asNumber(shot.Hole) === holeNumber - 1)
    .filter((shot) => asNumber(shot.HoleShot) === 1)
    .filter((shot) => roundId == null || asNumber(shot.RoundID) === roundId)
    .filter((shot) => (asNumber(shot.BallSpeed) ?? 0) > 0 || (asNumber(shot.TotalDistance) ?? 0) > 0)
    .map((shot) => ({
      shot,
      world: worldPoint(shot.StartingPOS),
      order: asNumber(shot.GlobalShotNumber) ?? 0,
    }))
    .filter((entry): entry is { shot: RawShot; world: WorldPoint; order: number } => entry.world != null)
    .sort((left, right) => right.order - left.order)
  return candidates[0] ?? null
}

const readCurrentRound = async () => {
  const primary = await loadGsproDirectoryHandle().catch(() => null)
  const dedicated = await loadGsproCourseStateDirectoryHandle().catch(() => null)
  const handles: BrowserDirectoryHandle[] = []
  if (primary) handles.push(primary)
  if (dedicated && dedicated !== primary) handles.push(dedicated)

  for (const handle of handles) {
    try {
      const fileHandle = await handle.getFileHandle(CURRENT_ROUND_FILE)
      return await (await fileHandle.getFile()).text()
    } catch {
      // Try the next prepared GSPro handle.
    }
  }
  return null
}

const worldDistance = (left: WorldPoint, right: WorldPoint) =>
  Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)

const validateShotOne = async (detail: LiveCaddieShotStateChangedDetail) => {
  if (detail.source !== 'gspro' || !detail.latestShotKey || detail.holeNumber == null) return
  const round = loadActiveLiveCaddieRound()
  if (!round || detail.holeNumber < 1 || detail.holeNumber > 18) return

  const text = await readCurrentRound()
  if (!text) return
  const observed = completedShotOneStart(text, detail.holeNumber, detail.roundId)
  if (!observed) return

  const geometry = await loadCourseHoleGeometry(round.courseId, detail.holeNumber)
  const matches = matchingTeeCandidates(geometry, round.normalizedTeeSet)
  const candidate = matches.length === 1 ? matches[0] : null
  const fingerprint = courseGeometryFingerprint(geometry)
  const existing = loadTeeCalibration(fingerprint, detail.holeNumber, round.normalizedTeeSet)
  const input = {
    courseFingerprint: fingerprint,
    holeNumber: detail.holeNumber,
    teeSet: round.normalizedTeeSet,
    teeLabel: round.teeSet,
    ...(candidate?.osmId != null ? { osmTeeId: candidate.osmId } : {}),
    courseLocalYds: geometry.markers.tee,
    gsproWorld: observed.world,
    ...(candidate?.teeToGreenCentroidYards != null
      ? { expectedYardageYds: candidate.teeToGreenCentroidYards }
      : {}),
    confidence: existing?.gsproWorld ? 0.85 : 0.7,
    confirmationMethod: existing?.gsproWorld
      ? 'repeated-completed-shot-one-starting-position'
      : 'first-completed-shot-one-starting-position',
  }

  if (!existing?.gsproWorld) {
    saveTeeCalibrationCandidate(input)
    console.info('[Live Caddie tee validation] Captured first GSPro tee observation.', {
      holeNumber: detail.holeNumber,
      teeSet: round.teeSet,
      world: observed.world,
    })
    return
  }

  const delta = worldDistance(existing.gsproWorld, observed.world)
  if (delta <= SAME_TEE_WORLD_TOLERANCE) {
    confirmTeeCalibration(input)
    console.info('[Live Caddie tee validation] Repeated GSPro tee observation confirmed the assumption.', {
      holeNumber: detail.holeNumber,
      teeSet: round.teeSet,
      worldDelta: delta,
    })
    return
  }

  console.warn('[Live Caddie tee validation] GSPro tee observation does not match the prior assumption.', {
    holeNumber: detail.holeNumber,
    teeSet: round.teeSet,
    worldDelta: delta,
    priorWorld: existing.gsproWorld,
    observedWorld: observed.world,
  })
}

export const startLiveCaddieRoundTeeValidator = () => {
  if (typeof window === 'undefined') return () => undefined
  let busy = false
  const observedKeys = new Set<string>()

  const onShotStateChanged = (event: Event) => {
    const detail = (event as CustomEvent<LiveCaddieShotStateChangedDetail>).detail
    if (!detail || detail.source !== 'gspro' || !detail.latestShotKey) return
    const key = `${detail.holeNumber ?? 'hole'}:${detail.latestShotKey}`
    if (observedKeys.has(key) || busy) return
    observedKeys.add(key)
    busy = true
    void validateShotOne(detail)
      .catch((error) => console.warn('[Live Caddie tee validation] Validation failed.', error))
      .finally(() => {
        busy = false
      })
  }

  window.addEventListener(LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT, onShotStateChanged)
  return () => window.removeEventListener(LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT, onShotStateChanged)
}
