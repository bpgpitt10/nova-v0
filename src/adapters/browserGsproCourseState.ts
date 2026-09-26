import {
  resolveCourseIdFromGsproName,
  UNSELECTED_COURSE_ID,
} from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import { loadLastSelectedCourseId } from '../courseGeometry/courseSelection'
import { resolveLiveSupportedTee } from '../courseGeometry/liveSupportedTee'
import type { CourseHoleGeometry } from '../courseGeometry/types'
import {
  dispatchLiveCaddieShotStateChanged,
  LIVE_CADDIE_START_ROUND_EVENT,
} from '../liveCaddie/roundRuntime'
import { loadGsproDirectoryHandle } from './browserGsproAccess'
import {
  connectToBrowserGsproCourseState as connectCoreCourseState,
  loadGsproCourseStateDirectoryHandle,
  type BrowserGsproCourseSnapshot as CoreBrowserGsproCourseSnapshot,
} from './browserGsproCourseStateCore'
import {
  parseGsproStartingPosition,
  type GsproStartingPositionObservation,
} from './gsproStartingPosition'

export {
  chooseGsproCourseStateDirectory,
  connectBrowserGsproCourseStateFolder,
  isBrowserGsproCourseStatePrepared,
  loadGsproCourseStateDirectoryHandle,
  prepareBrowserGsproCourseStateRuntime,
  saveGsproCourseStateDirectoryHandle,
} from './browserGsproCourseStateCore'

export type {
  BrowserGsproCourseConnection,
  BrowserGsproCourseShot,
  BrowserGsproCourseStatus,
} from './browserGsproCourseStateCore'

export type BrowserGsproCourseSnapshot = Omit<
  CoreBrowserGsproCourseSnapshot,
  'ballSource' | 'surfaceSource'
> & {
  ballSource: CoreBrowserGsproCourseSnapshot['ballSource'] | 'osm-tee-match'
  surfaceSource: CoreBrowserGsproCourseSnapshot['surfaceSource'] | 'gspro-startingpos'
  preShotStart: GsproStartingPositionObservation | null
}

type SnapshotHandler = (snapshot: BrowserGsproCourseSnapshot) => void

type ReadableDirectoryHandle = {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    getFile(): Promise<File>
  }>
}

const CURRENT_ROUND_FILE = 'currentRound.dat'
const liveTeeGeometryCache = new Map<string, Promise<CourseHoleGeometry>>()

const readCurrentRoundFromHandle = async (handle: ReadableDirectoryHandle | null) => {
  if (!handle) return null
  try {
    const fileHandle = await handle.getFileHandle(CURRENT_ROUND_FILE)
    return await (await fileHandle.getFile()).text()
  } catch {
    return null
  }
}

const readCurrentRoundText = async () => {
  const primary = await loadGsproDirectoryHandle().catch(() => null)
  const primaryText = await readCurrentRoundFromHandle(primary)
  if (primaryText != null) return primaryText

  const dedicated = await loadGsproCourseStateDirectoryHandle().catch(() => null)
  if (dedicated === primary) return null
  return readCurrentRoundFromHandle(dedicated)
}

const dedupeWarnings = (warnings: string[]) => [...new Set(warnings)]

const loadLiveTeeGeometry = (
  courseId: Exclude<ReturnType<typeof loadLastSelectedCourseId>, typeof UNSELECTED_COURSE_ID>,
  holeNumber: number,
) => {
  const key = `${courseId}:${holeNumber}`
  const cached = liveTeeGeometryCache.get(key)
  if (cached) return cached
  const pending = loadCourseHoleGeometry(courseId, holeNumber)
    .catch((error) => {
      liveTeeGeometryCache.delete(key)
      throw error
    })
  liveTeeGeometryCache.set(key, pending)
  return pending
}

const unavailableShotOneSnapshot = (
  snapshot: CoreBrowserGsproCourseSnapshot,
  preShotStart: GsproStartingPositionObservation | null,
  holeNumber: number,
  warning: string,
): BrowserGsproCourseSnapshot => ({
  ...snapshot,
  preShotStart,
  courseKey: preShotStart?.courseKey ?? snapshot.courseKey,
  roundId: preShotStart?.roundId ?? snapshot.roundId,
  holeNumber,
  ballLocalYds: null,
  ballSource: 'unavailable',
  surface: preShotStart?.surface ?? 'tee',
  surfaceSource: preShotStart ? 'gspro-startingpos' : 'cached-tee',
  distanceToPinYds: preShotStart?.distanceToPinYds ?? snapshot.distanceToPinYds,
  nextShotNumber: 1,
  warnings: dedupeWarnings([...snapshot.warnings, warning]),
})

const enrichSnapshotWithStartingPosition = async (
  snapshot: CoreBrowserGsproCourseSnapshot,
): Promise<BrowserGsproCourseSnapshot> => {
  const roundText = await readCurrentRoundText()
  const preShotStart = roundText == null
    ? null
    : parseGsproStartingPosition(roundText, snapshot.holeNumber)

  // GSPro uses raw surface 11 for the bunker/sand state encountered in live
  // play. The core map historically only knew raw 3, so a ball clearly shown as
  // Sand by GSPro could fall through to OSM and appear as Rough. Preserve the
  // currentRound source and normalize that second bunker code at this seam.
  const normalizedSurface = snapshot.surface
    ?? (snapshot.latestShot?.endingSurfaceRaw === 11 ? 'sand' : null)
  const base: BrowserGsproCourseSnapshot = {
    ...snapshot,
    surface: normalizedSurface,
    surfaceSource: normalizedSurface && snapshot.surface == null
      ? 'currentRound'
      : snapshot.surfaceSource,
    preShotStart,
  }

  const liveHoleNumber = preShotStart?.holeNumber ?? snapshot.holeNumber
  const preShotIsTee = Boolean(
    preShotStart
    && (preShotStart.surface === 'tee' || preShotStart.shotNumber === 1),
  )
  const teeContext = liveHoleNumber != null
    && snapshot.nextShotNumber === 1
    && (preShotStart == null || preShotIsTee)
  if (!teeContext || liveHoleNumber == null) return base

  const selectedCourseId = loadLastSelectedCourseId()
  if (selectedCourseId === UNSELECTED_COURSE_ID) {
    return unavailableShotOneSnapshot(
      snapshot,
      preShotStart,
      liveHoleNumber,
      'Choose the Looper course before Shot 1 so the GSPro tee can be reconciled to imported OSM geometry.',
    )
  }

  const observedCourseId = preShotStart?.courseKey
    ? resolveCourseIdFromGsproName(preShotStart.courseKey)
    : null
  if (observedCourseId && observedCourseId !== selectedCourseId) {
    return unavailableShotOneSnapshot(
      snapshot,
      preShotStart,
      liveHoleNumber,
      `GSPro reports ${preShotStart?.courseKey}; Looper is set to a different course, so Shot 1 was not reconciled.`,
    )
  }

  const geometry = await loadLiveTeeGeometry(selectedCourseId, liveHoleNumber)
  const resolution = resolveLiveSupportedTee(geometry, preShotStart)
  if (resolution.status !== 'supported') {
    return unavailableShotOneSnapshot(
      snapshot,
      preShotStart,
      liveHoleNumber,
      `Unsupported tee for Looper V1: ${resolution.reason}`,
    )
  }

  return {
    ...base,
    courseKey: preShotStart?.courseKey ?? snapshot.courseKey,
    roundId: preShotStart?.roundId ?? snapshot.roundId,
    holeNumber: liveHoleNumber,
    ballLocalYds: resolution.courseLocalYds,
    ballSource: 'osm-tee-match',
    surface: preShotStart?.surface ?? 'tee',
    surfaceSource: preShotStart ? 'gspro-startingpos' : 'cached-tee',
    distanceToPinYds: preShotStart?.distanceToPinYds ?? snapshot.distanceToPinYds,
    nextShotNumber: 1,
    warnings: dedupeWarnings(snapshot.warnings),
  }
}

const buildManualStartSnapshot = async (
  selectedCourseId: Exclude<ReturnType<typeof loadLastSelectedCourseId>, typeof UNSELECTED_COURSE_ID>,
): Promise<BrowserGsproCourseSnapshot> => {
  const holeNumber = 1
  const geometry = await loadLiveTeeGeometry(selectedCourseId, holeNumber)
  const resolution = resolveLiveSupportedTee(geometry, null)
  const tee = resolution.status === 'supported'
    ? resolution.courseLocalYds
    : geometry.markers.tee
  const pin = geometry.markers.pin
  const distanceToPinYds = pin
    ? Math.hypot(pin[0] - tee[0], pin[1] - tee[1])
    : null

  return {
    courseKey: null,
    roundId: null,
    holeNumber,
    ballLocalYds: tee,
    ballSource: 'osm-tee-match',
    surface: 'tee',
    surfaceSource: 'cached-tee',
    distanceToPinYds,
    nextShotNumber: 1,
    latestShot: null,
    latestShotKey: null,
    warnings: [],
    observedAt: new Date().toISOString(),
    preShotStart: null,
  }
}

const physicalSnapshotIdentity = (snapshot: CoreBrowserGsproCourseSnapshot | null) =>
  snapshot?.latestShotKey
    ? `${snapshot.roundId ?? 'round'}:${snapshot.latestShotKey}`
    : null

export const connectToBrowserGsproCourseState = ({
  onSnapshot,
  onStatusChange,
  onError,
}: {
  onSnapshot: SnapshotHandler
  onStatusChange?: Parameters<typeof connectCoreCourseState>[0]['onStatusChange']
  onError?: Parameters<typeof connectCoreCourseState>[0]['onError']
}) => {
  let disconnected = false
  let snapshotSequence = 0
  let lastCoreSnapshot: CoreBrowserGsproCourseSnapshot | null = null
  let manualStartActive = false
  let manualStartBaselineCaptured = false
  let manualStartBaselineIdentity: string | null = null
  let lastPublishedShotStateKey: string | null = null

  const publishSnapshot = (
    snapshot: BrowserGsproCourseSnapshot,
    source: 'manual-start' | 'gspro',
  ) => {
    onSnapshot(snapshot)
    const key = source === 'manual-start'
      ? 'manual-start:1:1'
      : `${snapshot.roundId ?? 'round'}:${snapshot.holeNumber ?? 'hole'}:${snapshot.nextShotNumber ?? 'shot'}:${snapshot.latestShotKey ?? 'none'}`
    if (key === lastPublishedShotStateKey) return
    lastPublishedShotStateKey = key
    dispatchLiveCaddieShotStateChanged({
      key,
      courseKey: snapshot.courseKey,
      roundId: snapshot.roundId,
      holeNumber: snapshot.holeNumber,
      nextShotNumber: snapshot.nextShotNumber,
      surface: snapshot.surface,
      surfaceSource: snapshot.surfaceSource,
      distanceToPinYds: snapshot.distanceToPinYds,
      ballLocalYds: snapshot.ballLocalYds,
      latestShotKey: snapshot.latestShotKey,
      source,
    })
  }

  const onStartRound = () => {
    if (disconnected) return
    const selectedCourseId = loadLastSelectedCourseId()
    if (selectedCourseId === UNSELECTED_COURSE_ID) return

    manualStartActive = true
    manualStartBaselineCaptured = lastCoreSnapshot !== null
    manualStartBaselineIdentity = physicalSnapshotIdentity(lastCoreSnapshot)
    const sequence = ++snapshotSequence

    void buildManualStartSnapshot(selectedCourseId)
      .then((snapshot) => {
        if (disconnected || sequence !== snapshotSequence || !manualStartActive) return
        publishSnapshot(snapshot, 'manual-start')
      })
      .catch((error) => {
        if (disconnected || sequence !== snapshotSequence) return
        console.warn('[Browser GSPro course state] Could not establish manual Shot 1 tee state.', error)
        onError?.(error)
      })
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(LIVE_CADDIE_START_ROUND_EVENT, onStartRound)
  }

  const coreConnection = connectCoreCourseState({
    onStatusChange,
    onError,
    onSnapshot: (snapshot) => {
      lastCoreSnapshot = snapshot

      if (manualStartActive) {
        if (!manualStartBaselineCaptured) {
          manualStartBaselineIdentity = physicalSnapshotIdentity(snapshot)
          manualStartBaselineCaptured = true
          return
        }

        const currentIdentity = physicalSnapshotIdentity(snapshot)
        const hasNewPhysicalShot = currentIdentity != null
          && currentIdentity !== manualStartBaselineIdentity
        if (!hasNewPhysicalShot) return

        manualStartActive = false
      }

      const sequence = ++snapshotSequence
      void enrichSnapshotWithStartingPosition(snapshot)
        .then((enriched) => {
          if (disconnected || sequence !== snapshotSequence) return
          publishSnapshot(enriched, 'gspro')
        })
        .catch((error) => {
          if (disconnected || sequence !== snapshotSequence) return
          console.warn('[Browser GSPro course state] Supported-tee reconciliation failed; using core snapshot.', error)
          publishSnapshot({
            ...snapshot,
            preShotStart: null,
            warnings: dedupeWarnings([
              ...snapshot.warnings,
              'GSPro Shot 1 tee reconciliation failed; supported-tee placement was not applied.',
            ]),
          }, 'gspro')
        })
    },
  })

  return {
    disconnect: () => {
      if (disconnected) return
      disconnected = true
      if (typeof window !== 'undefined') {
        window.removeEventListener(LIVE_CADDIE_START_ROUND_EVENT, onStartRound)
      }
      coreConnection.disconnect()
    },
  }
}
