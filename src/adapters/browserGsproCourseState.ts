import { loadLastSelectedCourseId } from '../courseGeometry/courseSelection'
import { resolveGreywolfH1LiveTeePosition } from '../courseGeometry/greywolfH1LiveTeePosition'
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
  ballSource: CoreBrowserGsproCourseSnapshot['ballSource'] | 'gspro-startingpos'
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

  const selectedCourseId = loadLastSelectedCourseId()
  const liveHoleNumber = preShotStart?.holeNumber ?? snapshot.holeNumber
  const preShotIsTee = Boolean(
    preShotStart
    && (preShotStart.surface === 'tee' || preShotStart.shotNumber === 1),
  )
  const teeContext = liveHoleNumber === 1 && (
    preShotIsTee
    || (preShotStart == null && snapshot.nextShotNumber === 1)
  )
  if (!teeContext) return base

  const resolution = resolveGreywolfH1LiveTeePosition(
    selectedCourseId,
    1,
    preShotIsTee ? preShotStart : null,
  )
  if (!resolution) return base

  const warnings = dedupeWarnings([
    ...snapshot.warnings,
    ...(resolution.warning ? [resolution.warning] : []),
  ])

  if (!resolution.courseLocalYds) {
    return {
      ...base,
      courseKey: preShotStart?.courseKey ?? snapshot.courseKey,
      roundId: preShotStart?.roundId ?? snapshot.roundId,
      holeNumber: 1,
      ballLocalYds: null,
      ballSource: 'unavailable',
      surface: preShotStart?.surface ?? 'tee',
      surfaceSource: preShotStart ? 'gspro-startingpos' : 'cached-tee',
      distanceToPinYds: preShotStart?.distanceToPinYds ?? snapshot.distanceToPinYds,
      nextShotNumber: 1,
      warnings,
    }
  }

  const fromCurrentStartingPos = resolution.source === 'gspro-startingpos'
  return {
    ...base,
    courseKey: preShotStart?.courseKey ?? snapshot.courseKey,
    roundId: preShotStart?.roundId ?? snapshot.roundId,
    holeNumber: 1,
    ballLocalYds: resolution.courseLocalYds,
    ballSource: fromCurrentStartingPos ? 'gspro-startingpos' : 'cached-tee',
    surface: preShotStart?.surface ?? 'tee',
    surfaceSource: fromCurrentStartingPos ? 'gspro-startingpos' : 'cached-tee',
    distanceToPinYds: preShotStart?.distanceToPinYds ?? snapshot.distanceToPinYds,
    nextShotNumber: 1,
    warnings,
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
          console.warn('[Browser GSPro course state] StartingPOS enrichment failed; using core snapshot.', error)
          onSnapshot({
            ...snapshot,
            preShotStart: null,
            warnings: dedupeWarnings([
              ...snapshot.warnings,
              'GSPro pre-shot StartingPOS enrichment failed; live tee calibration was not applied.',
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
