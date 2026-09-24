import {
  resolveCourseIdFromGsproName,
  UNSELECTED_COURSE_ID,
} from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import { loadLastSelectedCourseId } from '../courseGeometry/courseSelection'
import { resolveLiveSupportedTee } from '../courseGeometry/liveSupportedTee'
import type { CourseHoleGeometry } from '../courseGeometry/types'
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

  const base: BrowserGsproCourseSnapshot = {
    ...snapshot,
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

  const coreConnection = connectCoreCourseState({
    onStatusChange,
    onError,
    onSnapshot: (snapshot) => {
      const sequence = ++snapshotSequence
      void enrichSnapshotWithStartingPosition(snapshot)
        .then((enriched) => {
          if (disconnected || sequence !== snapshotSequence) return
          onSnapshot(enriched)
        })
        .catch((error) => {
          if (disconnected || sequence !== snapshotSequence) return
          console.warn('[Browser GSPro course state] Supported-tee reconciliation failed; using core snapshot.', error)
          onSnapshot({
            ...snapshot,
            preShotStart: null,
            warnings: dedupeWarnings([
              ...snapshot.warnings,
              'GSPro Shot 1 tee reconciliation failed; supported-tee placement was not applied.',
            ]),
          })
        })
    },
  })

  return {
    disconnect: () => {
      if (disconnected) return
      disconnected = true
      coreConnection.disconnect()
    },
  }
}
