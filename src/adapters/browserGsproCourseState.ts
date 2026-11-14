import {
  resolveCourseIdFromGsproName,
  UNSELECTED_COURSE_ID,
} from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import {
  nativeCourseContextForLive,
  publishedRegistrationFor,
  recallNativeLayout,
  recallNativePinSlot,
  rememberNativeLayout,
  rememberNativePinSlot,
  selectNativeLayout,
} from '../courseGeometry/nativeCourseRuntime'
import { loadLastSelectedCourseId } from '../courseGeometry/courseSelection'
import type { CourseId } from '../courseGeometry/courseCatalog'
import { resolveLiveSupportedTee } from '../courseGeometry/liveSupportedTee'
import { matchingTeeCandidates } from '../courseGeometry/shotOneTeeResolver'
import { registrationForHole } from '../courseGeometry/nativeRegistration'
import { isNewLooperRoundForCapture } from '../liveCaddie/teeCaptureReadiness'
import type { CourseHoleGeometry, CoursePointYds } from '../courseGeometry/types'
import {
  dispatchLiveCaddieShotStateChanged,
  LIVE_CADDIE_START_ROUND_EVENT,
  loadActiveLiveCaddieRound,
  markActiveRoundLiveFromHoleChange,
} from '../liveCaddie/roundRuntime'
import { loadGsproDirectoryHandle } from './browserGsproAccess'
import { noteLiveFollow, reportLiveFollowDiagnostic } from '../lib/gsproFollowDiagnostics'
import {
  connectToBrowserGsproCourseState as connectCoreCourseState,
  loadGsproCourseStateDirectoryHandle,
  type BrowserGsproCourseSnapshot as CoreBrowserGsproCourseSnapshot,
} from './browserGsproCourseStateCore'
import {
  parseGsproStartingPosition,
  type GsproStartingPositionObservation,
} from './gsproStartingPosition'
import { confirmedPinNote, findConfirmedPosition, loadConfirmedPositions, recordConfirmedPosition } from '../lib/confirmedPositions'
import { applyConfirmedPosition, applyNativeCourseSnapshot } from './nativeCourseSnapshot'
import { nativeHole } from '../courseGeometry/nativeGkd'
import {
  createOutputLogLayoutReader,
  layoutTeeForHole,
  type GsproRoundLayoutTee,
} from './gsproRoundLayoutDistance'

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
  /** Shot 1: tee -> pin from GSPro's round layout in output_log (validated on use). */
  gsproLayoutTee?: GsproRoundLayoutTee | null
  teePlacement?: 'mapped' | 'locked' | 'provisional' | null
  teeUncertaintyYds?: number | null
  /** Native positions: how GSPro's scene is turned against true north
   * (Valhalla 180°). GSPro's wind compass is scene-relative. */
  gsproSceneRotationDeg?: number | null
  gsproSceneMirrored?: boolean
  /** 'manual-start': Looper's Start Round (Hole 1, Shot 1) before GSPro has
   * written any shot of this round; 'gspro': read from GSPro's files. */
  publishedFrom?: 'manual-start' | 'gspro'
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
const readOutputLogLayout = createOutputLogLayoutReader()
const outputLogLayoutScanSummary = () => readOutputLogLayout.summary()

// A manual Start Round is a runtime override, not a property of one watcher
// instance. Keep the quarantine above the connection lifecycle so route/hole
// changes cannot resurrect the previous round's stale currentRound.dat state.
const manualRoundStart = {
  active: false,
  baselineCaptured: false,
  baselineIdentity: null as string | null,
  // GSPro's hole when the hold began (or last seen during it): a change to a
  // later hole while holding is GSPro moving on (a conceded hole), not stale data.
  lastHole: null as number | null,
}

// The hold's baseline belongs to the Looper round, not to one page load. A
// refresh while the round is still waiting for its first shot used to take
// whatever GSPro showed at that moment as the new baseline, so a tee shot
// already hit was swallowed and the caddie sat on the tee (11/14).
const HOLD_BASELINE_KEY = 'looper.live-caddie.hold-baseline.v1'

const loadHoldBaseline = (looperRoundId: string): { identity: string | null } | null => {
  try {
    const raw = window.localStorage.getItem(HOLD_BASELINE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { roundId?: unknown; identity?: unknown }
    if (parsed.roundId !== looperRoundId) return null
    return { identity: typeof parsed.identity === 'string' ? parsed.identity : null }
  } catch {
    return null
  }
}

const saveHoldBaseline = (looperRoundId: string | null, identity: string | null) => {
  if (!looperRoundId) return
  try {
    window.localStorage.setItem(HOLD_BASELINE_KEY, JSON.stringify({ roundId: looperRoundId, identity }))
  } catch {
    // storage is a convenience; the hold still works for this page load
  }
}

const clearHoldBaseline = () => {
  try {
    window.localStorage.removeItem(HOLD_BASELINE_KEY)
  } catch {
    // nothing to clear
  }
}

// Longest one shot's placement may take before GSPro's state is shown as read.
const ENRICH_TIMEOUT_MS = 8000

// GSPro file changes during a hold that did not release it: report at these counts.
const STUCK_REPORT_AT = new Set([2, 4, 8, 16])

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

const openGsproFile = async (filename: string) => {
  for (const load of [loadGsproDirectoryHandle, loadGsproCourseStateDirectoryHandle]) {
    const handle = await load().catch(() => null)
    if (!handle) continue
    try {
      return await (await handle.getFileHandle(filename)).getFile()
    } catch {
      // try the other handle
    }
  }
  return null
}

// The latest round layout in output_log.txt (new rounds append a new one, so
// a replayed course picks up the new pins). Read incrementally.
const loadGsproCourseLayout = async (_selectedCourseId?: string) =>
  readOutputLogLayout(await openGsproFile(OUTPUT_LOG_FILE).catch(() => null))

/** Shot 1 only: GSPro's own tee -> pin distance for this hole from the round layout. */
const withRoundLayoutTee = async (
  snapshot: BrowserGsproCourseSnapshot,
  teeContext: boolean,
): Promise<BrowserGsproCourseSnapshot> => {
  if (!teeContext || snapshot.holeNumber == null) return { ...snapshot, gsproLayoutTee: null }
  const rows = await loadGsproCourseLayout().catch(() => null)
  return { ...snapshot, gsproLayoutTee: layoutTeeForHole(rows, snapshot.holeNumber) }
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

// GSPro's output_log pin through a hand-made world transform: only the old
// built-in Greywolf had one. Since 11/4 Greywolf is a loaded course and native
// positions place every course's pins, so there is no exact layout pin here.
const resolveExactPinFromCourseLayout = async (_input: {
  selectedCourseId: Exclude<ReturnType<typeof loadLastSelectedCourseId>, typeof UNSELECTED_COURSE_ID>
  holeNumber: number
  teeDistanceToPinYds: number | null
  geometry?: CourseHoleGeometry | null
}): Promise<ExactPinObservation | null> => null

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
/**
 * The course file isn't readable here (no companion, course not installed,
 * folder not shared): place the tee and pin another round confirmed for this
 * hole, tee set and pin day, using the published registration.
 */
const applyConfirmedFallback = async (
  snapshot: BrowserGsproCourseSnapshot,
  courseId: CourseId,
  courseKey: string | null,
  teeContext: boolean,
  round: ReturnType<typeof loadActiveLiveCaddieRound>,
): Promise<BrowserGsproCourseSnapshot> => {
  if (snapshot.holeNumber == null || round?.courseId !== courseId) return snapshot
  // After shot 1 the core owns the ball; only the pin is worth placing, and
  // only while no better pin is known.
  if (!teeContext && snapshot.pinSource !== 'unavailable') return snapshot
  try {
    const rows = await loadConfirmedPositions(courseId)
    if (rows.length === 0) return snapshot
    const registration = await publishedRegistrationFor(courseId, courseKey)
    if (!registration) return snapshot
    const position = findConfirmedPosition(rows, {
      holeNumber: snapshot.holeNumber, teeSet: round.normalizedTeeSet ?? '', pinDay: round.pinDay ?? null,
      layoutFingerprint: registration.layoutFingerprint,
    })
    if (!position) return snapshot
    return applyConfirmedPosition({ base: snapshot, registration, holeNumber: snapshot.holeNumber, teeContext, position })
  } catch {
    return snapshot
  }
}

const applyNativeIfReady = async (
  snapshot: BrowserGsproCourseSnapshot,
  teeContext: boolean,
): Promise<BrowserGsproCourseSnapshot> => {
  try {
    const selectedCourseId = loadLastSelectedCourseId()
    if (selectedCourseId === UNSELECTED_COURSE_ID || snapshot.holeNumber == null) return snapshot
    const courseKey = snapshot.preShotStart?.courseKey ?? snapshot.courseKey
    const loaded = await nativeCourseContextForLive(selectedCourseId, courseKey)
    const round = loadActiveLiveCaddieRound()
    if (!loaded) return applyConfirmedFallback(snapshot, selectedCourseId, courseKey, teeContext, round)
    // Courses with alternate layouts (GKDalt): settle which one is in play.
    const selection = selectNativeLayout(loaded, {
      holeNumber: snapshot.holeNumber,
      preShotWorld: teeContext && snapshot.preShotStart?.holeNumber === snapshot.holeNumber
        ? snapshot.preShotStart?.world ?? null : null,
      normalizedTeeSet: round?.courseId === selectedCourseId ? round.normalizedTeeSet : null,
      rememberedLayoutName: recallNativeLayout(loaded.courseKey, snapshot.roundId),
    })
    const context = selection.context
    const normalizedTeeSet = selection.normalizedTeeSet
    if (selection.learnedLayoutName) rememberNativeLayout(context.courseKey, snapshot.roundId, selection.learnedLayoutName)
    // Legacy OSM tee picks ("Tee 3") carry no GSPro name; pass their map spot
    // so the overlay can use the GKD tee standing there.
    const layoutRows = await loadGsproCourseLayout().catch(() => null)
    const layoutRow = layoutRows?.[snapshot.holeNumber - 1] ?? null
    let legacyTeeLocal: CoursePointYds | null = null
    if (teeContext && normalizedTeeSet) {
      const geometry = await loadLiveTeeGeometry(selectedCourseId, snapshot.holeNumber).catch(() => null)
      const named = geometry ? matchingTeeCandidates(geometry, normalizedTeeSet) : []
      legacyTeeLocal = named.length === 1 ? named[0].coursePoint : null
    }
    const { snapshot: next, pinSlot, confirmed } = applyNativeCourseSnapshot({
      base: snapshot,
      context,
      holeNumber: snapshot.holeNumber,
      teeContext,
      preShotStart: snapshot.preShotStart?.holeNumber === snapshot.holeNumber ? snapshot.preShotStart : null,
      normalizedTeeSet,
      rememberedPinSlot: recallNativePinSlot(context.courseKey, snapshot.roundId, snapshot.holeNumber),
      legacyTeeLocal,
      roundLayout: layoutRow ? { tee: layoutRow.teePos, pin: layoutRow.pinPos } : null,
      pinDay: round?.courseId === selectedCourseId ? round.pinDay ?? null : null,
    })
    if (pinSlot != null) rememberNativePinSlot(context.courseKey, snapshot.roundId, snapshot.holeNumber, pinSlot)
    // Against what another round confirmed for this hole, tee and day: a pin
    // that didn't come from GSPro's own record and disagrees gets a note.
    let crossCheckNote: string | null = null
    if (pinSlot != null && next.pinDistanceValidationErrorYds == null && round?.courseId === selectedCourseId) {
      const rows = await loadConfirmedPositions(selectedCourseId).catch(() => [])
      crossCheckNote = confirmedPinNote({
        position: findConfirmedPosition(rows, {
          holeNumber: snapshot.holeNumber, teeSet: round.normalizedTeeSet ?? '', pinDay: round.pinDay ?? null,
          layoutFingerprint: context.registration.layoutFingerprint,
        }),
        pinSlot, pinFromGsproRecord: false, pinDay: round.pinDay ?? null,
      })
    }
    // Both confirmed by GSPro's own record: share them for players without the file.
    if (confirmed && round?.courseId === selectedCourseId && context.registration.layoutFingerprint) {
      void recordConfirmedPosition({
        courseId: selectedCourseId, courseKey: context.courseKey, holeNumber: snapshot.holeNumber,
        teeSet: round.normalizedTeeSet ?? '', pinDay: round.pinDay ?? '',
        layoutFingerprint: context.registration.layoutFingerprint,
        teeName: confirmed.teeName, teeWorld: confirmed.teeWorld,
        pinSlot: confirmed.pinSlot, pinLabel: confirmed.pinLabel, pinWorld: confirmed.pinWorld,
      })
    }
    const placed = registrationForHole(context.registration, snapshot.holeNumber)
    const turned = { ...next, gsproSceneRotationDeg: placed.rotationDeg ?? 0,
      gsproSceneMirrored: placed.mirrored === true,
      warnings: crossCheckNote ? [...new Set([...next.warnings, crossCheckNote])] : next.warnings }
    if (!teeContext) return turned
    // Shown under Details: whether GSPro's round layout gave Shot 1 its pin.
    const gkdHole = nativeHole(context.layout, snapshot.holeNumber)
    const nearestPinM = layoutRow && gkdHole && gkdHole.pins.length > 0
      ? Math.min(...gkdHole.pins.map((p) => Math.hypot(p.x - layoutRow.pinPos.x, p.z - layoutRow.pinPos.z)))
      : null
    const layoutNote = !layoutRows
      ? `GSPro round layout: not found in output_log (${outputLogLayoutScanSummary()}).`
      : !layoutRow
        ? `GSPro round layout: ${layoutRows.length} holes, none for hole ${snapshot.holeNumber}.`
        : `GSPro round layout: hole ${snapshot.holeNumber} tee->pin ${(Math.hypot(
            layoutRow.pinPos.x - layoutRow.teePos.x, layoutRow.pinPos.z - layoutRow.teePos.z) * 1.0936133).toFixed(1)} yd;`
          + ` nearest GKD pin ${nearestPinM == null ? 'n/a' : nearestPinM.toFixed(2) + ' m'}`
          + `; pin ${next.pinSource === 'native-gkd' ? 'slot ' + pinSlot : 'unknown'}.`
    return { ...turned, warnings: [...next.warnings.filter((w) => !w.startsWith('GSPro round layout:')), layoutNote] }
  } catch (error) {
    console.warn('[Browser GSPro course state] Native positions unavailable; using existing positioning.', error)
    return snapshot
  }
}

const enrichSnapshotWithStartingPosition = async (
  snapshot: CoreBrowserGsproCourseSnapshot,
): Promise<BrowserGsproCourseSnapshot> => {
  const legacy = await enrichSnapshotLegacy(snapshot)
  // After a hole ends, GSPro's pre-shot record still describes the previous
  // hole's last shot until it writes the next tee. That record says nothing
  // about this tee, so it must not cancel tee placement (Hole 2 preload).
  const preShotStart = legacy.preShotStart?.holeNumber === legacy.holeNumber ? legacy.preShotStart : null
  const teeContext = legacy.holeNumber != null
    && snapshot.nextShotNumber === 1
    && (preShotStart == null || preShotStart.surface === 'tee' || preShotStart.shotNumber === 1)
  return withRoundLayoutTee(await applyNativeIfReady(legacy, teeContext), teeContext)
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

  return withRoundLayoutTee(await applyNativeIfReady({
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
  }, true), true)
}

/** While Start Round holds hole 1: GSPro changed to a later hole (a conceded hole). */
export const releasesHoldOnHoleChange = (lastHole: number | null, hole: number | null) =>
  lastHole != null && hole != null && hole !== lastHole && hole > 1

// The shot's own id (last part of "round:hole:shotId"). A read where the
// RoundID was briefly missing ("round:2:<id>" vs "273:2:<id>") is the same
// stale shot, not a new one, and must not end the manual Start Round hold.
const physicalSnapshotIdentity = (snapshot: CoreBrowserGsproCourseSnapshot | null) =>
  snapshot?.latestShotKey
    ? snapshot.latestShotKey.split(':').pop() || snapshot.latestShotKey
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
  snapshot.gsproLayoutTee?.distanceYds ?? null,
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
  let unreleasedReads = 0
  let coreReads = 0
  let enrichBusy = false
  let pendingCore: CoreBrowserGsproCourseSnapshot | null = null
  let overtaken = 0

  const publishSnapshot = (
    snapshot: BrowserGsproCourseSnapshot,
    source: 'manual-start' | 'gspro',
  ) => {
    const signature = snapshotSignature(snapshot, source)
    if (signature !== lastPublishedSnapshotSignature) {
      lastPublishedSnapshotSignature = signature
      onSnapshot({ ...snapshot, publishedFrom: source })
    }
    noteLiveFollow({ published: source })

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
    pendingCore = null
    const storedBaseline = loadHoldBaseline(armedRound.id)
    if (storedBaseline) {
      // Same Looper round as before this page load: keep its baseline, so a
      // shot hit in the meantime still counts as new.
      manualRoundStart.baselineCaptured = true
      manualRoundStart.baselineIdentity = storedBaseline.identity
    } else {
      manualRoundStart.baselineCaptured = lastCoreSnapshot !== null
      manualRoundStart.baselineIdentity = physicalSnapshotIdentity(lastCoreSnapshot)
      if (manualRoundStart.baselineCaptured) saveHoldBaseline(armedRound.id, manualRoundStart.baselineIdentity)
    }
    manualRoundStart.lastHole = lastCoreSnapshot?.holeNumber ?? null
    unreleasedReads = 0
    noteLiveFollow({
      hold: manualRoundStart.baselineCaptured ? 'holding' : 'waiting-baseline',
      baselineId: manualRoundStart.baselineIdentity,
      unreleasedReads: 0,
    })
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

  const publishCoreFallback = (snapshot: CoreBrowserGsproCourseSnapshot, why: string) => {
    publishSnapshot({
      ...snapshot,
      preShotStart: null,
      pinLocalYds: null,
      pinSource: 'unavailable',
      pinDistanceValidationErrorYds: null,
      warnings: dedupeWarnings([...snapshot.warnings, why]),
    }, 'gspro')
  }

  const runEnrich = (snapshot: CoreBrowserGsproCourseSnapshot) => {
    enrichBusy = true
    // A manual Start Round bumps snapshotSequence: results from before it are stale.
    const generation = snapshotSequence
    let settled = false
    const finish = () => {
      if (settled) return false
      settled = true
      window.clearTimeout(timeout)
      enrichBusy = false
      const next = pendingCore
      pendingCore = null
      if (next && !disconnected && !manualRoundStart.active) runEnrich(next)
      return true
    }
    const usable = () => !disconnected && generation === snapshotSequence && !manualRoundStart.active
    // Never let one slow or hung read stop the round from being followed.
    const timeout = window.setTimeout(() => {
      const publish = usable()
      if (!finish()) return
      console.warn('[Browser GSPro course state] Shot placement took too long; using GSPro state as read.')
      if (publish) publishCoreFallback(snapshot, 'Placing this shot took too long; showing GSPro state without tee or pin placement.')
    }, ENRICH_TIMEOUT_MS)
    void enrichSnapshotWithStartingPosition(snapshot)
      .then((enriched) => {
        const publish = usable()
        if (!finish()) return
        if (publish) publishSnapshot(enriched, 'gspro')
      })
      .catch((error) => {
        const publish = usable()
        if (!finish()) return
        console.warn('[Browser GSPro course state] Supported-tee reconciliation failed; using core snapshot.', error)
        if (publish) {
          publishCoreFallback(snapshot, 'GSPro Shot 1 tee reconciliation failed; supported-tee placement was not applied.')
        }
      })
  }

  const coreConnection = connectCoreCourseState({
    onStatusChange,
    onError,
    onSnapshot: (snapshot) => {
      lastCoreSnapshot = snapshot
      coreReads += 1
      noteLiveFollow({
        reads: coreReads,
        gspro: {
          roundId: snapshot.roundId,
          courseKey: snapshot.courseKey,
          hole: snapshot.holeNumber,
          nextShot: snapshot.nextShotNumber,
          shotId: physicalSnapshotIdentity(snapshot),
          warnings: snapshot.warnings.length,
        },
      })

      if (manualRoundStart.active) {
        if (!manualRoundStart.baselineCaptured) {
          manualRoundStart.baselineIdentity = physicalSnapshotIdentity(snapshot)
          manualRoundStart.baselineCaptured = true
          manualRoundStart.lastHole = snapshot.holeNumber
          saveHoldBaseline(lastManuallyArmedLooperRoundId, manualRoundStart.baselineIdentity)
          noteLiveFollow({ hold: 'holding', baselineId: manualRoundStart.baselineIdentity })
          return
        }

        const currentIdentity = physicalSnapshotIdentity(snapshot)
        const hasNewPhysicalShot = currentIdentity != null
          && currentIdentity !== manualRoundStart.baselineIdentity
        // A stale currentRound.dat never changes holes on its own: GSPro going
        // to hole 2+ while we hold hole 1 is the player conceding a hole.
        const movedOn = releasesHoldOnHoleChange(manualRoundStart.lastHole, snapshot.holeNumber)
        if (snapshot.holeNumber != null) manualRoundStart.lastHole = snapshot.holeNumber
        if (!hasNewPhysicalShot && !movedOn) {
          // GSPro's files changed but nothing here counts as a new shot. A few
          // of these are normal (GSPro writes its pre-shot record); a run of
          // them after the player has hit is the caddie stuck on the tee.
          unreleasedReads += 1
          noteLiveFollow({ unreleasedReads })
          if (STUCK_REPORT_AT.has(unreleasedReads)) {
            void reportLiveFollowDiagnostic(
              'hold-not-released',
              `hold:${lastManuallyArmedLooperRoundId ?? 'round'}:${unreleasedReads}`,
            )
          }
          return
        }

        manualRoundStart.active = false
        manualRoundStart.baselineCaptured = false
        manualRoundStart.baselineIdentity = null
        manualRoundStart.lastHole = null
        clearHoldBaseline()
        unreleasedReads = 0
        noteLiveFollow({ hold: 'off', baselineId: null, unreleasedReads: 0 })
        if (movedOn && !hasNewPhysicalShot) markActiveRoundLiveFromHoleChange()
      }

      // One enrichment at a time, newest waiting. This used to start one per
      // GSPro read and drop any result a newer read had overtaken; on a PC
      // where GSPro's log changes every poll and the reads take longer than a
      // poll, every result was dropped and the caddie never left the tee.
      if (enrichBusy) {
        pendingCore = snapshot
        overtaken += 1
        noteLiveFollow({ overtaken })
        return
      }
      runEnrich(snapshot)
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
