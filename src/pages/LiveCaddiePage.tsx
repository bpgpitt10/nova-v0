import { useEffect, useMemo, useRef, useState } from 'react'
import {
  connectBrowserGsproCourseStateFolder,
  connectToBrowserGsproCourseState,
  prepareBrowserGsproCourseStateRuntime,
  type BrowserGsproCourseSnapshot,
  type BrowserGsproCourseStatus,
} from '../adapters/browserGsproCourseState'
import {
  connectToBrowserGsproVisualCapture,
  type BrowserGsproVisualCaptureConnection,
  type BrowserGsproVisualCaptureStatus,
} from '../adapters/browserGsproVisualCapture'
import {
  readLooperCompanionStatus,
  readLooperCompanionObservations,
  connectToLooperNativeObservations,
  type LooperNativeObservationConnection,
  type LooperCompanionStatus,
  type LooperCompanionLiveObservations,
} from '../adapters/looperCompanion'
import { publishOneShotCompanionHud } from '../adapters/companionHudBridge'
import { learnedSurfaceFactors } from '../adapters/gsproPenaltyLog'
import { prepareReadOnlyNativeAimIntent } from '../adapters/looperCompanionAim'
import { prepareReadOnlyNativeAimPreview } from '../adapters/looperCompanionAimPreview'
import { connectToGsproLieObservation } from '../adapters/gsproLieObservation'
import { connectToGsproWindObservation } from '../adapters/gsproWindObservation'
import looperLogoWhite from '../assets/LooperLogoWhite.png'
import {
  courseCatalog,
  getCourseCatalogEntry,
  resolveCourseIdFromGsproName,
  GREYWOLF_COURSE_ID,
  UNSELECTED_COURSE_ID,
  type CourseId,
} from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import {
  loadCourseGreenDetail, sampleCourseGreenElevation, type CourseGreenDetail,
} from '../courseGeometry/courseGreenDetail'
import { buildCourseGreenApproachTarget } from '../liveCaddie/greenTargeting'
import { analyzeGreen, greenReadLine } from '../liveCaddie/greenRead'
import { buildUnderRangeShotStrategy } from '../liveCaddie/shotStrategy'
import { estimateProvisionalTee, readTeeBallPinDistanceYds } from '../courseGeometry/provisionalTeeEstimate'
import { matchProvisionalOsmTeeByDistance } from '../courseGeometry/liveSupportedTee'
import { resolveLiveFirstTeeDisplay } from '../courseGeometry/liveFirstUseTeeState'
import { loadLiveTeeSessionAnchor, saveLiveTeeSessionAnchor } from '../courseGeometry/liveTeeSessionAnchor'
import {
  loadActiveLiveCaddieRound,
  LIVE_CADDIE_START_ROUND_EVENT,
  type LiveCaddieStartRoundDetail,
} from '../liveCaddie/roundRuntime'
import {
  firstTeeCaptureKey,
  isNewLooperRoundForCapture,
  shouldHoldUnmatchedTeeRecommendation,
  captureStatusForKey,
  type TeeCaptureProgress,
} from '../liveCaddie/teeCaptureReadiness'
import { activeManualLieSurface, liveShotLieKey, type ManualLieSelection } from '../liveCaddie/currentShotLie'
import { clubEligibleForShot, type ShotOriginEligibility } from '../liveCaddie/clubShotEligibility'
import { recordGsproSurfaceHudConfirmation } from '../adapters/gsproSurfaceEvidenceStore'
import type { ManualLieSurface } from '../liveCaddie/currentShotLie'
import {
  loadLastSelectedCourseId,
  saveLastSelectedCourseId,
} from '../courseGeometry/courseSelection'
import { greywolfHole01Geometry } from '../courseGeometry/greywolfHole01'
import { classifyPoint, fairwayCorridorAtForwardY } from '../courseGeometry/geometry'
import { estimateGreywolfTerrain as estimateCourseTerrain } from '../courseGeometry/lidar'
import type {
  CourseHoleGeometry,
  CoursePointYds,
} from '../courseGeometry/types'
import {
  buildAimContextSentence,
  buildAimDescriptor,
} from '../liveCaddie/aimDescriptor'
import type { ClubAimEvaluation } from '../liveCaddie/aimOptimization'
import {
  loadCourseHoleHeadingDegreesTrue,
  localShotBearingDegrees,
  shotCompassBearingDegrees,
} from '../liveState/courseHeading'
import type { GsproLieObservation, WindObservation } from '../liveState/types'
import { projectWindObservation } from '../liveState/windProjection'
import {
  activeBagClubIds,
  BAG_CONFIG_UPDATED_EVENT,
  refreshBagConfigState,
} from '../lib/bagConfig'
import {
  loadSavedSessions,
  SESSION_HISTORY_UPDATED_EVENT,
} from '../lib/sessions'
import type { SavedSession } from '../types'
import ConditionsMathPanel from './ConditionsMathPanel'
import NativePositionsBetaPanel from '../components/NativePositionsBetaPanel'
import NativeAimPreview from '../components/NativeAimPreview'
import LiveCaddieMap from '../components/LiveCaddieMap'
import LiveDecisionDetails from './LiveDecisionDetails'
import './LiveCaddiePage.css'


type LiveCaddieWorkerMessage =
  | { type: 'success'; evaluations: ClubAimEvaluation[] }
  | { type: 'error'; error: string }

const pct = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const percentage = value * 100
  if (percentage > 0 && percentage < 1) return '<1%'
  return `${Math.round(percentage)}%`
}

const signed = (value: number | null | undefined, digits = 1) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`
}

const aimLabel = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) < 0.05) return 'Center line'
  return `${Math.abs(value).toFixed(Math.abs(value) >= 10 ? 0 : 1)} yd ${value < 0 ? 'left' : 'right'}`
}

const pointDistance = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(b[0] - a[0], b[1] - a[1])

const unitFromTo = (from: CoursePointYds, to: CoursePointYds): CoursePointYds => {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy)
  return length > 1e-9 ? [dx / length, dy / length] : [0, 1]
}

const defaultTarget = (hole: CourseHoleGeometry): CoursePointYds => {
  const pin = hole.markers.pin
  if (!pin) return [0, Math.min(220, hole.bounds.maxY)]
  const pinDistance = Math.hypot(pin[0], pin[1])
  if (pinDistance <= 260) return pin
  const landingY = Math.min(220, pinDistance * 0.65)
  const corridor = fairwayCorridorAtForwardY(hole, landingY)
  return [corridor?.centerRightYds ?? 0, landingY]
}

const estimatePinFromGsproDistance = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  distanceToPinYds: number | null,
): CoursePointYds | null => {
  const cachedPin = hole.markers.pin
  if (!cachedPin) return null
  if (distanceToPinYds == null || !Number.isFinite(distanceToPinYds) || distanceToPinYds <= 0) {
    return cachedPin
  }
  const forward = unitFromTo(ball, cachedPin)
  return [
    ball[0] + forward[0] * distanceToPinYds,
    ball[1] + forward[1] * distanceToPinYds,
  ]
}

const chooseLiveLandingTarget = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  pin: CoursePointYds | null,
): CoursePointYds => {
  if (!pin) return defaultTarget(hole)
  const distanceToPin = pointDistance(ball, pin)
  if (distanceToPin <= 260) return pin
  const landingDistance = Math.min(220, distanceToPin * 0.65)
  const forward = unitFromTo(ball, pin)
  const rawTarget: CoursePointYds = [
    ball[0] + forward[0] * landingDistance,
    ball[1] + forward[1] * landingDistance,
  ]
  const corridor = fairwayCorridorAtForwardY(hole, rawTarget[1])
  return corridor ? [corridor.centerRightYds, rawTarget[1]] : rawTarget
}

const LIVE_DIAGNOSTICS_KEY = 'looper.live-diagnostics.v1'
// Lies GSPro's file code identifies reliably; anything else asks the golfer.
const KNOWN_LIES = new Set(['tee', 'fairway', 'rough', 'deep-rough', 'sand', 'green'])

export default function LiveCaddiePage() {
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadSavedSessions())
  const [bagClubs, setBagClubs] = useState(() => [...activeBagClubIds])
  const [courseId, setCourseId] = useState<CourseId>(() => loadLastSelectedCourseId())
  const [holeNumber, setHoleNumber] = useState(1)
  const [greenDetail, setGreenDetail] = useState<CourseGreenDetail | null>(null)
  const [hole, setHole] = useState<CourseHoleGeometry | null>(() =>
    loadLastSelectedCourseId() === GREYWOLF_COURSE_ID ? greywolfHole01Geometry : null,
  )
  const [ball, setBall] = useState<CoursePointYds>(() =>
    loadLastSelectedCourseId() === GREYWOLF_COURSE_ID ? greywolfHole01Geometry.markers.tee : [0, 0],
  )
  const [target, setTarget] = useState<CoursePointYds>(() =>
    loadLastSelectedCourseId() === GREYWOLF_COURSE_ID ? defaultTarget(greywolfHole01Geometry) : [0, 220],
  )
  const [loadError, setLoadError] = useState<string | null>(null)
  const [evaluationError, setEvaluationError] = useState<string | null>(null)
  const [evaluationPending, setEvaluationPending] = useState(false)
  const [evaluations, setEvaluations] = useState<ClubAimEvaluation[]>([])
  const [livePrepared, setLivePrepared] = useState(false)
  const [liveStatus, setLiveStatus] = useState<BrowserGsproCourseStatus>('idle')
  const [liveSnapshot, setLiveSnapshot] = useState<BrowserGsproCourseSnapshot | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [connectionVersion, setConnectionVersion] = useState(0)
  const [windObservation, setWindObservation] = useState<WindObservation | null>(null)
  const [lieObservation, setLieObservation] = useState<GsproLieObservation | null>(null)
  const [manualShotLie, setManualShotLie] = useState<ManualLieSelection | null>(null)
  const [visualCaptureStatus, setVisualCaptureStatus] = useState<BrowserGsproVisualCaptureStatus>('idle')
  const [visualCaptureError, setVisualCaptureError] = useState<string | null>(null)
  const [visualCaptureSource, setVisualCaptureSource] = useState<string | null>(null)
  const [companionStatus, setCompanionStatus] = useState<LooperCompanionStatus | null>(null)
  const [nativeVisualActive, setNativeVisualActive] = useState(false)
  const [nativeVisualMessage, setNativeVisualMessage] = useState<string | null>(null)
  const [nativeObservations, setNativeObservations] = useState<LooperCompanionLiveObservations | null>(null)
  const nativeVisualRef = useRef<LooperNativeObservationConnection | null>(null)
  // The companion is required, so its wind/lie read starts on its own; only an
  // explicit "Stop Native Observations" (or a shared GSPro screen) keeps it off.
  const nativeStoppedByPlayerRef = useRef(false)
  const triedProvisionalTeeNative = useRef(new Set<string>())
  const triedShotHud = useRef(new Set<string>())
  // Status notes (yellow banners, raw codes, LiDAR internals) are for
  // troubleshooting; off by default. ?debug=1 / ?debug=0 sets it too.
  const [showDiagnostics, setShowDiagnostics] = useState(() => {
    try {
      const flag = new URLSearchParams(window.location.search).get('debug')
      if (flag === '1') window.localStorage.setItem(LIVE_DIAGNOSTICS_KEY, '1')
      if (flag === '0') window.localStorage.removeItem(LIVE_DIAGNOSTICS_KEY)
      return window.localStorage.getItem(LIVE_DIAGNOSTICS_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggleDiagnostics = () => setShowDiagnostics((value) => {
    try {
      if (value) window.localStorage.removeItem(LIVE_DIAGNOSTICS_KEY)
      else window.localStorage.setItem(LIVE_DIAGNOSTICS_KEY, '1')
    } catch {
      // per-page only
    }
    return !value
  })
  const [captureRoundId, setCaptureRoundId] = useState<string | null>(
    () => loadActiveLiveCaddieRound()?.id ?? null,
  )
  const lastCaptureRoundIdRef = useRef(captureRoundId)
  const [teeCaptureProgress, setTeeCaptureProgress] = useState<TeeCaptureProgress | null>(null)
  const [fallbackApprovedKey, setFallbackApprovedKey] = useState<string | null>(null)
  const [captureRetryNonce, setCaptureRetryNonce] = useState(0)
  const [holeHeadingDegreesTrue, setHoleHeadingDegreesTrue] = useState<number | null>(null)
  const [show95, setShow95] = useState(false)
  const [showRiskTail, setShowRiskTail] = useState(false)
  const [showPracticeShots, setShowPracticeShots] = useState(false)
  const [inspectedAimOffset, setInspectedAimOffset] = useState<number | null>(null)
  const [armedClub, setArmedClub] = useState<string | null>(null)
  const lastShotKeyRef = useRef<string | null>(null)
  const visualCaptureRef = useRef<BrowserGsproVisualCaptureConnection | null>(null)

  const selectedCourse = courseId === UNSELECTED_COURSE_ID ? null : getCourseCatalogEntry(courseId)

  // The Live Caddie page stays mounted while navigating. Start Round emits
  // several bootstrap events for the same Looper round, so reset ONLY when
  // the stable Looper round ID actually changes. GSPro's stale RoundID is not
  // an adequate identity for manual first-tee calibration.
  useEffect(() => {
    const onStartRound = (event: Event) => {
      const detail = (event as CustomEvent<LiveCaddieStartRoundDetail>).detail
      const id = detail?.round?.id
      if (!isNewLooperRoundForCapture(lastCaptureRoundIdRef.current, id)) return
      lastCaptureRoundIdRef.current = id
      triedProvisionalTeeNative.current.clear()
      triedShotHud.current.clear()
      setCaptureRoundId(id)
      setTeeCaptureProgress(null)
      setFallbackApprovedKey(null)
      setNativeObservations(null)
      setLiveSnapshot(null)
      setManualShotLie(null)
      setArmedClub(null)
    }
    window.addEventListener(LIVE_CADDIE_START_ROUND_EVENT, onStartRound)
    return () => window.removeEventListener(LIVE_CADDIE_START_ROUND_EVENT, onStartRound)
  }, [])

  // Background discovery only. Existing browser data/visual connections remain
  // authoritative until companion data + capture parity has passed sim tests.
  useEffect(() => {
    let alive = true
    let pending = false
    const refresh = async () => {
      if (pending || !alive || document.hidden) return
      const pathname = window.location.pathname.endsWith('/')
        ? window.location.pathname.slice(0, -1)
        : window.location.pathname
      if (!['/live-caddie', '/caddie', '/dev/live-caddie'].includes(pathname)) return
      pending = true
      try {
        const status = await readLooperCompanionStatus(2000)
        if (alive) setCompanionStatus(status)
      } catch {
        if (alive) setCompanionStatus(null)
      } finally {
        pending = false
      }
    }
    void refresh()
    const interval = window.setInterval(() => { void refresh() }, 8000)
    return () => { alive = false; window.clearInterval(interval) }
  }, [])

  useEffect(() => {
    const refreshSessions = () => setSessions(loadSavedSessions())
    const refreshBag = () => {
      refreshBagConfigState()
      setBagClubs([...activeBagClubIds])
    }
    window.addEventListener(SESSION_HISTORY_UPDATED_EVENT, refreshSessions)
    window.addEventListener(BAG_CONFIG_UPDATED_EVENT, refreshBag)
    window.addEventListener('storage', refreshSessions)
    window.addEventListener('storage', refreshBag)
    return () => {
      window.removeEventListener(SESSION_HISTORY_UPDATED_EVENT, refreshSessions)
      window.removeEventListener(BAG_CONFIG_UPDATED_EVENT, refreshBag)
      window.removeEventListener('storage', refreshSessions)
      window.removeEventListener('storage', refreshBag)
    }
  }, [])

  useEffect(() => {
    if (courseId !== UNSELECTED_COURSE_ID) saveLastSelectedCourseId(courseId)
  }, [courseId])

  useEffect(() => {
    const windConnection = connectToGsproWindObservation({
      onObservation: setWindObservation,
      onError: () => setWindObservation(null),
    })
    const lieConnection = connectToGsproLieObservation({
      onObservation: setLieObservation,
      onError: () => setLieObservation(null),
    })
    return () => {
      windConnection.disconnect()
      lieConnection.disconnect()
    }
  }, [])

  useEffect(() => () => {
    visualCaptureRef.current?.disconnect()
    visualCaptureRef.current = null
    nativeVisualRef.current?.disconnect()
    nativeVisualRef.current = null
  }, [])

  useEffect(() => {
    let active = true
    setHoleHeadingDegreesTrue(null)
    if (courseId === UNSELECTED_COURSE_ID) return () => { active = false }
    void loadCourseHoleHeadingDegreesTrue(courseId, holeNumber).then((heading) => {
      if (active) setHoleHeadingDegreesTrue(heading)
    })
    return () => {
      active = false
    }
  }, [courseId, holeNumber])

  useEffect(() => {
    let active = true
    void prepareBrowserGsproCourseStateRuntime()
      .then((prepared) => {
        if (!active) return
        setLivePrepared(prepared)
        if (prepared) setLiveStatus('waiting')
      })
      .catch((error) => {
        if (!active) return
        setLiveError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!livePrepared || courseId === UNSELECTED_COURSE_ID) return
    setLiveError(null)
    const connection = connectToBrowserGsproCourseState({
      onStatusChange: setLiveStatus,
      onError: (error) => setLiveError(error instanceof Error ? error.message : String(error)),
      onSnapshot: (snapshot) => {
        setLiveSnapshot(snapshot)
        if (snapshot.holeNumber && snapshot.holeNumber !== holeNumber) {
          setHoleNumber(snapshot.holeNumber)
        }
        if (snapshot.latestShotKey) {
          if (lastShotKeyRef.current && lastShotKeyRef.current !== snapshot.latestShotKey) {
            setArmedClub(null)
          }
          lastShotKeyRef.current = snapshot.latestShotKey
        }
      },
    })
    return () => connection.disconnect()
  }, [livePrepared, connectionVersion, courseId, holeNumber])

  useEffect(() => {
    let active = true
    setLoadError(null)
    if (courseId === UNSELECTED_COURSE_ID) {
      setHole(null)
      return () => { active = false }
    }

    const immediateHole = courseId === GREYWOLF_COURSE_ID && holeNumber === 1
      ? greywolfHole01Geometry
      : null
    if (immediateHole) {
      setHole(immediateHole)
      setBall(immediateHole.markers.tee)
      setTarget(defaultTarget(immediateHole))
    } else {
      setHole(null)
    }

    void loadCourseHoleGeometry(courseId, holeNumber)
      .then((loaded) => {
        if (!active) return
        setHole(loaded)
        setBall(loaded.markers.tee)
        setTarget(defaultTarget(loaded))
      })
      .catch((error) => {
        if (!active) return
        if (!immediateHole) setLoadError(error instanceof Error ? error.message : String(error))
        else console.warn('[Live Caddie] supplemental Greywolf geometry did not finish loading.', error)
      })
    return () => {
      active = false
    }
  }, [courseId, holeNumber, captureRoundId])

  // Preserve production's detailed green terrain loading and exact-pin
  // approach targeting; do not assert exact targeting from provisional frames.
  useEffect(() => {
    let active = true
    setGreenDetail(null)
    if (!selectedCourse) return () => { active = false }
    void loadCourseGreenDetail(selectedCourse.slug, holeNumber)
      .then(detail => { if (active) setGreenDetail(detail) })
      .catch(error => {
        if (active) console.warn('[Live Caddie] Green detail unavailable.', error)
      })
    return () => { active = false }
  }, [selectedCourse?.slug, holeNumber])

  const teeCaptureKey = firstTeeCaptureKey(captureRoundId, courseId, holeNumber)
  const teeCaptureStatus = captureStatusForKey(teeCaptureProgress, teeCaptureKey)
  const retryTeeCapture = () => {
    triedProvisionalTeeNative.current.delete(teeCaptureKey)
    setNativeObservations(null)
    setTeeCaptureProgress(null)
    setFallbackApprovedKey(null)
    setCaptureRetryNonce(value => value + 1)
  }

  // A single, bounded native observation is read for each Looper *round* and
  // hole, regardless of stale/unknown GSPro RoundID. A cancelled fetch must
  // not burn the sole attempt. An explicit retry does not enable polling.
  useEffect(() => {
    if (!hole || !liveSnapshot || liveSnapshot.holeNumber !== holeNumber
      || liveSnapshot.teePlacement !== 'provisional'
      || liveSnapshot.nextShotNumber !== 1
      || companionStatus?.gspro.status !== 'connected'
      || nativeVisualActive) return
    const key = teeCaptureKey
    if (triedProvisionalTeeNative.current.has(key)) return
    triedProvisionalTeeNative.current.add(key)
    let cancelled = false
    let pending = true
    setTeeCaptureProgress({ key, status: 'capturing' })
    void readLooperCompanionObservations(45000)
      .then(obs => {
        if (cancelled) return
        setNativeObservations(obs)
        publishOneShotCompanionHud(obs)
        setTeeCaptureProgress({
          key, status: obs.status === 'ready' ? 'complete' : 'failed',
          note: obs.status === 'ready' ? undefined : 'Companion could not read the GSPro minimap.',
        })
      })
      .catch(error => {
        if (!cancelled) setTeeCaptureProgress({
          key, status: 'failed',
          note: error instanceof Error ? error.message : 'Native tee capture failed.',
        })
      })
      .finally(() => { pending = false })
    return () => {
      cancelled = true
      if (pending) triedProvisionalTeeNative.current.delete(key)
    }
  }, [
    hole, courseId, holeNumber, liveSnapshot?.holeNumber,
    liveSnapshot?.nextShotNumber, liveSnapshot?.teePlacement,
    companionStatus?.gspro.status, nativeVisualActive,
    teeCaptureKey, captureRetryNonce,
  ])

  // Wind and lie for every other shot. The tee capture above only runs for a
  // provisional first tee, so after shot 1 (and on tees placed by native
  // positions) nothing refreshed wind or lie unless the golfer started the
  // 16-second polling or browser visuals. Read the companion HUD once per
  // shot, a few seconds after GSPro moves on so the HUD shows the new lie.
  const hudShotNumber = liveSnapshot?.nextShotNumber ?? null
  useEffect(() => {
    if (!liveSnapshot || liveSnapshot.holeNumber !== holeNumber || hudShotNumber == null
      || companionStatus?.gspro.status !== 'connected'
      || nativeVisualActive || visualCaptureStatus === 'connected') return
    // The provisional first-tee capture above covers that case.
    if (liveSnapshot.teePlacement === 'provisional' && hudShotNumber === 1) return
    const key = `${captureRoundId ?? 'round'}|${courseId}|${holeNumber}|${hudShotNumber}`
    if (triedShotHud.current.has(key)) return
    triedShotHud.current.add(key)
    // GSPro may still be on the previous green, scorecard or flyover when the
    // next tee or shot is detected, so retry a few times until wind reads.
    const MAX_ATTEMPTS = 5
    let cancelled = false
    let done = false
    let timer: number | null = null
    const attempt = (n: number) => {
      timer = null
      void readLooperCompanionObservations(45000)
        .then(obs => {
          if (cancelled) return
          const published = publishOneShotCompanionHud(obs)
          if (published.wind) done = true
          else if (n < MAX_ATTEMPTS) timer = window.setTimeout(() => attempt(n + 1), 4000)
          else done = true
        })
        .catch(error => {
          console.warn('[Live Caddie] Companion wind/lie read failed.', error)
          if (!cancelled && n < MAX_ATTEMPTS) timer = window.setTimeout(() => attempt(n + 1), 4000)
        })
    }
    timer = window.setTimeout(() => attempt(1), hudShotNumber === 1 ? 2500 : 3000)
    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
      // Interrupted before wind was read: allow the next render to try again.
      if (!done) triedShotHud.current.delete(key)
    }
  }, [
    liveSnapshot?.holeNumber, liveSnapshot?.teePlacement, holeNumber, hudShotNumber,
    companionStatus?.gspro.status, nativeVisualActive, visualCaptureStatus, captureRoundId, courseId,
  ])

  // The ball and pin plus a native waypoint scale produce a STRAIGHT distance,
  // not an absolute tee X or Y. Never use screenshot left/right framing as a
  // geospatial measurement; mirror/rotation/cropping remain unproven.
  const nativeProvisionalTee = useMemo(() => {
    if (!hole || !liveSnapshot || liveSnapshot.teePlacement !== 'provisional'
      || liveSnapshot.holeNumber !== hole.holeNumber
      || liveSnapshot.nextShotNumber !== 1
      || !nativeObservations || nativeObservations.status !== 'ready'
      || nativeObservations.gspro?.status !== 'connected'
      || nativeObservations.gspro.window?.minimized !== false) return null
    const seenAt = Date.parse(nativeObservations.observedAt ?? '')
    if (!Number.isFinite(seenAt) || Math.abs(Date.now()-seenAt)>30000) return null
    const shot = nativeObservations.structured?.shot
    // A completed Greywolf record left in currentRound.dat overnight must not
    // stop a user who explicitly armed FarmLinks H1 from reading CURRENT pixels.
    // Conversely, reject fresh contradictory GSPro course evidence.
    const isManuallyArmedHoleOne = hole.holeNumber === 1 && liveSnapshot.roundId == null
    const staleOldRecord = shot?.status === 'stale'
      && (nativeObservations.structured?.fileAgeMs ?? 0) > 5 * 60_000
    const seenCourse = shot?.courseKey ? resolveCourseIdFromGsproName(shot.courseKey) : null
    if (seenCourse && seenCourse !== courseId
      && !(isManuallyArmedHoleOne && staleOldRecord)) return null
    const nativeHasThisTee = shot?.kind === 'pre_shot'
      && shot?.status === 'ready'
      && shot.holeNumber === hole.holeNumber && shot.shotNumber === 1
    // Only the fresh captured native minimap supplies the distance here; no
    // world position or physical shot identity is taken from a stale record.
    if (!nativeHasThisTee && !isManuallyArmedHoleOne) return null
    const mini = nativeObservations.minimap
    const roiHeight = mini?.minimapRoiWindowPixels?.[3]
    if (!mini?.ballPixel || !Number.isFinite(roiHeight) || roiHeight! <= 0
      || mini.ballPixel.y < roiHeight! * 0.70) return null
    const distance = readTeeBallPinDistanceYds({
      ballPixel: mini.ballPixel, pinPixel: mini.pinPixel,
      yardsPerPixel: mini.scale?.yardsPerPixel,
      waypointCount: mini.scale?.waypointCount,
      scaleStatus: mini.scale?.status, markerStatus: mini.status,
    })
    if (distance == null) return null
    // Use the real imported OSM tee *polygon* when it is uniquely consistent
    // with the live GSPro ruler; only if not, project along the approximate
    // route-start-to-green axis. White remains White, not permanently Tee 3.
    const matched = matchProvisionalOsmTeeByDistance(hole, distance)
    return matched ? {
      status: 'provisional' as const,
      point: matched.candidate.coursePoint,
      source: 'distance-matched-osm-tee' as const,
      uncertaintyRadiusYds: 25,
      distanceInputYds: distance,
      adjustmentYds: 0,
      note: 'GSPro live multi-waypoint ruler suggests mapped ' +
        (matched.candidate.teeSet ?? 'OSM tee') + ' (' +
        matched.residualYds.toFixed(1) +
        ' yd from OSM green-center distance); tee label, actual pin and hazards are unverified.',
      usableForExactHazardCarry: false as const,
      authorizesNativeAim: false as const,
      locksTeeCalibration: false as const,
    } : estimateProvisionalTee(hole, distance)
  }, [hole, liveSnapshot, nativeObservations, courseId])

  // One pre-shot tee is authoritative for BOTH on-map ball placement AND
  // displayed distance. The browser's manual Shot 1 snapshot may still hold
  // the older 572-yard route anchor. Never let that stale estimate overwrite
  // a successful native two-waypoint tee measurement.
  const savedPreShotTee = liveSnapshot?.holeNumber === holeNumber
    && liveSnapshot.nextShotNumber === 1
    && liveSnapshot.teePlacement === 'provisional'
    ? loadLiveTeeSessionAnchor(loadActiveLiveCaddieRound(), holeNumber)
    : null
  const firstTeeDisplay = resolveLiveFirstTeeDisplay(
    liveSnapshot, holeNumber,
    nativeProvisionalTee?.status === 'provisional' && nativeProvisionalTee.distanceInputYds != null
      ? {
          point: nativeProvisionalTee.point,
          distanceYds: nativeProvisionalTee.distanceInputYds,
          uncertaintyYds: nativeProvisionalTee.uncertaintyRadiusYds,
          source: nativeProvisionalTee.source,
        }
      : null,
    savedPreShotTee ? {
      point: savedPreShotTee.point,
      distanceYds: savedPreShotTee.measuredStraightToPinYds,
      uncertaintyYds: savedPreShotTee.uncertaintyRadiusYds,
      source: savedPreShotTee.source,
    } : null,
  )
  const measuredPreShotTee = firstTeeDisplay.measured
  const activeRoundForCapture = loadActiveLiveCaddieRound()
  const waitingForNewRoundSnapshot = activeRoundForCapture?.id === captureRoundId
    && activeRoundForCapture.phase === 'armed'
    && activeRoundForCapture.courseId === courseId
    && holeNumber === 1
    && (!liveSnapshot || liveSnapshot.holeNumber !== holeNumber)
  const holdFirstTeeRecommendation = waitingForNewRoundSnapshot
    || shouldHoldUnmatchedTeeRecommendation({
      matchesCurrentHole: liveSnapshot?.holeNumber === holeNumber,
      nextShotNumber: liveSnapshot?.nextShotNumber ?? null,
      teePlacement: liveSnapshot?.teePlacement,
      calibrated: measuredPreShotTee !== null,
      fallbackApproved: fallbackApprovedKey === teeCaptureKey,
    })

  useEffect(() => {
    if (nativeProvisionalTee?.status !== 'provisional') return
    const round = loadActiveLiveCaddieRound()
    // Save a per-round, source-labeled assumption only. Never upgrade a
    // measured distance into an absolute confirmed tee or permanent cache.
    if (round?.courseId === courseId && hole
      && nativeProvisionalTee.distanceInputYds != null) {
      saveLiveTeeSessionAnchor(round, {
        holeNumber: hole.holeNumber,
        point: nativeProvisionalTee.point,
        source: nativeProvisionalTee.source === 'distance-matched-osm-tee'
          ? 'native-distance-matched-osm-tee'
          : 'native-distance-route-estimate',
        measuredStraightToPinYds: nativeProvisionalTee.distanceInputYds,
        uncertaintyRadiusYds: nativeProvisionalTee.uncertaintyRadiusYds,
      })
    }
    // Do not also setBall/setTarget here. The single Shot 1 authority effect
    // below owns BOTH together. Two competing target calculations used to
    // repeatedly cancel and restart the expensive decision worker.
  }, [nativeProvisionalTee, hole, courseId])

  useEffect(() => {
    if (!hole || !liveSnapshot || liveSnapshot.holeNumber !== hole.holeNumber) return
    // Keep browser GSPro authoritative on hole/shot identity, but give the
    // bounded *fresh native measurement* priority over the initial approximate
    // tee marker on shot 1 only. After shot 1, actual ending coordinates win.
    const nextBall = firstTeeDisplay.ball
      ?? (liveSnapshot.ballSource === 'cached-tee' ? hole.markers.tee : null)
    if (!nextBall) return
    // Exact pins: GSPro output_log layout, or the GKD pin slot (native beta).
    const exactPin = liveSnapshot.pinSource !== 'unavailable'
      ? liveSnapshot.pinLocalYds : null
    const nextPin = exactPin ?? estimatePinFromGsproDistance(
      hole, nextBall, firstTeeDisplay.distanceToPinYds,
    )
    const baselineTarget = chooseLiveLandingTarget(hole, nextBall, nextPin)
    const refinedGreenTarget = greenDetail && exactPin
      && Math.hypot(exactPin[0] - nextBall[0], exactPin[1] - nextBall[1]) <= 260
      && liveSnapshot.ballSource !== 'world-provisional'
      ? buildCourseGreenApproachTarget({
          hole, ball: nextBall, pin: exactPin, detail: greenDetail, exactPin: true,
        })
      : null
    const nextTarget = refinedGreenTarget?.target ?? baselineTarget
    // GSPro can rewrite output_log / currentRound while the golfer waits.
    // Identical physical coordinates must never create new array identities
    // that restart the 2,048-sample-per-candidate recommendation worker.
    setBall(previous => Math.hypot(previous[0] - nextBall[0], previous[1] - nextBall[1]) < 0.05
      ? previous : [nextBall[0], nextBall[1]])
    setTarget(previous => Math.hypot(previous[0] - nextTarget[0], previous[1] - nextTarget[1]) < 0.05
      ? previous : [nextTarget[0], nextTarget[1]])
  }, [
    hole, liveSnapshot,
    measuredPreShotTee?.point[0], measuredPreShotTee?.point[1],
    measuredPreShotTee?.distanceYds,
    greenDetail, liveSnapshot?.pinSource, liveSnapshot?.pinLocalYds,
  ])

  const liveMatchesHole = Boolean(liveSnapshot?.holeNumber === holeNumber)
  const provisionalTeeRadiusYds = liveMatchesHole && liveSnapshot?.teePlacement === 'provisional'
    && liveSnapshot.nextShotNumber === 1
    ? measuredPreShotTee?.uncertaintyYds ?? liveSnapshot.teeUncertaintyYds ?? 50
    : null
  const effectiveDistanceToPinYds = liveMatchesHole
    ? firstTeeDisplay.distanceToPinYds
    : null
  const trustedLivePin = liveMatchesHole
    && liveSnapshot != null && liveSnapshot.pinSource !== 'unavailable'
    ? liveSnapshot.pinLocalYds ?? null
    : null
  const pinEstimate = hole
    ? trustedLivePin ?? estimatePinFromGsproDistance(hole, ball, effectiveDistanceToPinYds)
    : null
  const liveLieSurface = lieObservation?.status === 'READY' && lieObservation.surface?.trim()
    ? lieObservation.surface.trim()
    : null
  const currentShotLieKey = liveShotLieKey(
    courseId, holeNumber, liveSnapshot?.roundId ?? null,
    liveSnapshot?.nextShotNumber ?? null, liveSnapshot?.latestShotKey ?? null,
  )
  const confirmedCurrentLie = activeManualLieSurface(currentShotLieKey, manualShotLie)
  const surface = confirmedCurrentLie ?? liveLieSurface
    ?? (liveMatchesHole && liveSnapshot?.surface
      ? liveSnapshot.surface
      : hole
        ? classifyPoint(hole, ball).kind
        : 'unknown')
  const nextShotNumber = liveMatchesHole
    ? liveSnapshot?.nextShotNumber ?? (surface === 'tee' ? 1 : null)
    : surface === 'tee'
      ? 1
      : null
  const shotContext = nextShotNumber != null
    ? `Shot ${nextShotNumber} · ${surface}`
    : surface
  // The final surface code belongs to the COMPLETED prior shot. Never pair a
  // screen label with an old round, another hole or another shot.
  const latestShot = liveMatchesHole ? liveSnapshot?.latestShot : null
  const matchedPreviousShot = latestShot?.holeNumber === holeNumber
    && latestShot?.roundId === liveSnapshot?.roundId
    && nextShotNumber != null
    && latestShot?.holeShot === nextShotNumber - 1
  const currentRawEndingSurface = matchedPreviousShot
    && Number.isInteger(latestShot?.endingSurfaceRaw)
    ? latestShot?.endingSurfaceRaw ?? null : null
  const confirmGsproHudLie = (confirmed: ManualLieSurface) => {
    setManualShotLie({ shotKey: currentShotLieKey, surface: confirmed })
    if (matchedPreviousShot && latestShot && currentRawEndingSurface != null
      && latestShot.roundId != null && latestShot.holeShot != null) {
      recordGsproSurfaceHudConfirmation({
        shotKey: currentShotLieKey,
        shotId: latestShot.shotId,
        courseId,
        holeNumber,
        roundId: latestShot.roundId,
        completedHoleShot: latestShot.holeShot,
        endingSurfaceRaw: currentRawEndingSurface,
        gsproHudLabel: confirmed,
        observedAt: new Date().toISOString(),
        source: 'golfer-confirmed-visible-gspro-hud',
      })
    }
  }
  // The original tee is NOT the next physical ball location. Imported GSPro
  // shot files can contain true distances/lie while lacking a validated map
  // transform. Never recommend Driver/hazard lines using the previous tee.
  const spatialPositionUnavailable = liveMatchesHole
    && nextShotNumber != null && nextShotNumber > 1
    && !liveSnapshot?.ballLocalYds
    && liveSnapshot?.ballSource !== 'cached-tee'
  const spatialPositionProvisional = liveMatchesHole
    && liveSnapshot?.ballSource === 'world-provisional'
  const savedNativeTee = liveMatchesHole
    ? loadLiveTeeSessionAnchor(loadActiveLiveCaddieRound(), holeNumber) : null
  const provisionalPositionRadiusYds = spatialPositionProvisional
    ? Math.max(40, savedNativeTee?.uncertaintyRadiusYds ?? 50)
    : null
  const greenBallElevationFt = greenDetail ? sampleCourseGreenElevation(greenDetail, ball) : null
  const ballTerrain = greenBallElevationFt != null
    ? {
        elevationFt: greenBallElevationFt,
        source: 'lidar-dem' as const,
        confidence: 'high' as const,
        gridSpacingYds: greenDetail?.grid.spacingYds ?? 1,
        note: 'High-resolution course green terrain sample.',
      }
    : hole ? estimateCourseTerrain(hole, ball) : null
  const greenTargetElevationFt = greenDetail ? sampleCourseGreenElevation(greenDetail, target) : null
  const targetTerrain = greenTargetElevationFt != null
    ? {
        elevationFt: greenTargetElevationFt,
        source: 'lidar-dem' as const,
        confidence: 'high' as const,
        gridSpacingYds: greenDetail?.grid.spacingYds ?? 1,
        note: 'High-resolution course green terrain sample.',
      }
    : hole ? estimateCourseTerrain(hole, target) : null
  const elevationDeltaFt = ballTerrain && targetTerrain
    ? targetTerrain.elevationFt - ballTerrain.elevationFt
    : null
  const elevationSource = ballTerrain && targetTerrain
    ? ballTerrain.source === 'lidar-dem' && targetTerrain.source === 'lidar-dem'
      ? `${selectedCourse?.name ?? 'Course'} direct LiDAR DEM`
      : `${selectedCourse?.name ?? 'Course'} terrain proxy`
    : 'No terrain model'
  const airAltitudeFt = ballTerrain?.elevationFt ?? null
  const airAltitudeSource = ballTerrain
    ? ballTerrain.source === 'lidar-dem'
      ? `${selectedCourse?.name ?? 'Course'} direct LiDAR DEM`
      : `${selectedCourse?.name ?? 'Course'} terrain proxy`
    : 'No absolute terrain elevation'
  const surfaceOverride = confirmedCurrentLie ?? liveLieSurface
    ?? (liveMatchesHole ? liveSnapshot?.surface ?? null : null)
  const localAimBearingDeg = localShotBearingDegrees(ball, target)
  const currentShotCompassBearingDeg = shotCompassBearingDegrees(
    holeHeadingDegreesTrue,
    localAimBearingDeg,
  )
  const projectedWind = projectWindObservation(
    windObservation,
    localAimBearingDeg,
    currentShotCompassBearingDeg,
  )
  const hasLiveWind = projectedWind.projection !== null
  const windMph = hasLiveWind && windObservation?.speedMph != null
    ? windObservation.speedMph
    : 0
  const windRelativeDeg = projectedWind.projection?.relativeFromDegrees ?? 0
  const authoritativeGsproSurface = liveMatchesHole ? liveSnapshot?.surface ?? null : null
  const normalizedCurrentSurface = (authoritativeGsproSurface ?? surface).trim().toLowerCase()
  const isGreenSurface = normalizedCurrentSurface === 'green'
  const greenGuidance = !isGreenSurface && hole && greenDetail && trustedLivePin
    && liveMatchesHole && liveSnapshot?.ballSource !== 'world-provisional'
    && Math.hypot(ball[0] - trustedLivePin[0], ball[1] - trustedLivePin[1]) <= 260
      ? buildCourseGreenApproachTarget({
          hole, ball, pin: trustedLivePin, detail: greenDetail, exactPin: true,
        })
      : null
  const isTeeSurface = typeof authoritativeGsproSurface === 'string'
    && authoritativeGsproSurface.trim().toLowerCase() === 'tee'
  const hasOcrLie = lieObservation?.status === 'READY' && (
    (typeof lieObservation.upDownDegrees === 'number' && Number.isFinite(lieObservation.upDownDegrees))
    || (typeof lieObservation.leftRightDegrees === 'number' && Number.isFinite(lieObservation.leftRightDegrees))
  )
  // Only an explicit GSPro Shot 1 + TEE state may authorize tee-only
  // clubs. Unknown/unsynchronized live state is NOT a tee authorization.
  const shotOrigin: ShotOriginEligibility = liveMatchesHole
    && nextShotNumber === 1 && isTeeSurface
      ? 'tee'
      : liveMatchesHole && nextShotNumber != null
        ? 'non-tee' : 'unknown'
  const hasLiveLie = isTeeSurface || hasOcrLie
  const lieUpDownDeg = isTeeSurface
    ? 0
    : hasOcrLie
      && typeof lieObservation?.upDownDegrees === 'number'
      && Number.isFinite(lieObservation.upDownDegrees)
      ? lieObservation.upDownDegrees
      : null
  const lieLeftRightDeg = isTeeSurface
    ? 0
    : hasOcrLie
      && typeof lieObservation?.leftRightDegrees === 'number'
      && Number.isFinite(lieObservation.leftRightDegrees)
      ? -lieObservation.leftRightDegrees
      : null
  const lieSource = isTeeSurface
    ? 'GSPro tee invariant (0.0° / 0.0°)'
    : hasOcrLie
      ? lieObservation?.source ?? 'GSPro lie OCR'
      : undefined

  useEffect(() => {
    if (isGreenSurface) {
      setArmedClub(null)
      setInspectedAimOffset(null)
    }
  }, [isGreenSurface])

  useEffect(() => {
    if (!hole || isGreenSurface || spatialPositionUnavailable || holdFirstTeeRecommendation) {
      setEvaluations([])
      setEvaluationError(null)
      setEvaluationPending(false)
      return
    }

    let cancelled = false
    const worker = new Worker(new URL('./LiveCaddieWorker.ts', import.meta.url), {
      type: 'module',
    })
    setEvaluations([])
    setEvaluationError(null)
    setEvaluationPending(true)

    worker.onmessage = (event: MessageEvent<LiveCaddieWorkerMessage>) => {
      if (cancelled) return
      const message = event.data
      if (message.type === 'success') {
        setEvaluations(message.evaluations)
        setEvaluationError(null)
      } else {
        setEvaluations([])
        setEvaluationError(message.error)
      }
      setEvaluationPending(false)
      worker.terminate()
    }

    worker.onerror = (event) => {
      if (cancelled) return
      setEvaluations([])
      setEvaluationError(event.message || 'Live Caddie decision worker failed.')
      setEvaluationPending(false)
      worker.terminate()
    }

    worker.postMessage({
      learnedSurfaceFactors: learnedSurfaceFactors(),
      sessions,
      hole,
      ball,
      target,
      environment: {
        windMph,
        windRelativeDeg,
        elevationDeltaFt,
        elevationSource,
        airAltitudeFt,
        airAltitudeSource,
        surfaceOverride,
        shotOrigin,
        lieUpDownDeg,
        lieLeftRightDeg,
        lieSource,
        exactPinLocalYds: trustedLivePin,
        greenDetail: trustedLivePin && liveSnapshot?.ballSource !== 'world-provisional'
          ? greenDetail : null,
      },
      nowMs: Date.now(),
    })

    return () => {
      cancelled = true
      worker.terminate()
    }
  }, [
    sessions,
    hole,
    ball,
    target,
    isGreenSurface,
    spatialPositionUnavailable,
    holdFirstTeeRecommendation,
    windMph,
    windRelativeDeg,
    elevationDeltaFt,
    elevationSource,
    airAltitudeFt,
    airAltitudeSource,
    surfaceOverride,
    shotOrigin,
    lieUpDownDeg,
    lieLeftRightDeg,
    lieSource,
    trustedLivePin, greenDetail,
  ])

  const shotStrategy = hole && !isGreenSurface && !holdFirstTeeRecommendation
    && !spatialPositionUnavailable && !evaluationPending
    ? buildUnderRangeShotStrategy({
        evaluations,
        hole,
        ball,
        target,
        pin: trustedLivePin ?? pinEstimate,
        greenDetail: trustedLivePin && liveSnapshot?.ballSource !== 'world-provisional'
          ? greenDetail : null,
        trustedPin: Boolean(trustedLivePin && liveSnapshot?.ballSource !== 'world-provisional'),
      })
    : null
  const isShotStrategy = Boolean(shotStrategy)
  const recommendation = isShotStrategy ? null : evaluations[0] ?? null
  // A user-selected club is metadata in Partial Shot Strategy, never a
  // modeled partial-flight recommendation; tee-only clubs remain prohibited.
  const eligibleArmedClub = armedClub && clubEligibleForShot(armedClub, shotOrigin)
    ? armedClub : null
  const viewedEvaluation = isShotStrategy
    ? shotStrategy?.referenceEvaluation ?? null
    : eligibleArmedClub
      ? evaluations.find((evaluation) => evaluation.club === eligibleArmedClub) ?? null
      : recommendation
  const viewedBestCandidate = viewedEvaluation?.bestCandidate ?? null
  const inspectedCandidate = !isShotStrategy && viewedEvaluation
    ? viewedEvaluation.candidates.find((candidate) => candidate.aimOffsetYds === inspectedAimOffset)
      ?? viewedBestCandidate
      ?? null
    : null
  const risk = isShotStrategy ? null : inspectedCandidate?.riskProfile ?? null
  // Green read (steepness, tilt, tiers, spines). Shown only when this shot can
  // actually get to the green: the expected finish reaches the front of the
  // green, or comes up no more than ~20 yd short. Tee shots on par 4s and 5s
  // and lay-ups stay clean.
  const greenReadAnalysis = useMemo(() => {
    if (!hole || !greenDetail) return null
    const greens = hole.surfaces.filter((s) => s.kind === 'green').flatMap((s) => s.polygons)
    return analyzeGreen(greenDetail, greens)
  }, [hole, greenDetail])
  const greenReachable = (() => {
    if (!hole || isGreenSurface || !pinEstimate) return false
    if (isShotStrategy) return true
    const finish = inspectedCandidate?.meanLanding
    if (!finish) return false
    const d = Math.hypot(pinEstimate[0] - ball[0], pinEstimate[1] - ball[1]) || 1
    const ux = (pinEstimate[0] - ball[0]) / d
    const uy = (pinEstimate[1] - ball[1]) / d
    const greenPts = hole.surfaces.filter((s) => s.kind === 'green').flatMap((s) => s.polygons).flat()
    if (!greenPts.length) return false
    const front = Math.min(...greenPts.map((p) => (p[0] - ball[0]) * ux + (p[1] - ball[1]) * uy))
    const reach = (finish[0] - ball[0]) * ux + (finish[1] - ball[1]) * uy
    return reach >= front - 20
  })()
  const shownGreenRead = greenReachable ? greenReadAnalysis : null
  const greenReadText = shownGreenRead && pinEstimate
    ? greenReadLine(shownGreenRead, ball, pinEstimate, Boolean(trustedLivePin))
    : null
  const displayedClub = isShotStrategy
    ? eligibleArmedClub
    : eligibleArmedClub ?? viewedEvaluation?.club ?? recommendation?.club ?? null
  const isAlternateClub = Boolean(
    !isShotStrategy && eligibleArmedClub && recommendation?.club
      && eligibleArmedClub !== recommendation.club,
  )
  const viewedClubRank = isShotStrategy ? null : viewedEvaluation?.decisionRank ?? null
  const aimDescriptor = !isShotStrategy && hole && viewedEvaluation && inspectedCandidate
    ? buildAimDescriptor({
        hole,
        ball,
        target: viewedEvaluation.planningTarget,
        aimPoint: inspectedCandidate.aimPoint,
        aimOffsetYds: inspectedCandidate.aimOffsetYds,
        pin: pinEstimate,
      })
    : null
  // A short-game tactical point must NEVER be formatted as a native full-shot
  // aim command. Native aim remains read-only and has no shot-strategy intent.
  const nativeAimIntent = prepareReadOnlyNativeAimIntent({
    snapshot: liveMatchesHole ? liveSnapshot : null,
    courseId,
    holeNumber,
    club: isShotStrategy ? null : displayedClub,
    teeLocalYds: hole?.markers.tee ?? null,
    targetLocalYds: isShotStrategy ? null : inspectedCandidate?.aimPoint ?? null,
  })
  const nativeAimPreview = !isShotStrategy && nativeVisualActive
    ? prepareReadOnlyNativeAimPreview(nativeAimIntent, nativeObservations)
    : null
  const playerFacingAim = isShotStrategy
    ? shotStrategy?.aimInstruction ?? 'target line'
    : aimDescriptor?.text
      ?? (viewedEvaluation ? aimLabel(inspectedCandidate?.aimOffsetYds) : 'No modeled line')
  const aimContext = aimDescriptor ? buildAimContextSentence(aimDescriptor) : null

  useEffect(() => {
    setInspectedAimOffset(null)
  }, [courseId, holeNumber, viewedEvaluation?.club, isShotStrategy])

  // A new physical shot must never inherit a previous club's "armed" state.
  useEffect(() => {
    setArmedClub(null)
  }, [courseId, holeNumber, liveSnapshot?.roundId, liveSnapshot?.nextShotNumber])

  const connectGspro = async () => {
    setLiveError(null)
    try {
      await connectBrowserGsproCourseStateFolder()
      setLivePrepared(true)
      setConnectionVersion((value) => value + 1)
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : String(error))
    }
  }

  const connectGsproVisuals = async () => {
    nativeVisualRef.current?.disconnect()
    nativeVisualRef.current = null
    setNativeVisualActive(false)
    setNativeVisualMessage(null)
    setNativeObservations(null)
    setVisualCaptureError(null)
    setVisualCaptureSource(null)
    visualCaptureRef.current?.disconnect()
    visualCaptureRef.current = null
    try {
      const connection = await connectToBrowserGsproVisualCapture({
        onStatusChange: setVisualCaptureStatus,
        onError: (error) => setVisualCaptureError(
          error instanceof Error ? error.message : String(error),
        ),
        initiallyPaused: isGreenSurface,
      })
      visualCaptureRef.current = connection
      setVisualCaptureSource(connection.sourceLabel ?? connection.displaySurface)
    } catch (error) {
      setVisualCaptureError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleNativeVisuals = () => {
    if (nativeVisualRef.current) {
      nativeStoppedByPlayerRef.current = true
      nativeVisualRef.current.disconnect()
      nativeVisualRef.current = null
      setNativeVisualActive(false)
      setNativeObservations(null)
        setNativeVisualMessage('Native observation polling stopped.')
      return
    }
    visualCaptureRef.current?.disconnect()
    visualCaptureRef.current = null
    setVisualCaptureStatus('stopped')
    setVisualCaptureError(null)
    setNativeVisualActive(true)
    setNativeVisualMessage('Requesting a fresh read-only companion snapshot…')
    nativeVisualRef.current = connectToLooperNativeObservations({
      onObservation: (data) => {
        setNativeObservations(data)
        const wind = data.ocr?.wind?.status ?? 'UNAVAILABLE'
        const lie = data.ocr?.lie?.status ?? 'UNAVAILABLE'
        const map = data.minimap?.status ?? 'unavailable'
        setNativeVisualMessage(`Native observations: wind ${wind}, lie ${lie}, minimap ${map}. Ball/pin still diagnostic-only.`)
      },
      onError: (error) => setNativeVisualMessage(
        `Native observation error: ${error instanceof Error ? error.message : String(error)}`,
      ),
    })
  }

  useEffect(() => {
    if (nativeVisualRef.current || nativeStoppedByPlayerRef.current) return
    if (!companionStatus?.capabilities?.liveObservations) return
    if (companionStatus.gspro.status !== 'connected') return
    if (visualCaptureStatus === 'connected' || visualCaptureStatus === 'requesting'
      || visualCaptureStatus === 'loading-ocr') return
    toggleNativeVisuals()
    // toggleNativeVisuals only reads refs and setters; re-running on its identity is not wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companionStatus?.capabilities?.liveObservations, companionStatus?.gspro.status, visualCaptureStatus])

  const selectCourse = (nextCourseId: CourseId) => {
    setCourseId(nextCourseId)
    setHoleNumber(1)
    setLiveSnapshot(null)
    setNativeObservations(null)
    setArmedClub(null)
    lastShotKeyRef.current = null
  }

  const playerFacingTrouble = risk ? risk.seriousTrouble + risk.unknown : null
  const outcomeDetails = risk ? [
    ['Bunker', risk.bySurface.bunker ?? 0],
    ['Deep rough / woods', risk.bySurface['deep-rough'] ?? 0],
    ['Outside Map Area', risk.unknown],
    ['Water', risk.bySurface.water ?? 0],
    ['Penalty', risk.bySurface.penalty ?? 0],
  ].filter(([, value]) => typeof value === 'number' && value > 0.002) as Array<[string, number]> : []

  return (
    <main className="live-caddie-page">
      <div className="live-caddie-backdrop" />
      <div className="live-caddie-shell">
        <header className="live-caddie-header">
          <a className="live-caddie-logo-link" href="/dashboard" aria-label="Looper dashboard">
            <img src={looperLogoWhite} className="live-caddie-logo" alt="Looper" />
          </a>

          <div className="live-caddie-course-context">
            <div>
              <span className="live-kicker">LIVE CADDIE</span>
              <strong>{selectedCourse?.name ?? 'Choose a course'}</strong>
            </div>
            {selectedCourse ? <span>Hole {holeNumber}</span> : null}
          </div>

          <div className="live-caddie-header-actions">
            <div className={`live-connection-state state-${livePrepared ? liveStatus : 'offline'}`}>
              <i />
              <span>{livePrepared ? `GSPro ${liveStatus}` : 'GSPro not connected'}</span>
            </div>
            {companionStatus?.gspro.status === 'connected' ? (
              <div className="live-connection-state state-connected"
                title={`Native Looper Companion ${companionStatus.version}; folder: ${companionStatus.dataFolder.status}. ${nativeAimIntent ? 'Read-only Looper-local recommendation prepared; GSPro coordinate frame not verified.' : 'Waiting for validated live shot and recommendation.'} Auto Aim remains disabled.`}
                data-aim-intent={nativeAimIntent ? 'read-only-unverified' : 'blocked'}>
                <i />
                <span>Companion connected</span>
              </div>
            ) : null}
            {/* Diagnostics remain available at /dev/aim-lab, without a primary Live Caddie header link. */}
          </div>
        </header>

        <section className="live-caddie-setup-row">
          <select value={courseId} onChange={(event) => selectCourse(event.target.value as CourseId)}>
            {courseCatalog.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </select>
          <select
            value={holeNumber}
            disabled={livePrepared}
            onChange={(event) => setHoleNumber(Number(event.target.value))}
          >
            {Array.from({ length: 18 }, (_, index) => index + 1).map((number) => (
              <option key={number} value={number}>Hole {number}</option>
            ))}
          </select>
          {!livePrepared ? <button type="button" onClick={() => void connectGspro()}>Connect GSPro</button> : null}
          {liveStatus === 'error' ? <button type="button" onClick={() => void connectGspro()}>Reconnect</button> : null}
          {companionStatus?.capabilities?.liveObservations ? (
            <button type="button" onClick={toggleNativeVisuals}>
              {nativeVisualActive ? 'Stop Native Observations' : 'Use Native Wind / Lie'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void connectGsproVisuals()}
            disabled={visualCaptureStatus === 'requesting' || visualCaptureStatus === 'loading-ocr'}
            title="Share the GSPro application window. If window capture is blank, reconnect and share the full GSPro display instead."
          >
            {visualCaptureStatus === 'connected'
              ? 'Reconnect GSPro Visuals'
              : visualCaptureStatus === 'requesting'
                ? 'Choose GSPro Window…'
                : visualCaptureStatus === 'loading-ocr'
                  ? 'Loading Visual OCR…'
                  : 'Connect GSPro Visuals'}
          </button>
          <button type="button" className="live-diagnostics-toggle" onClick={toggleDiagnostics}>
            {showDiagnostics ? 'Hide details' : 'Details'}
          </button>
          <div className="live-caddie-secondary-context">
            {nativeVisualMessage ? <span>{nativeVisualMessage}</span> : null}
            <span>{shotContext}</span>
            {pinEstimate ? <span>{Math.round(pointDistance(ball, pinEstimate))} yd to pin</span> : null}
            {showDiagnostics && greenGuidance ? <span>Green LiDAR · {greenGuidance.reason}</span> : null}
            {!isGreenSurface && elevationDeltaFt != null ? <span>{signed(elevationDeltaFt, 0)} ft to target</span> : null}
            {airAltitudeFt != null && Math.abs(airAltitudeFt) >= 500
              ? <span>{Math.round(airAltitudeFt).toLocaleString()} ft ASL</span>
              : null}
            {visualCaptureStatus === 'connected' ? (
              <>
                <span>Visual capture connected{visualCaptureSource ? ` · ${visualCaptureSource}` : ''}</span>
                <span>{isGreenSurface
                  ? 'Visual OCR paused on green'
                  : `Wind OCR ${windObservation?.status ?? 'WAITING'} · ${isTeeSurface
                    ? 'Lie 0/0 (TEE)'
                    : `Lie OCR ${lieObservation?.status ?? 'WAITING'}`}`}</span>
              </>
            ) : null}
          </div>
        </section>
        <NativePositionsBetaPanel
          courseId={courseId === UNSELECTED_COURSE_ID ? null : courseId}
          courseKey={liveSnapshot?.courseKey ?? null}
        />

        {nativeVisualActive ? (
          <section className="live-native-aim-diagnostic" data-native-input-authorized="false">
            <div className="live-native-aim-diagnostic-heading">
              <span className="live-kicker">READ-ONLY NATIVE AIM CHECK</span>
              <strong>{nativeAimPreview?.status === 'candidate-unverified'
                ? 'Pixel candidate — not verified'
                : 'Preview blocked'}</strong>
            </div>
            <p>{nativeAimPreview?.reason ?? 'Waiting for the first native observation.'}</p>
            {nativeAimPreview?.targetPixel && nativeAimPreview.roiWidthPx && nativeAimPreview.roiHeightPx
                && nativeObservations?.minimap?.ballPixel && nativeObservations.minimap.pinPixel ? (
              <div className="live-native-preview-layout">
                <svg
                  role="img"
                  aria-label="Schematic minimap preview showing native ball, pin, and proposed aim. No screenshot and no desktop click."
                  viewBox={['0', '0', nativeAimPreview.roiWidthPx, nativeAimPreview.roiHeightPx].join(' ')}
                  preserveAspectRatio="xMidYMid meet"
                  className="live-native-preview-schematic"
                >
                  <rect x="0" y="0" width={nativeAimPreview.roiWidthPx} height={nativeAimPreview.roiHeightPx}
                    fill="rgba(24, 52, 34, 0.95)" rx="15" />
                  <line x1={nativeObservations.minimap.ballPixel.x}
                    y1={nativeObservations.minimap.ballPixel.y}
                    x2={nativeAimPreview.targetPixel.x}
                    y2={nativeAimPreview.targetPixel.y}
                    stroke="#d8ed96" strokeDasharray="10 8" strokeWidth="3" />
                  <circle cx={nativeObservations.minimap.pinPixel.x} cy={nativeObservations.minimap.pinPixel.y}
                    r="9" fill="#fff" stroke="#173b29" strokeWidth="3" />
                  <circle cx={nativeObservations.minimap.ballPixel.x} cy={nativeObservations.minimap.ballPixel.y}
                    r="10" fill="#e7605b" stroke="#fff" strokeWidth="2.5" />
                  <circle cx={nativeAimPreview.targetPixel.x} cy={nativeAimPreview.targetPixel.y}
                    r="13" fill="none" stroke="#d9f886" strokeWidth="3" />
                  <line x1={nativeAimPreview.targetPixel.x - 18} x2={nativeAimPreview.targetPixel.x + 18}
                    y1={nativeAimPreview.targetPixel.y} y2={nativeAimPreview.targetPixel.y}
                    stroke="#d9f886" strokeWidth="2.5" />
                  <line y1={nativeAimPreview.targetPixel.y - 18} y2={nativeAimPreview.targetPixel.y + 18}
                    x1={nativeAimPreview.targetPixel.x} x2={nativeAimPreview.targetPixel.x}
                    stroke="#d9f886" strokeWidth="2.5" />
                </svg>
                <span className="live-native-preview-legend">
                  <span><b className="dot-ball" /> Native ball</span>
                  <span><b className="dot-pin" /> Native pin</span>
                  <span><b className="dot-target" /> Looper preview</span>
                  <small>Schematic pixel positions only; not actual GSPro imagery or a Set Aim control.</small>
                </span>
              </div>
            ) : null}
            {nativeAimPreview?.targetPixel ? (
              <p>Looper target → GSPro minimap ROI
                <strong> ({nativeAimPreview.targetPixel.x}, {nativeAimPreview.targetPixel.y}) px</strong>
                {' · '}tee/pin anchor difference {nativeAimPreview.teePinAnchorErrorYds} yd
                {' · '}current ball residual {nativeAimPreview.projectedBallErrorYds} yd
                {' · '}shot match {nativeAimPreview.shotMatch}
              </p>
            ) : null}
            {nativeObservations?.timingMs ? (
              <p className="live-native-timings">
                Native timings (ms):
                {' '}folder/state {nativeObservations.timingMs.structuredDiscovery ?? '—'}
                {' · '}capture {nativeObservations.timingMs.nativeCapture ?? '—'}
                {' · '}markers {nativeObservations.timingMs.markerDetection ?? '—'}
                {' · '}waypoint OCR {nativeObservations.timingMs.waypointOcr ?? '—'}
                {' · '}zoom register {nativeObservations.timingMs.zoomRegistration ?? '—'}
                {' · '}wind {nativeObservations.timingMs.windOcr ?? '—'}
                {' · '}lie {nativeObservations.timingMs.lieOcr ?? '—'}
                {' · '}total {nativeObservations.timingMs.total ?? '—'}
              </p>
            ) : null}
            <small>Looper-local preview geometry is NOT GSPro/world registration. No Set Aim command or mouse input is available.</small>
          </section>
        ) : null}

        {liveMatchesHole && nextShotNumber != null && nextShotNumber > 1 && !isGreenSurface
          && (showDiagnostics || !KNOWN_LIES.has(normalizedCurrentSurface)) ? (
          <div className="live-caddie-alert live-lie-confirmation" data-lie-source={confirmedCurrentLie ? 'manual-gspro-hud' : 'unverified'}>
            {KNOWN_LIES.has(normalizedCurrentSurface) || confirmedCurrentLie ? (
              <span>Current lie: <strong>{surface === 'deep-rough' ? 'Deep Rough' : surface}</strong>
                {confirmedCurrentLie ? ' — set by you for this shot.' : ' — from GSPro.'}
                {currentRawEndingSurface != null ? ` GSPro code ${currentRawEndingSurface}.` : ''}
              </span>
            ) : (
              <span>Looper doesn't recognise this lie yet
                {currentRawEndingSurface != null ? ` (GSPro code ${currentRawEndingSurface})` : ''}.
                {' '}Which lie does GSPro show?
              </span>
            )}
            <span className="live-lie-confirmation-actions">
              <button type="button"
                className={confirmedCurrentLie === 'deep-rough' ? 'selected' : ''}
                onClick={() => confirmGsproHudLie('deep-rough')}>
                Use Deep Rough
              </button>
              <button type="button"
                className={confirmedCurrentLie === 'rough' ? 'selected' : ''}
                onClick={() => confirmGsproHudLie('rough')}>
                Rough
              </button>
              <button type="button"
                className={confirmedCurrentLie === 'sand' ? 'selected' : ''}
                onClick={() => confirmGsproHudLie('sand')}>
                Sand
              </button>
              {confirmedCurrentLie ? (
                <button type="button" onClick={() => setManualShotLie(null)}>Reset to detected</button>
              ) : null}
            </span>
          </div>
        ) : null}
        {showDiagnostics && spatialPositionProvisional ? (
          <div className="live-caddie-alert" data-spatial-position="provisional">
            Imported-course ball placement uses the actual GSPro shot movement and a
            provisional OSM tee anchor/true-north heading. The position and displayed
            club are planning estimates, not verified exact hazard carries, odds,
            elevation or a native aim target. Approximate map uncertainty is at least
            ±{provisionalPositionRadiusYds ?? 50} yards.
          </div>
        ) : null}
        {spatialPositionUnavailable ? (
          <div className="live-caddie-alert bad" data-spatial-position="unavailable">
            GSPro reported Shot {nextShotNumber} and the remaining pin distance, but its ball position
            cannot yet be registered to this imported course map. The previous tee marker is NOT the
            current ball. Club, hazard, elevation and aim recommendations are paused until a
            validated position is available.
          </div>
        ) : null}
        {liveError ? <div className="live-caddie-alert bad">GSPro: {liveError}</div> : null}
        {visualCaptureError ? (
          <div className="live-caddie-alert bad">GSPro visuals: {visualCaptureError}</div>
        ) : null}
        {showDiagnostics && visualCaptureStatus === 'stopped' && !visualCaptureError ? (
          <div className="live-caddie-alert">GSPro visual capture stopped. Reconnect visuals for live wind and lie.</div>
        ) : null}
        {showDiagnostics && liveSnapshot?.teePlacement === 'provisional'
          && liveSnapshot.holeNumber === holeNumber
          && liveSnapshot.nextShotNumber === 1 ? (
          <div className="live-caddie-alert" data-tee-quality="provisional">
            Provisional first-use tee — about ±{provisionalTeeRadiusYds ?? 50} yards.
            {measuredPreShotTee
              ? (measuredPreShotTee.source === 'distance-matched-osm-tee'
                  || measuredPreShotTee.source === 'native-distance-matched-osm-tee')
                ? ' Native two-waypoint ruler matched an existing OSM tee polygon; that position now drives the map, yardage and recommendation. Tee identity and exact hazard accuracy remain unverified.'
                : ' Native ball/pin ruler constrained the forward tee estimate; lateral position remains unknown.'
              : ' Using approximate OSM route start until a reliable GSPro ball/pin ruler is available.'}
            {' '}Club choice is preliminary; exact forced carries, hazard margins, elevation at tee
            and native aim are not verified. Do not save this as a confirmed tee.
          </div>
        ) : null}
        {loadError ? <div className="live-caddie-alert bad">Course geometry: {loadError}</div> : null}
        {evaluationError ? <div className="live-caddie-alert bad">Decision engine: {evaluationError}</div> : null}
        {showDiagnostics && liveSnapshot?.warnings
          .filter(warning => !(measuredPreShotTee
            && warning.startsWith('Provisional Hole ')
            && (warning.includes('existing-map-tee-anchor') || warning.includes('osm-route-start'))))
          .map((warning) => <div className="live-caddie-alert" key={warning}>{warning}</div>)}

        {courseId === UNSELECTED_COURSE_ID ? (
          <section className="live-empty-state">
            <span className="live-kicker">READY WHEN YOU ARE</span>
            <h1>Select the course Looper should play.</h1>
            <p>The playing surface will use the same course geometry, player model and decision engine as Aim Lab.</p>
          </section>
        ) : !hole ? (
          <section className="live-empty-state">
            <span className="live-kicker">LOADING COURSE</span>
            <h1>{selectedCourse?.name} · Hole {holeNumber}</h1>
          </section>
        ) : isGreenSurface ? (
          <section className="live-empty-state">
            <span className="live-kicker">ON GREEN</span>
            <h1>Caddie paused.</h1>
            <p>Looper is recording the putt sequence and hole completion for scoring, but it is not calculating a club, aim, wind or lie recommendation.</p>
          </section>
        ) : holdFirstTeeRecommendation ? (
          <section className="live-empty-state" data-recommendation-gate="first-tee-capture">
            <span className="live-kicker">PROVISIONAL TEE · NOT YET MEASURED</span>
            <h1>{teeCaptureStatus === 'capturing'
              ? 'Locating tee and reading conditions…'
              : 'Tee measurement needed.'}</h1>
            <p>
              This hole's initial OSM position is only an estimate. Looper will
              not rank a club or aim line from that unmeasured tee.
              {teeCaptureStatus === 'failed' ? ' The last native attempt did not complete.' : ''}
              {teeCaptureStatus === 'complete'
                ? ' Native capture returned, but the waypoint scale did not establish a matching tee.'
                : null}
              {teeCaptureStatus === 'not-started'
                ? ' Waiting for a connected Windows Companion or an explicit fallback choice.'
                : null}
            </p>
            {teeCaptureProgress?.key === teeCaptureKey && teeCaptureProgress.note
              ? <p>{teeCaptureProgress.note}</p> : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
              <button type="button" onClick={retryTeeCapture}
                disabled={teeCaptureStatus === 'capturing'}>
                {teeCaptureStatus === 'capturing' ? 'Reading GSPro…' : 'Retry tee measurement'}
              </button>
              <button type="button" onClick={() => setFallbackApprovedKey(teeCaptureKey)}>
                Use approximate OSM tee instead
              </button>
            </div>
            <p>Approximate fallback will display a provisional club estimate, not verified hazard carries or an exact tee position.</p>
          </section>
        ) : spatialPositionUnavailable ? (
          <section className="live-empty-state" data-recommendation-gate="unregistered-ball">
            <span className="live-kicker">POSITION NOT REGISTERED</span>
            <h1>Shot {nextShotNumber} recognized. Mapping pending.</h1>
            <p>GSPro distance to pin: {liveSnapshot?.distanceToPinYds != null
              ? `${Math.round(liveSnapshot.distanceToPinYds)} yd` : 'unavailable'}.
              We will not reuse the old tee point to calculate a misleading club or aim.
              Physical shot tracking remains active.</p>
          </section>
        ) : (
          <>
            <section className="live-caddie-main-grid">
              <aside className="live-decision-column">
                <article className={`live-decision-card${isShotStrategy ? ' strategy-mode' : ''}`}>
                  <div className="live-decision-label-row">
                    <span className="live-recommended-pill">
                      {evaluationPending
                        ? 'CALCULATING'
                        : isShotStrategy
                          ? 'SHOT STRATEGY'
                        : spatialPositionProvisional
                          ? 'PROVISIONAL · CLUB ESTIMATE'
                        : isAlternateClub
                          ? `USER SELECTED${viewedClubRank ? ` · #${viewedClubRank} CLUB` : ''}`
                          : 'RECOMMENDED · #1 CLUB'}
                    </span>
                    {!isShotStrategy && isAlternateClub && recommendation ? (
                      <span style={{ color: '#9fb09f', fontSize: '10px' }}>
                        Looper recommends {recommendation.club}
                      </span>
                    ) : inspectedCandidate && viewedBestCandidate && inspectedCandidate !== viewedBestCandidate ? (
                      <button className="live-reset-inspection" type="button" onClick={() => setInspectedAimOffset(null)}>
                        Viewing alternate · reset
                      </button>
                    ) : null}
                  </div>

                  <div className="live-club-hero">{isShotStrategy && shotStrategy
                    ? `PLAY ${Math.round(shotStrategy.effectiveDistanceYds)} YDS`
                    : displayedClub ?? '—'}</div>
                  <div className="live-aim-hero">
                    {playerFacingAim}
                  </div>
                  {isShotStrategy && shotStrategy ? (
                    <div className="live-strategy-read">
                      <div><span>GREEN TERRAIN</span><strong>{shotStrategy.terrain}</strong></div>
                      {shotStrategy.hazard ? (
                        <div><span>HAZARD</span><strong>{shotStrategy.hazard}</strong></div>
                      ) : null}
                      <div><span>SAFE MISS</span><strong>{shotStrategy.safeMiss}</strong></div>
                      {!trustedLivePin ? (
                        <div><span>POSITION CONFIDENCE</span>
                          <strong>Estimated pin — green contours and precise hazard margins are unverified.</strong>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                  <p className="live-decision-reason">
                    {greenReadText ? (
                      <span className="live-green-read"><strong>Green:</strong> {greenReadText}</span>
                    ) : null}
                    {aimContext
                      ?? inspectedCandidate?.decisionReason
                      ?? viewedEvaluation?.decisionReason
                      ?? (evaluationPending
                        ? 'Looper is calculating the club, aim and next-shot value in the background.'
                        : displayedClub
                          ? `Looper does not yet have enough modeled support to rank a ${displayedClub} line for this shot.`
                          : 'Looper is waiting for enough player data to rank this shot.')}
                  </p>
                  )}

                  <ConditionsMathPanel
                    evaluation={viewedEvaluation}
                    windMph={windMph}
                    windRelativeDeg={windRelativeDeg}
                    hasLiveWind={hasLiveWind}
                    elevationDeltaFt={elevationDeltaFt}
                    lieUpDownDeg={hasLiveLie ? lieUpDownDeg : null}
                    lieLeftRightDeg={hasLiveLie ? lieLeftRightDeg : null}
                    strategyMode={isShotStrategy}
                    strategyEffectiveDistanceYds={shotStrategy?.effectiveDistanceYds ?? null}
                    strategyEffectiveLateralYds={shotStrategy?.effectiveLateralChangeYds ?? null}
                    strategyAdjustmentScale={shotStrategy?.adjustmentScale ?? 1}
                  />

                  <button
                    type="button"
                    className={`live-arm-recommendation${eligibleArmedClub && eligibleArmedClub === displayedClub ? ' armed' : ''}${isShotStrategy ? ' strategy-mode' : ''}`}
                    disabled={isShotStrategy || !displayedClub}
                    onClick={() => { if (!isShotStrategy && displayedClub) setArmedClub(displayedClub) }}
                  >
                    {isShotStrategy
                      ? eligibleArmedClub ? `${eligibleArmedClub} PLAYER SELECTION` : 'CHOOSE ACTUAL CLUB BELOW'
                      : eligibleArmedClub && eligibleArmedClub === displayedClub
                        ? `${displayedClub} ARMED FOR NEXT SHOT`
                        : displayedClub
                          ? `HITTING ${displayedClub} · TAP TO ARM`
                          : evaluationPending
                            ? 'CALCULATING RECOMMENDATION…'
                            : 'WAITING FOR RECOMMENDATION'}
                  </button>
                </article>

                {!isShotStrategy ? <article className="live-outcomes-card">
                  <div className="live-section-heading">
                    <div>
                      <span className="live-kicker">OUTCOMES</span>
                      <h2>What this line buys you</h2>
                    </div>
                    {risk ? <small>full-risk distribution</small> : null}
                  </div>
                  <div className="live-outcome-grid">
                    <div className="outcome-success"><strong>{pct(risk?.success)}</strong><span>Success</span></div>
                    <div className="outcome-manageable"><strong>{pct(risk?.manageable)}</strong><span>Manageable</span></div>
                    <div className="outcome-trouble"><strong>{pct(playerFacingTrouble)}</strong><span>Trouble</span></div>
                    <div className="outcome-catastrophe"><strong>{pct(risk?.catastrophe)}</strong><span>Catastrophe</span></div>
                  </div>
                  {outcomeDetails.length ? (
                    <div className="live-outcome-details">
                      {outcomeDetails.map(([label, value]) => <span key={label}>{label} {pct(value)}</span>)}
                    </div>
                  ) : <div className="live-outcome-details"><span>No material bunker / woods / outside map area / penalty probability in the current model.</span></div>}
                </article> : null}
              </aside>

              <article className="live-map-card">
                <div className="live-map-topbar">
                  <div>
                    <span className="live-kicker">SHOT MAP</span>
                    <h2>{isShotStrategy
                      ? `Shot strategy · ${playerFacingAim}`
                      : displayedClub
                        ? `${displayedClub} · ${viewedEvaluation ? playerFacingAim : 'no modeled line'}`
                      : evaluationPending
                        ? 'Calculating recommendation…'
                        : 'Waiting for recommendation'}</h2>
                  </div>
                  {!isShotStrategy ? <div className="live-map-toggles">
                    <button type="button" className="always-on">50 / 80%</button>
                    <button type="button" className={show95 ? 'active' : ''} onClick={() => setShow95((value) => !value)}>95%</button>
                    <button type="button" className={showPracticeShots ? 'active' : ''} onClick={() => setShowPracticeShots((value) => !value)}>
                      Practice shots{viewedEvaluation ? ` · ${viewedEvaluation.empiricalShotCount}` : ''}
                    </button>
                    <button type="button" className={showRiskTail ? 'active' : ''} onClick={() => setShowRiskTail((value) => !value)}>Risk tail</button>
                  </div> : <span className="live-strategy-map-label">TACTICAL TARGET</span>}
                </div>

                <LiveCaddieMap
                  hole={hole}
                  ball={ball}
                  target={isShotStrategy && shotStrategy ? shotStrategy.target : target}
                  pinEstimate={pinEstimate}
                  candidate={isShotStrategy ? null : inspectedCandidate}
                  strategyAimPoint={isShotStrategy ? shotStrategy?.target ?? null : null}
                  show95={show95}
                  showRiskTail={showRiskTail}
                  showPracticeShots={showPracticeShots}
                  provisionalTeeRadiusYds={provisionalPositionRadiusYds ?? provisionalTeeRadiusYds}
                  greenRead={shownGreenRead}
                />

                <div className="live-map-legend">
                  <span><i className="ball" />Ball</span>
                  <span><i className="aim" />{isShotStrategy ? 'Strategy target' : 'Aim'}</span>
                  {!isShotStrategy ? <span><i className="mean" />Expected finish</span> : null}
                  <span><i className="pin" />Pin</span>
                  <span><b className="yardage">123</b>Yards to reach hazard</span>
                  {!isShotStrategy ? <span><i className="core" />Core dispersion</span> : null}
                  {!isShotStrategy && showPracticeShots ? <span><i className="practice" />Your observed shots</span> : null}
                </div>
                <NativeAimPreview
                  courseId={courseId}
                  courseKey={liveSnapshot?.courseKey ?? null}
                  holeNumber={holeNumber}
                  ball={liveMatchesHole ? ball : null}
                  pin={trustedLivePin ?? null}
                  target={isShotStrategy ? shotStrategy?.target ?? null : inspectedCandidate?.aimPoint ?? null}
                  companionReady={companionStatus?.gspro.status === 'connected'}
                />
              </article>
            </section>

            {!isShotStrategy ? <LiveDecisionDetails
              evaluations={evaluations}
              viewedEvaluation={viewedEvaluation}
              inspectedCandidate={inspectedCandidate}
              ball={ball}
              target={target}
              onInspectAim={(aimOffsetYds) => setInspectedAimOffset(aimOffsetYds)}
            /> : null}

            <section className="live-club-strip-card">
              <div className="live-club-strip-heading">
                <div>
                  <span className="live-kicker">ACTUAL CLUB</span>
                  <strong>{eligibleArmedClub ? `${eligibleArmedClub} armed for the next physical shot` : 'Tap the club you are actually hitting'}</strong>
                </div>
                {eligibleArmedClub ? <button type="button" onClick={() => setArmedClub(null)}>Clear</button> : null}
              </div>
              <div className="live-club-strip">
                {bagClubs.map((club) => {
                  const eligible = clubEligibleForShot(club, shotOrigin)
                  const clubEvaluation = evaluations.find((evaluation) => evaluation.club === club) ?? null
                  return (
                    <button
                      type="button"
                      key={club}
                      disabled={!eligible}
                      title={!eligible ? 'Tee-only club: excluded from all non-tee recommendations' : undefined}
                      className={`${!eligible ? 'ineligible ' : ''}${eligibleArmedClub === club ? 'armed ' : ''}${!isShotStrategy && recommendation?.club === club ? 'recommended' : ''}`}
                      onClick={() => { if (eligible) setArmedClub(club) }}
                    >
                      <strong>{club}</strong>
                      {!eligible
                        ? <span>TEE ONLY</span>
                        : recommendation?.club === club
                          ? <span>REC</span>
                         : eligibleArmedClub === club
                          ? <span>{isShotStrategy ? 'PLAYER CHOICE' : clubEvaluation?.decisionRank ? `#${clubEvaluation.decisionRank} CLUB` : 'ARMED'}</span>
                          : null}
                    </button>
                  )
                })}
              </div>
              <p>{isShotStrategy
                ? 'Looper is not choosing a club at this distance. Selecting a club records what you intend to hit without assigning it full-shot dispersion or outcome probabilities.'
                : "Selecting a club arms it for the next GSPro shot and switches the screen to that club's best modeled line. REC remains Looper's preferred club."}</p>
            </section>
          </>
        )}
      </div>
    </main>
  )
}
