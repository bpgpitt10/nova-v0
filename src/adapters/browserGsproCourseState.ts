import {
  GREYWOLF_COURSE_ID,
  resolveCourseIdFromGsproName,
  UNSELECTED_COURSE_ID,
} from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import {
  nativeCourseContextForLive,
  recallNativeLayout,
  recallNativePinSlot,
  rememberNativeLayout,
  rememberNativePinSlot,
  selectNativeLayout,
} from '../courseGeometry/nativeCourseRuntime'
import { loadLastSelectedCourseId } from '../courseGeometry/courseSelection'
import { gsproWorldPointToGreywolfLocal } from '../courseGeometry/greywolfWorldCoordinates'
import { resolveLiveSupportedTee } from '../courseGeometry/liveSupportedTee'
import { matchingTeeCandidates } from '../courseGeometry/shotOneTeeResolver'
import { isNewLooperRoundForCapture } from '../liveCaddie/teeCaptureReadiness'
import type { CourseHoleGeometry, CoursePointYds } from '../courseGeometry/types'
import {
  dispatchLiveCaddieShotStateChanged,
  LIVE_CADDIE_START_ROUND_EVENT,
  loadActiveLiveCaddieRound,
} from '../liveCaddie/roundRuntime'
import { loadGsproDirectoryHandle } from './browserGsproAccess'
import {
  connectToBrowserGsproCourseState as connectCoreCourseState,
  loadGsproCourseStateDirectoryHandle,
  type BrowserGsproCourseSnapshot as CoreBrowserGsproCourseSnapshot,
} from './browserGsproCourseStateCore'
import {
  parseLatestGsproCourseLayout,
  selectGsproCourseLayoutPin,
  type GsproCourseLayoutRow,
} from './gsproCourseLayoutPin'
import {
  parseGsproStartingPosition,
  type GsproStartingPositionObservation,
} from './gsproStartingPosition'
import { applyNativeCourseSnapshot } from './nativeCourseSnapshot'

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
  ballSource: CoreBrowserGsproCourseSnapshot['ballSource'] | 'osm-tee-match' | 'native-gkd'
  surfaceSource: CoreBrowserGsproCourseSnapshot['surfaceSource'] | 'gspro-startingpos'
  preShotStart: GsproStartingPositionObservation | null
  pinLocalYds: CoursePointYds | null
  /** Both exact: GSPro's output_log layout, or the GKD pin slot (native positions beta). */
  pinSource: 'output-log-course-layout' | 'native-gkd' | 'unavailable'
  pinDistanceValidationErrorYds: number | null
  teePlacement?: 'mapped' | 'locked' | 'provisional' | null
  teeUncertaintyYds?: number | null
}

type SnapshotHandler = (snapshot: BrowserGsproCourseSnapshot) => void

type ReadableDirectoryHandle = {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    getFile(): Promise<File>
  }>
}

type ExactPinObservation = {
  pinLocalYds: CoursePointYds
  distanceValidationErrorYds: number | null
}

const CURRENT_ROUND_FILE = 'currentRound.dat'
const OUTPUT_LOG_FILE = 'output_log.txt'
const liveTeeGeometryCache = new Map<string, Promise<CourseHoleGeometry>>()
let courseLayoutCache: {
  selectedCourseId: string
  rows: GsproCourseLayoutRow[]
} | null = null

// A manual Start Round is a runtime override, not a property of one watcher
// instance. Keep the quarantine above the connection lifecycle so route/hole
// changes cannot resurrect the previous round's stale currentRound.dat state.
const manualRoundStart = {
  active: false,
  baselineCaptured: false,
  baselineIdentity: null as string | null,
}

const readTextFileFromHandle = async (
  handle: ReadableDirectoryHandle | null,
  filename: string,
) => {
  if (!handle) return null
  try {
    const fileHandle = await handle.getFileHandle(filename)
    return await (await fileHandle.getFile()).text()
  } catch {
    return null
  }
}

const readGsproTextFile = async (filename: string) => {
  const primary = await loadGsproDirectoryHandle().catch(() => null)
  const primaryText = await readTextFileFromHandle(primary, filename)
  if (primaryText != null) return primaryText

  const dedicated = await loadGsproCourseStateDirectoryHandle().catch(() => null)
  if (dedicated === primary) return null
  return readTextFileFromHandle(dedicated, filename)
}

const readCurrentRoundText = () => readGsproTextFile(CURRENT_ROUND_FILE)

const loadGsproCourseLayout = async (selectedCourseId: string) => {
  if (courseLayoutCache?.selectedCourseId === selectedCourseId) {
    return courseLayoutCache.rows
  }

  const logText = await readGsproTextFile(OUTPUT_LOG_FILE)
  if (!logText) return null
  const rows = parseLatestGsproCourseLayout(logText)
  if (!rows) return null
  courseLayoutCache = { selectedCourseId, rows }
  return rows
}

const dedupeWarnings = (warnings: string[]) => [...new Set(warnings)]

const loadLiveTeeGeometry = (
  courseId: Exclude<ReturnType<typeof loadLastSelectedCourseId>, typeof UNSELECTED_COURSE_ID>,
  holeNumber: number,
) => {
  const selectedRound = loadActiveLiveCaddieRound()
  // loadCourseHoleGeometry embeds the active tee selection in the frame.
  // Never keep a tee frame from a prior White/Blue round in this long-lived cache.
  const key = `${courseId}:${holeNumber}:${selectedRound?.courseId === courseId ? selectedRound.id : 'no-round'}`
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

const resolveExactPinFromCourseLayout = async ({
  selectedCourseId,
  holeNumber,
  teeDistanceToPinYds,
  geometry,
}: {
  selectedCourseId: Exclude<ReturnType<typeof loadLastSelectedCourseId>, typeof UNSELECTED_COURSE_ID>
  holeNumber: number
  teeDistanceToPinYds: number | null
  geometry?: CourseHoleGeometry | null
}): Promise<ExactPinObservation | null> => {
  if (selectedCourseId !== GREYWOLF_COURSE_ID) return null
  const rows = await loadGsproCourseLayout(selectedCourseId)
  const match = selectGsproCourseLayoutPin(rows, holeNumber, teeDistanceToPinYds)
  if (!match) return null

  const pinLocalYds = await gsproWorldPointToGreywolfLocal(
    match.row.pinPos,
    match.row.teePos,
    holeNumber,
  )

  // When no live tee distance is available (for example immediately after the
  // manual Start Round quarantine), reject obviously mismatched cached layouts.
  // A real pin can be far from green center, so keep this guard intentionally wide.
  if (teeDistanceToPinYds == null && geometry?.markers.pin) {
    const centerGapYds = Math.hypot(
      pinLocalYds[0] - geometry.markers.pin[0],
      pinLocalYds[1] - geometry.markers.pin[1],
    )
    if (centerGapYds > 65) return null
  }

  return {
    pinLocalYds,
    distanceValidationErrorYds: match.distanceErrorYds,
  }
}

const unavailableShotOneSnapshot = (
  snapshot: BrowserGsproCourseSnapshot,
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

/**
 * Native positions (beta). When enabled and the player's GKD matches the
 * course registration, overlay GKD tee/ball/pin on the snapshot the existing
 * pipeline built. Any failure returns that snapshot unchanged.
 */
const applyNativeIfReady = async (
  snapshot: BrowserGsproCourseSnapshot,
  teeContext: boolean,
): Promise<BrowserGsproCourseSnapshot> => {
  try {
    const selectedCourseId = loadLastSelectedCourseId()
    if (selectedCourseId === UNSELECTED_COURSE_ID || snapshot.holeNumber == null) return snapshot
    const courseKey = snapshot.preShotStart?.courseKey ?? snapshot.courseKey
    const loaded = await nativeCourseContextForLive(selectedCourseId, courseKey)
    if (!loaded) return snapshot
    const round = loadActiveLiveCaddieRound()
    // Courses with alternate layouts (GKDalt): settle which one is in play.
    const selection = selectNativeLayout(loaded, {
      holeNumber: snapshot.holeNumber,
      preShotWorld: teeContext ? snapshot.preShotStart?.world ?? null : null,
      normalizedTeeSet: round?.courseId === selectedCourseId ? round.normalizedTeeSet : null,
      rememberedLayoutName: recallNativeLayout(loaded.courseKey, snapshot.roundId),
    })
    const context = selection.context
    const normalizedTeeSet = selection.normalizedTeeSet
    if (selection.learnedLayoutName) rememberNativeLayout(context.courseKey, snapshot.roundId, selection.learnedLayoutName)
    // Legacy OSM tee picks ("Tee 3") carry no GSPro name; pass their map spot
    // so the overlay can use the GKD tee standing there.
    let legacyTeeLocal: CoursePointYds | null = null
    if (teeContext && normalizedTeeSet) {
      const geometry = await loadLiveTeeGeometry(selectedCourseId, snapshot.holeNumber).catch(() => null)
      const named = geometry ? matchingTeeCandidates(geometry, normalizedTeeSet) : []
      legacyTeeLocal = named.length === 1 ? named[0].coursePoint : null
    }
    const { snapshot: next, pinSlot } = applyNativeCourseSnapshot({
      base: snapshot,
      context,
      holeNumber: snapshot.holeNumber,
      teeContext,
      preShotStart: snapshot.preShotStart,
      normalizedTeeSet,
      rememberedPinSlot: recallNativePinSlot(context.courseKey, snapshot.roundId),
      legacyTeeLocal,
    })
    if (pinSlot != null) rememberNativePinSlot(context.courseKey, snapshot.roundId, pinSlot)
    return next
  } catch (error) {
    console.warn('[Browser GSPro course state] Native positions unavailable; using existing positioning.', error)
    return snapshot
  }
}

const enrichSnapshotWithStartingPosition = async (
  snapshot: CoreBrowserGsproCourseSnapshot,
): Promise<BrowserGsproCourseSnapshot> => {
  const legacy = await enrichSnapshotLegacy(snapshot)
  const preShotStart = legacy.preShotStart
  const teeContext = legacy.holeNumber != null
    && snapshot.nextShotNumber === 1
    && (preShotStart == null || preShotStart.surface === 'tee' || preShotStart.shotNumber === 1)
  return applyNativeIfReady(legacy, teeContext)
}

const enrichSnapshotLegacy = async (
  snapshot: CoreBrowserGsproCourseSnapshot,
): Promise<BrowserGsproCourseSnapshot> => {
  const roundText = await readCurrentRoundText()
  const preShotStart = roundText == null
    ? null
    : parseGsproStartingPosition(roundText, snapshot.holeNumber)
  const liveHoleNumber = preShotStart?.holeNumber ?? snapshot.holeNumber
  const selectedCourseId = loadLastSelectedCourseId()
  const teeContext = liveHoleNumber != null
    && snapshot.nextShotNumber === 1
    && (preShotStart == null || preShotStart.surface === 'tee' || preShotStart.shotNumber === 1)
  const teeDistanceToPinYds = teeContext
    ? preShotStart?.distanceToPinYds ?? snapshot.distanceToPinYds
    : null
  const exactPin = selectedCourseId !== UNSELECTED_COURSE_ID && liveHoleNumber != null
    ? await resolveExactPinFromCourseLayout({
        selectedCourseId,
        holeNumber: liveHoleNumber,
        teeDistanceToPinYds,
      }).catch((error) => {
        console.warn('[Browser GSPro course state] Exact output_log pin resolution failed.', error)
        return null
      })
    : null

  // Raw surface 11 is ambiguous in live GSPro data: physical testing has shown
  // it for bunker-like states and woods/scrub deep rough. Do not coerce it here;
  // unresolved cases should fall through to course geometry.
  const base: BrowserGsproCourseSnapshot = {
    ...snapshot,
    preShotStart,
    pinLocalYds: exactPin?.pinLocalYds ?? null,
    pinSource: exactPin ? 'output-log-course-layout' : 'unavailable',
    pinDistanceValidationErrorYds: exactPin?.distanceValidationErrorYds ?? null,
  }

  if (!teeContext || liveHoleNumber == null) return base

  if (selectedCourseId === UNSELECTED_COURSE_ID) {
    return unavailableShotOneSnapshot(
      base,
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
      base,
      preShotStart,
      liveHoleNumber,
      `GSPro reports ${preShotStart?.courseKey}; Looper is set to a different course, so Shot 1 was not reconciled.`,
    )
  }

  const geometry = await loadLiveTeeGeometry(selectedCourseId, liveHoleNumber)
  const resolution = resolveLiveSupportedTee(geometry, preShotStart)
  if (resolution.status !== 'supported') {
    return unavailableShotOneSnapshot(
      base,
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
    teePlacement: resolution.placement,
    teeUncertaintyYds: resolution.uncertaintyRadiusYds,
    surface: preShotStart?.surface ?? 'tee',
    surfaceSource: preShotStart ? 'gspro-startingpos' : 'cached-tee',
    distanceToPinYds: preShotStart?.distanceToPinYds ?? snapshot.distanceToPinYds,
    nextShotNumber: 1,
    warnings: dedupeWarnings([
      ...snapshot.warnings,
      ...(resolution.placement === 'provisional' ? [resolution.reason] : []),
    ]),
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
  const exactPin = await resolveExactPinFromCourseLayout({
    selectedCourseId,
    holeNumber,
    teeDistanceToPinYds: null,
    geometry,
  }).catch((error) => {
    console.warn('[Browser GSPro course state] Manual-start exact pin resolution failed.', error)
    return null
  })
  const pin = exactPin?.pinLocalYds ?? geometry.markers.pin
  const distanceToPinYds = pin
    ? Math.hypot(pin[0] - tee[0], pin[1] - tee[1])
    : null

  return applyNativeIfReady({
    courseKey: null,
    roundId: null,
    holeNumber,
    ballLocalYds: tee,
    ballSource: 'osm-tee-match',
    teePlacement: resolution.status === 'supported' ? resolution.placement : null,
    teeUncertaintyYds: resolution.status === 'supported' ? resolution.uncertaintyRadiusYds : null,
    surface: 'tee',
    surfaceSource: 'cached-tee',
    distanceToPinYds,
    nextShotNumber: 1,
    latestShot: null,
    latestShotKey: null,
    warnings: resolution.status === 'supported' && resolution.placement === 'provisional'
      ? [resolution.reason] : [],
    observedAt: new Date().toISOString(),
    preShotStart: null,
    pinLocalYds: exactPin?.pinLocalYds ?? null,
    pinSource: exactPin ? 'output-log-course-layout' : 'unavailable',
    pinDistanceValidationErrorYds: exactPin?.distanceValidationErrorYds ?? null,
  }, true)
}

const physicalSnapshotIdentity = (snapshot: CoreBrowserGsproCourseSnapshot | null) =>
  snapshot?.latestShotKey
    ? `${snapshot.roundId ?? 'round'}:${snapshot.latestShotKey}`
    : null

const snapshotSignature = (
  snapshot: BrowserGsproCourseSnapshot,
  source: 'manual-start' | 'gspro',
) => JSON.stringify([
  source,
  snapshot.courseKey,
  snapshot.roundId,
  snapshot.holeNumber,
  snapshot.nextShotNumber,
  snapshot.latestShotKey,
  snapshot.ballLocalYds?.[0] ?? null,
  snapshot.ballLocalYds?.[1] ?? null,
  snapshot.surface,
  snapshot.surfaceSource,
  snapshot.distanceToPinYds,
  snapshot.pinLocalYds?.[0] ?? null,
  snapshot.pinLocalYds?.[1] ?? null,
  snapshot.pinSource,
  snapshot.warnings,
])

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
  let lastPublishedShotStateKey: string | null = null
  let lastPublishedSnapshotSignature: string | null = null
  let lastManuallyArmedLooperRoundId: string | null = null

  const publishSnapshot = (
    snapshot: BrowserGsproCourseSnapshot,
    source: 'manual-start' | 'gspro',
  ) => {
    const signature = snapshotSignature(snapshot, source)
    if (signature !== lastPublishedSnapshotSignature) {
      lastPublishedSnapshotSignature = signature
      onSnapshot(snapshot)
    }

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
    const armedRound = loadActiveLiveCaddieRound()
    if (selectedCourseId === UNSELECTED_COURSE_ID || !armedRound
      || armedRound.courseId !== selectedCourseId) return
    if (!isNewLooperRoundForCapture(lastManuallyArmedLooperRoundId, armedRound.id)) {
      // LiveCaddieRoundBootstrap may re-emit this same round on navigation;
      // it must not quarantine real shots or reset a successful capture.
      return
    }
    lastManuallyArmedLooperRoundId = armedRound.id
    // A NEW round may have identical course/tee/hole/OSM location and even
    // the same stale GSPro RoundID. Reset snapshot deduplication, otherwise
    // it suppresses the new manual start and downstream fresh wind/lie state.
    lastPublishedShotStateKey = null
    lastPublishedSnapshotSignature = null

    manualRoundStart.active = true
    manualRoundStart.baselineCaptured = lastCoreSnapshot !== null
    manualRoundStart.baselineIdentity = physicalSnapshotIdentity(lastCoreSnapshot)
    const sequence = ++snapshotSequence

    void buildManualStartSnapshot(selectedCourseId)
      .then((snapshot) => {
        if (disconnected || sequence !== snapshotSequence || !manualRoundStart.active) return
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

      if (manualRoundStart.active) {
        if (!manualRoundStart.baselineCaptured) {
          manualRoundStart.baselineIdentity = physicalSnapshotIdentity(snapshot)
          manualRoundStart.baselineCaptured = true
          return
        }

        const currentIdentity = physicalSnapshotIdentity(snapshot)
        const hasNewPhysicalShot = currentIdentity != null
          && currentIdentity !== manualRoundStart.baselineIdentity
        if (!hasNewPhysicalShot) return

        manualRoundStart.active = false
        manualRoundStart.baselineCaptured = false
        manualRoundStart.baselineIdentity = null
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
            pinLocalYds: null,
            pinSource: 'unavailable',
            pinDistanceValidationErrorYds: null,
            warnings: dedupeWarnings([
              ...snapshot.warnings,
              'GSPro Shot 1 tee reconciliation failed; supported-tee placement was not applied.',
            ]),
          }, 'gspro')
        })
    },
  })

  // Round Setup is a separate route. On a *first* visit to Live Caddie,
  // Start Round's DOM event may have fired before this watcher existed.
  // The persisted 'armed' round is authoritative; re-establish its Hole 1
  // shot-1 baseline without letting a stale completed shot displace the tee.
  const persistedRound = loadActiveLiveCaddieRound()
  const selectedAtConnect = loadLastSelectedCourseId()
  if (persistedRound?.phase === 'armed'
      && persistedRound.courseId === selectedAtConnect) {
    onStartRound()
  }

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
