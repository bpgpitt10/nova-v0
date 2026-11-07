import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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
import { connectToGsproWindObservation, requestGsproWindRefresh } from '../adapters/gsproWindObservation'
import looperLogoWhite from '../assets/LooperLogo.webp'
import {
  courseUsesGsproHoles,
  getCourseCatalogEntry,
  resolveCourseIdFromGsproName,
  UNSELECTED_COURSE_ID,
  type CourseId,
} from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import { gkdHazardSurfaces, layoutWithHazards, withGkdHazards, type GkdHazardSummary } from '../courseGeometry/nativeHazards'
import { anchorGreenToGkd, greenAnchorLine, greenShareOutsideDetail, type GreenAnchorSummary } from '../courseGeometry/nativeGreenAnchor'
import {
  loadCourseGreenDetail, sampleCourseGreenElevation, type CourseGreenDetail,
} from '../courseGeometry/courseGreenDetail'
import { buildCourseGreenApproachTarget } from '../liveCaddie/greenTargeting'
import { analyzeGreen, greenReadLine } from '../liveCaddie/greenRead'
import { buildUnderRangeShotStrategy } from '../liveCaddie/shotStrategy'
import { pureFinishRead } from '../liveCaddie/pureFinishRead'
import { estimateProvisionalTee, readTeeBallPinDistanceYds } from '../courseGeometry/provisionalTeeEstimate'
import { refineTeeDistanceWithLayout } from '../adapters/gsproRoundLayoutDistance'
import { aimInGspro, type AimInGsproResult } from '../liveCaddie/gsproAimClick'
import { registrationForHole } from '../courseGeometry/nativeRegistration'
import { pinFromHudDistance } from '../liveCaddie/hudPin'
import { estimatedPinAim, type EstimatedPinAim } from '../liveCaddie/pinUncertainty'
import { rerankClubs } from '../liveCaddie/clubRerank'
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
  COURSE_SELECTION_UPDATED_EVENT,
  loadLastSelectedCourseId,
  saveLastSelectedCourseId,
} from '../courseGeometry/courseSelection'
import { classifyPoint, fairwayCorridorAtForwardY } from '../courseGeometry/geometry'
import { estimateGreywolfTerrain as estimateCourseTerrain } from '../courseGeometry/lidar'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurface,
} from '../courseGeometry/types'
import { isNativePositionsEnabled, nativeCourseContextForLive } from '../courseGeometry/nativeCourseRuntime'
import {
  buildAimContextSentence,
  buildAimDescriptor,
} from '../liveCaddie/aimDescriptor'
import { describeMathPick, describeSafeAlternative, pickSafeAlternative } from '../liveCaddie/safeAlternative'
import type { ClubAimEvaluation } from '../liveCaddie/aimOptimization'
import {
  loadCourseHoleHeadingDegreesTrue,
  localShotBearingDegrees,
  shotCompassBearingDegrees,
} from '../liveState/courseHeading'
import type { GsproLieObservation, WindObservation } from '../liveState/types'
import { projectWindObservation, windInTrueCompass } from '../liveState/windProjection'
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
import ScreenOnlyCaddie from '../components/ScreenOnlyCaddie'
import { serializeDecisionOptions } from '../liveCaddie/decisionOptions'
import { useQuickBagPrior } from '../lib/useQuickBag'
import { startingBagClubs } from '../liveCaddie/quickBagProfiles'
import { BLEND_RULES } from '../lib/quickBag'
import NativePositionsBetaPanel from '../components/NativePositionsBetaPanel'
import LiveCaddieMap from '../components/LiveCaddieMap'
import LiveDecisionDetails from './LiveDecisionDetails'
import './LiveCaddiePage.css'
import { outcomeTiles } from '../liveCaddie/outcomeShares'
import { aimClickPoint } from '../liveCaddie/aimClickPoint'
import { reconcilePinWithHud } from '../liveCaddie/pinReconcile'

const AIM_WIDTH_FACT = /^(Fairway|Green) width: /

const OUTCOME_PLACEHOLDER = ['Success', 'Manageable', 'Trouble', 'Catastrophe']
  .map((label) => ({ label, percent: 0, text: '—' }))


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

// Last GSPro player-box Shot 1 distance per course|hole|round.
const lastHudShotOneYds = new Map<string, number>()

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
  // The course is chosen in Round Setup (display only here); this page stays
  // mounted, so it follows Round Setup's selection event.
  const [courseId, setCourseId] = useState<CourseId>(() => loadLastSelectedCourseId())
  const [holeNumber, setHoleNumber] = useState(1)
  const [greenDetail, setGreenDetail] = useState<CourseGreenDetail | null>(null)
  const [rawHole, setHole] = useState<CourseHoleGeometry | null>(null)
  // GSPro's own penalty areas and OB, and the green anchored to GSPro's green
  // (both from the player's GKD through the registration), on this hole.
  const [gkdOverlay, setGkdOverlay] = useState<{
    key: string
    /** The hole object the overlay was computed for: a reloaded hole gets a new overlay. */
    source: CourseHoleGeometry
    hazardSurfaces: CourseSurface[]
    hazardSummary: GkdHazardSummary
    anchoredSurfaces: CourseSurface[] | null
    anchoredGreen: CoursePolygonYds | null
    greenSummary: GreenAnchorSummary
    /** How GSPro's scene is turned/mirrored against true north on this hole (wind). */
    sceneRotationDeg: number
    sceneMirrored: boolean
  } | null>(null)
  const gkdHazards = gkdOverlay
    ? { key: gkdOverlay.key, surfaces: gkdOverlay.hazardSurfaces, summary: gkdOverlay.hazardSummary }
    : null
  const hole = useMemo<CourseHoleGeometry | null>(() => {
    if (!rawHole || !gkdOverlay || gkdOverlay.source !== rawHole) return rawHole
    const base = gkdOverlay.anchoredSurfaces ? { ...rawHole, surfaces: gkdOverlay.anchoredSurfaces } : rawHole
    return withGkdHazards(base, gkdOverlay.hazardSurfaces)
  }, [rawHole, gkdOverlay])
  const [ball, setBall] = useState<CoursePointYds>([0, 0])
  const [target, setTarget] = useState<CoursePointYds>([0, 220])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [evaluationError, setEvaluationError] = useState<string | null>(null)
  const [evaluationPending, setEvaluationPending] = useState(false)
  const [evaluations, setEvaluations] = useState<ClubAimEvaluation[]>([])
  // The player's Quick Bag (handicap + three carries), laid under the range data.
  const quickBagPrior = useQuickBagPrior()
  const [livePrepared, setLivePrepared] = useState(false)
  const [liveStatus, setLiveStatus] = useState<BrowserGsproCourseStatus>('idle')
  const [liveSnapshot, setLiveSnapshot] = useState<BrowserGsproCourseSnapshot | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [connectionVersion, setConnectionVersion] = useState(0)
  const [windObservation, setWindObservation] = useState<WindObservation | null>(null)
  const [windRefreshing, setWindRefreshing] = useState(false)
  // "Refresh wind": GSPro's gusty wind swirls between shots (Brian, 11/4).
  const refreshWind = () => {
    if (windRefreshing) return
    setWindRefreshing(true)
    void readLooperCompanionObservations(45000)
      .then((obs) => {
        const wind = obs.status === 'ready' && obs.gspro?.status === 'connected' ? obs.ocr?.wind : null
        if (wind?.status === 'READY' && Number.isFinite(wind.speedMph) && Number.isFinite(wind.directionDegrees)) {
          requestGsproWindRefresh(wind)
        }
      })
      .catch((error: unknown) => console.warn('[Live Caddie] Wind refresh failed.', error))
      .finally(() => setWindRefreshing(false))
  }
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
  // Clicking a club only previews it; Arm commits (fills, then aims in GSPro).
  const [previewClub, setPreviewClub] = useState<string | null>(null)
  const [armPhase, setArmPhase] = useState<'idle' | 'filling' | 'aiming' | 'armed'>('idle')
  const [aimResult, setAimResult] = useState<AimInGsproResult | null>(null)
  const [armedAimKey, setArmedAimKey] = useState<string | null>(null)
  const armTimerRef = useRef<number | null>(null)
  const armRunRef = useRef(0)
  const resetArm = () => {
    if (armTimerRef.current != null) window.clearTimeout(armTimerRef.current)
    armTimerRef.current = null
    armRunRef.current += 1 // drop any aim result still in flight
    setPreviewClub(null)
    setArmPhase('idle')
    setAimResult(null)
    setArmedAimKey(null)
  }
  const lastShotKeyRef = useRef<string | null>(null)
  const visualCaptureRef = useRef<BrowserGsproVisualCaptureConnection | null>(null)

  const selectedCourse = courseId === UNSELECTED_COURSE_ID ? null : getCourseCatalogEntry(courseId)
  // Holes from GSPro's course file (GSPro-only or a map area): ground the map
  // doesn't cover is unmapped, not trouble.
  const gsproOnlyCourse = selectedCourse?.source === 'gspro-only' || selectedCourse?.packageKind === 'area'

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
      resetArm()
    }
    window.addEventListener(LIVE_CADDIE_START_ROUND_EVENT, onStartRound)
    return () => window.removeEventListener(LIVE_CADDIE_START_ROUND_EVENT, onStartRound)
  }, [])

  const courseIdRef = useRef(courseId)
  courseIdRef.current = courseId
  useEffect(() => {
    const onCourseSelected = (event: Event) => {
      const next = (event as CustomEvent<{ courseId?: CourseId }>).detail?.courseId ?? loadLastSelectedCourseId()
      if (next === courseIdRef.current) return
      setCourseId(next)
      setHoleNumber(1)
      setLiveSnapshot(null)
      setNativeObservations(null)
      setArmedClub(null)
      resetArm()
      lastShotKeyRef.current = null
    }
    window.addEventListener(COURSE_SELECTION_UPDATED_EVENT, onCourseSelected)
    return () => window.removeEventListener(COURSE_SELECTION_UPDATED_EVENT, onCourseSelected)
  // resetArm only touches refs and setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
            resetArm()
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

    setHole(null)

    void loadCourseHoleGeometry(courseId, holeNumber)
      .then((loaded) => {
        if (!active) return
        setHole(loaded)
        setBall(loaded.markers.tee)
        setTarget(defaultTarget(loaded))
      })
      .catch((error) => {
        if (!active) return
        setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      active = false
    }
  }, [courseId, holeNumber, captureRoundId])

  // GSPro's penalty areas and OB for this hole, through the course registration.
  // Keyed by course|hole; the GSPro key arrives with the live round, so the
  // effect also re-runs once it's known.
  const gkdCourseKey = liveSnapshot?.courseKey ?? null
  useEffect(() => {
    if (!rawHole || !(isNativePositionsEnabled() || courseUsesGsproHoles(courseId))) {
      setGkdOverlay(null)
      return
    }
    const key = `${rawHole.courseId}|${rawHole.holeNumber}`
    let alive = true
    void nativeCourseContextForLive(courseId, gkdCourseKey)
      .then((context) => {
        if (!alive) return
        if (!context) {
          setGkdOverlay(null)
          return
        }
        // Greens and pins are shared by every layout of the scene: use the active one.
        // Anchor the green first, so island-green cut-outs follow GSPro's green.
        const anchor = anchorGreenToGkd(rawHole, context.layout, context.registration)
        const anchoredHole = anchor.surfaces ? { ...rawHole, surfaces: anchor.surfaces } : rawHole
        const layout = layoutWithHazards(context.layouts.map((l) => l.layout))
        const hazards = layout
          ? gkdHazardSurfaces(layout, context.registration, anchoredHole)
          : { surfaces: [], summary: { penaltyAreas: 0, innerOob: 0, obMode: null, obOnHole: false } }
        const placed = registrationForHole(context.registration, rawHole.holeNumber)
        setGkdOverlay({
          key,
          source: rawHole,
          sceneRotationDeg: placed.rotationDeg ?? 0,
          sceneMirrored: placed.mirrored === true,
          hazardSurfaces: hazards.surfaces,
          hazardSummary: hazards.summary,
          anchoredSurfaces: anchor.surfaces,
          anchoredGreen: anchor.green,
          greenSummary: anchor.summary,
        })
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [rawHole, courseId, gkdCourseKey])

  // Preserve production's detailed green terrain loading and exact-pin
  // approach targeting; do not assert exact targeting from provisional frames.
  useEffect(() => {
    let active = true
    setGreenDetail(null)
    // GSPro-only and map-area courses have no packaged green slopes.
    if (!selectedCourse || selectedCourse.source === 'gspro-only' || selectedCourse.packageKind === 'area') {
      return () => { active = false }
    }
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
    const rulerDistance = readTeeBallPinDistanceYds({
      ballPixel: mini.ballPixel, pinPixel: mini.pinPixel,
      yardsPerPixel: mini.scale?.yardsPerPixel,
      waypointCount: mini.scale?.waypointCount,
      scaleStatus: mini.scale?.status, markerStatus: mini.status,
    })
    // GSPro's own player box ("Shot 1  492.6 YDS") is exact; the ruler is
    // pixel-measured (FarmLinks H1: 497 vs 492.6).
    const hud = nativeObservations.ocr?.hud
    const hudYds = hud?.status === 'READY' && hud.shotNumber === 1 && hud.distanceToPinYds != null
      && hud.distanceToPinYds > 45 ? hud.distanceToPinYds : null
    if (rulerDistance == null && hudYds == null) return null
    const distance = hudYds ?? refineTeeDistanceWithLayout(
      rulerDistance!, liveSnapshot.gsproLayoutTee, hole.holeNumber, hole.par,
    ).distanceYds
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

  const liveMatchesHole = Boolean(liveSnapshot?.holeNumber === holeNumber)
  const provisionalTeeRadiusYds = liveMatchesHole && liveSnapshot?.teePlacement === 'provisional'
    && liveSnapshot.nextShotNumber === 1
    ? measuredPreShotTee?.uncertaintyYds ?? liveSnapshot.teeUncertaintyYds ?? 50
    : null
  const effectiveDistanceToPinYds = liveMatchesHole
    ? firstTeeDisplay.distanceToPinYds
    : null
  // GSPro's own "Shot 1  492.6 YDS" before the first shot (companion HUD read).
  const hudReading = nativeObservations?.ocr?.hud?.status === 'READY'
    && Math.abs(Date.now() - Date.parse(nativeObservations.observedAt ?? '')) < 30_000
    ? nativeObservations.ocr.hud : null
  const freshHudShotOneYds = liveMatchesHole && liveSnapshot?.nextShotNumber === 1
    && hudReading?.shotNumber === 1 && hudReading.distanceToPinYds != null
    ? hudReading.distanceToPinYds : null
  // Keep the last reading for this tee: the player box can drop out of a
  // screenshot for a moment, and the pin must not flip back and forth.
  const hudTeeKey = liveMatchesHole && liveSnapshot?.nextShotNumber === 1
    ? `${courseId}|${holeNumber}|${liveSnapshot.roundId ?? 'round'}` : null
  if (hudTeeKey && freshHudShotOneYds != null) lastHudShotOneYds.set(hudTeeKey, freshHudShotOneYds)
  const hudShotOneYds = freshHudShotOneYds ?? (hudTeeKey ? lastHudShotOneYds.get(hudTeeKey) ?? null : null)
  const hudPinKey = liveMatchesHole && liveSnapshot?.ballSource === 'native-gkd'
    && liveSnapshot.ballLocalYds && hudShotOneYds != null
    ? `${courseId}|${holeNumber}|${liveSnapshot.roundId ?? 'round'}|${hudShotOneYds}` : null
  const [hudPin, setHudPin] = useState<{
    key: string; pinLocal: CoursePointYds | null; note: string; aimPointsLocal: readonly CoursePointYds[]
    candidatesLocal: readonly CoursePointYds[]
  } | null>(null)
  useEffect(() => {
    if (!hudPinKey || hudPin?.key === hudPinKey || !liveSnapshot?.ballLocalYds || hudShotOneYds == null) return
    let alive = true
    void pinFromHudDistance({
      courseId, courseKey: liveSnapshot.courseKey ?? null, holeNumber,
      roundId: liveSnapshot.roundId ?? null, teeLocal: liveSnapshot.ballLocalYds, distanceYds: hudShotOneYds,
    }).then((found) => {
      if (alive) {
        setHudPin({
          key: hudPinKey,
          pinLocal: found?.pinLocal ?? null,
          note: found?.note ?? 'native course not ready',
          aimPointsLocal: found?.aimPointsLocal ?? [],
          candidatesLocal: found?.candidatesLocal ?? [],
        })
      }
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hudPinKey])
  // Before Shot 1 GSPro's player box is the truth about the pin in play: a
  // pin that disagrees with it (RNK 3: 15 yd deep) is replaced.
  const snapshotExactPin = liveMatchesHole && liveSnapshot && liveSnapshot.pinSource !== 'unavailable'
    ? liveSnapshot.pinLocalYds ?? null : null
  const pinCheck = reconcilePinWithHud({
    snapshotPin: snapshotExactPin,
    // Only against an exact ball: a provisional tee can be yards off itself.
    ball: liveSnapshot?.ballSource === 'native-gkd' ? liveSnapshot.ballLocalYds ?? null : null,
    hudYds: hudShotOneYds,
    hudPin: hudPin && hudPin.key === hudPinKey ? hudPin.pinLocal : null,
    aimPoints: hudPin && hudPin.key === hudPinKey ? hudPin.aimPointsLocal : [],
    hudLookupDone: Boolean(hudPin && hudPin.key === hudPinKey),
  })
  const resolvedPinX = pinCheck.pin?.[0] ?? null
  const resolvedPinY = pinCheck.pin?.[1] ?? null
  const resolvedExactPin = useMemo<CoursePointYds | null>(() =>
    resolvedPinX != null && resolvedPinY != null ? [resolvedPinX, resolvedPinY] : null,
  [resolvedPinX, resolvedPinY])
  useEffect(() => {
    if (!hole || !liveSnapshot || liveSnapshot.holeNumber !== hole.holeNumber) return
    // Keep browser GSPro authoritative on hole/shot identity, but give the
    // bounded *fresh native measurement* priority over the initial approximate
    // tee marker on shot 1 only. After shot 1, actual ending coordinates win.
    const nextBall = firstTeeDisplay.ball
      ?? (liveSnapshot.ballSource === 'cached-tee' ? hole.markers.tee : null)
    if (!nextBall) return
    // Exact pins: GSPro output_log layout, or the GKD pin slot (native beta).
    const exactPin = resolvedExactPin
    const nextPin = exactPin ?? estimatePinFromGsproDistance(
      hole, nextBall, hudShotOneYds ?? firstTeeDisplay.distanceToPinYds,
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
    greenDetail, resolvedExactPin, hudShotOneYds,
  ])

  const trustedLivePin = resolvedExactPin
  const pinEstimate = hole
    ? trustedLivePin ?? estimatePinFromGsproDistance(hole, ball, hudShotOneYds ?? effectiveDistanceToPinYds)
    : null
  // Clubs that can't reach the green plan around the fairway centre at their
  // own carry toward this pin (the engine decides per club).
  const layupPinX = pinEstimate?.[0] ?? null
  const layupPinY = pinEstimate?.[1] ?? null
  const layupPin = useMemo<CoursePointYds | null>(() =>
    layupPinX != null && layupPinY != null ? [layupPinX, layupPinY] : null,
  [layupPinX, layupPinY, ball])
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
      : ballTerrain.source === 'gspro-heights'
        ? "GSPro course-file heights (coarse)"
        : ballTerrain.source === 'global-dem'
          ? "30 m global terrain fitted to GSPro's heights (coarse)"
          : `${selectedCourse?.name ?? 'Course'} terrain proxy`
    : 'No terrain model'
  const airAltitudeFt = ballTerrain?.elevationFt ?? null
  const airAltitudeSource = ballTerrain
    ? ballTerrain.source === 'lidar-dem'
      ? `${selectedCourse?.name ?? 'Course'} direct LiDAR DEM`
      : ballTerrain.source === 'gspro-heights'
        ? `GSPro course altitude${selectedCourse?.altitudeFt != null ? '' : ' unknown (sea level)'}`
        : ballTerrain.source === 'global-dem'
          ? `${selectedCourse?.name ?? 'Course'} 30 m global terrain`
          : `${selectedCourse?.name ?? 'Course'} terrain proxy`
    : 'No absolute terrain elevation'
  const surfaceOverride = confirmedCurrentLie ?? liveLieSurface
    ?? (liveMatchesHole ? liveSnapshot?.surface ?? null : null)
  const localAimBearingDeg = localShotBearingDegrees(ball, target)
  const currentShotCompassBearingDeg = shotCompassBearingDegrees(
    holeHeadingDegreesTrue,
    localAimBearingDeg,
  )
  // GSPro's wind compass is the scene's: turn it by the course match for the
  // hole on screen. Not the live snapshot's turn: a tee reached by conceding
  // the last hole has no GSPro shot yet, so it had none and the wind came out
  // 180 degrees wrong on Kiawah (scene turned 179 deg; 11/4 holes 6 and 7).
  const sceneTurn = gkdOverlay && gkdOverlay.source === rawHole
    ? { rotationDeg: gkdOverlay.sceneRotationDeg, mirrored: gkdOverlay.sceneMirrored }
    : liveMatchesHole && liveSnapshot?.gsproSceneRotationDeg != null
      ? { rotationDeg: liveSnapshot.gsproSceneRotationDeg, mirrored: liveSnapshot.gsproSceneMirrored === true }
      : null
  const projectedWind = projectWindObservation(
    windInTrueCompass(windObservation, sceneTurn?.rotationDeg ?? null, sceneTurn?.mirrored === true),
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
      resetArm()
      setInspectedAimOffset(null)
    }
  }, [isGreenSurface])

  // Wind and lie arrive a few seconds after a shot becomes current (companion
  // HUD read). Calculating before then produced a calm/flat recommendation that
  // was replaced moments later. Hold the first calculation for each shot until
  // both are read, or CONDITIONS_WAIT_MS passes (then go without them).
  const CONDITIONS_WAIT_MS = 12_000
  const shotConditionsKey = liveMatchesHole
    ? `${captureRoundId ?? 'round'}|${courseId}|${holeNumber}|${nextShotNumber ?? '?'}|${liveSnapshot?.latestShotKey ?? 'start'}`
    : null
  const [conditionsWait, setConditionsWait] = useState<{ key: string; expired: boolean } | null>(null)
  useEffect(() => {
    if (!shotConditionsKey) return
    setConditionsWait({ key: shotConditionsKey, expired: false })
    const timer = window.setTimeout(
      () => setConditionsWait({ key: shotConditionsKey, expired: true }), CONDITIONS_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [shotConditionsKey])
  const companionReadsConditions = Boolean(companionStatus?.capabilities?.liveObservations)
    && companionStatus?.gspro.status === 'connected'
  const waitingForConditions = companionReadsConditions
    && shotConditionsKey != null
    && !(conditionsWait?.key === shotConditionsKey && conditionsWait.expired)
    && !(hasLiveWind && hasLiveLie)

  const needsWaypointsRef = useRef(true)
  needsWaypointsRef.current = !liveSnapshot
    || (liveSnapshot.teePlacement === 'provisional' && liveSnapshot.nextShotNumber === 1)

  // A new shot: read GSPro now (not at the next 16 s poll), and again every
  // 3 s while wind or lie is still missing.
  useEffect(() => {
    if (!shotConditionsKey) return
    const first = window.setTimeout(() => nativeVisualRef.current?.refreshNow(), 800)
    return () => window.clearTimeout(first)
  }, [shotConditionsKey])
  useEffect(() => {
    if (!waitingForConditions) return
    const retry = window.setInterval(() => nativeVisualRef.current?.refreshNow(), 3000)
    return () => window.clearInterval(retry)
  }, [waitingForConditions, shotConditionsKey])

  // How long each step took for this shot (shown under Details).
  const shotTimingRef = useRef<{ key: string | null; shotAt: number; conditionsAt: number | null; recStartAt: number | null; recorded: boolean }>(
    { key: null, shotAt: 0, conditionsAt: null, recStartAt: null, recorded: false })
  const [recTiming, setRecTiming] = useState<{ conditionsMs: number | null; recMs: number; totalMs: number; workers: number } | null>(null)
  if (shotConditionsKey && shotTimingRef.current.key !== shotConditionsKey) {
    shotTimingRef.current = { key: shotConditionsKey, shotAt: performance.now(), conditionsAt: null, recStartAt: null, recorded: false }
  }
  if (shotConditionsKey && !waitingForConditions && shotTimingRef.current.conditionsAt == null) {
    shotTimingRef.current.conditionsAt = performance.now()
  }

  useEffect(() => {
    if (!hole || isGreenSurface || spatialPositionUnavailable || holdFirstTeeRecommendation) {
      setEvaluations([])
      setEvaluationError(null)
      setEvaluationPending(false)
      return
    }
    if (waitingForConditions) {
      setEvaluations([])
      setEvaluationError(null)
      setEvaluationPending(true)
      return
    }

    let cancelled = false
    const recStartAt = performance.now()
    shotTimingRef.current.recStartAt = recStartAt
    setEvaluations([])
    setEvaluationError(null)
    setEvaluationPending(true)

    // Each club's evaluation is independent, so the bag is split across a few
    // workers (one per spare core, up to 4) and ranked once here. Same result
    // as one worker, a fraction of the wait (5.9 s single-threaded on the sim).
    const clubIds = Array.from(new Set([
      ...sessions.flatMap((session) => session.shots.map((shot) => shot.club)),
      // Quick Bag clubs have numbers without range shots; they need a worker too.
      ...startingBagClubs(quickBagPrior),
    ]))
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2
    const parallelism = Math.max(1, Math.min(4, cores - 1, clubIds.length))
    const groups: (string[] | undefined)[] = parallelism > 1
      ? Array.from({ length: parallelism }, (_, g) => clubIds.filter((_, i) => i % parallelism === g))
      : [undefined]
    const workers = groups.map(() => new Worker(new URL('./LiveCaddieWorker.ts', import.meta.url), {
      type: 'module',
    }))
    const parts: ClubAimEvaluation[][] = []
    let remaining = groups.length
    const stopAll = () => workers.forEach((worker) => worker.terminate())
    const fail = (error: string) => {
      if (cancelled) return
      cancelled = true
      stopAll()
      setEvaluations([])
      setEvaluationError(error)
      setEvaluationPending(false)
    }
    const finish = (evaluations: ClubAimEvaluation[]) => {
      setEvaluations(evaluations)
      setEvaluationError(null)
      const done = performance.now()
      const t = shotTimingRef.current
      // The first recommendation for a shot is the one that matters; later
      // recalculations (another aim inspected) don't reset the clock.
      if (!t.recorded) setRecTiming({
        conditionsMs: t.conditionsAt != null ? t.conditionsAt - t.shotAt : null,
        recMs: done - recStartAt,
        totalMs: done - t.shotAt,
        workers: groups.length,
      })
      t.recorded = true
      setEvaluationPending(false)
    }
    const request = {
      learnedSurfaceFactors: learnedSurfaceFactors(),
      sessions,
      hole,
      ball,
      target,
      environment: {
        quickBag: quickBagPrior,
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
        layupPin,
        greenDetail: trustedLivePin && liveSnapshot?.ballSource !== 'world-provisional'
          ? greenDetail : null,
      },
      nowMs: Date.now(),
    }
    workers.forEach((worker, index) => {
      worker.onmessage = (event: MessageEvent<LiveCaddieWorkerMessage>) => {
        if (cancelled) return
        const message = event.data
        worker.terminate()
        if (message.type !== 'success') { fail(message.error); return }
        parts[index] = message.evaluations
        remaining -= 1
        if (remaining > 0) return
        finish(groups[0] ? rerankClubs(parts.flat()) : parts[0])
      }
      worker.onerror = (event) => fail(event.message || 'Live Caddie decision worker failed.')
      worker.postMessage({ ...request, onlyClubs: groups[index] })
    })

    return () => {
      cancelled = true
      stopAll()
    }
  }, [
    sessions,
    hole,
    ball,
    target,
    isGreenSurface,
    spatialPositionUnavailable,
    holdFirstTeeRecommendation,
    waitingForConditions,
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
    trustedLivePin, greenDetail, layupPin, quickBagPrior,
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
  // Caddie vs you: what the engine saw for its pick and the alternatives, kept
  // with the Arm so Rounds can price a club change in strokes, not just name it.
  const decisionOptionsJson = useMemo(
    () => (isShotStrategy ? null : serializeDecisionOptions(evaluations, previewClub)),
    [evaluations, previewClub, isShotStrategy],
  )
  // A user-selected club is metadata in Partial Shot Strategy, never a
  // modeled partial-flight recommendation; tee-only clubs remain prohibited.
  const eligibleArmedClub = armedClub && clubEligibleForShot(armedClub, shotOrigin)
    ? armedClub : null
  const eligiblePreviewClub = previewClub && clubEligibleForShot(previewClub, shotOrigin)
    ? previewClub : null
  const chosenClub = eligibleArmedClub ?? eligiblePreviewClub
  const viewedEvaluation = isShotStrategy
    ? shotStrategy?.referenceEvaluation ?? null
    : chosenClub
      ? evaluations.find((evaluation) => evaluation.club === chosenClub) ?? null
      : recommendation
  const viewedBestCandidate = viewedEvaluation?.bestCandidate ?? null
  const inspectedCandidate = !isShotStrategy && viewedEvaluation
    ? viewedEvaluation.candidates.find((candidate) => candidate.aimOffsetYds === inspectedAimOffset)
      ?? viewedBestCandidate
      ?? null
    : null
  const risk = isShotStrategy ? null : inspectedCandidate?.riskProfile ?? null
  // The safe play: shown under the arm button only when the math pick carries
  // real risk and a safer club or line costs little (display only; the
  // headline is unchanged). Tapping it switches the card to that pick.
  const safePick = useMemo(() => (isShotStrategy || evaluations.length === 0 ? null : pickSafeAlternative(evaluations)), [evaluations, isShotStrategy])
  const safePickChosen = safePick != null && viewedEvaluation?.club === safePick.club
    && inspectedCandidate?.aimOffsetYds === safePick.candidate.aimOffsetYds
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
  // An anchored green that sits partly outside the packaged slope grid gets a
  // partial read: say so rather than present it as the whole green.
  const anchoredGreenOutside = useMemo(() => {
    if (!hole || !greenDetail || gkdOverlay?.greenSummary.status !== 'anchored') return null
    if (gkdOverlay.source !== rawHole) return null
    const { minX, minY, spacingYds, width, height } = greenDetail.grid
    const ring = gkdOverlay.anchoredGreen
    return ring
      ? greenShareOutsideDetail(ring, [minX, minX + (width - 1) * spacingYds, minY, minY + (height - 1) * spacingYds])
      : null
  }, [hole, rawHole, greenDetail, gkdOverlay])
  const greenReadText = shownGreenRead && pinEstimate
    ? greenReadLine(shownGreenRead, ball, pinEstimate, Boolean(trustedLivePin))
      + (anchoredGreenOutside != null && anchoredGreenOutside > 0.15 ? ' (partial read: slope data covers part of the green)' : '')
    : null
  const displayedClub = isShotStrategy
    ? eligibleArmedClub
    : chosenClub ?? viewedEvaluation?.club ?? recommendation?.club ?? null
  const isAlternateClub = Boolean(
    !isShotStrategy && chosenClub && recommendation?.club
      && chosenClub !== recommendation.club,
  )
  const viewedClubRank = isShotStrategy ? null : viewedEvaluation?.decisionRank ?? null

  // ---- Arm: a half-second fill (let go of the mouse), then aim in GSPro ----
  const ARM_FILL_MS = 600
  const aimPin = trustedLivePin ?? (liveMatchesHole ? pinEstimate : null)
  // Yellow aim = GSPro click: on the aim line at the expected carry.
  const aimClick = !isShotStrategy && inspectedCandidate
    ? aimClickPoint(ball, inspectedCandidate.aimPoint, inspectedCandidate.meanCarryLanding, aimPin)
    : null
  const aimTarget = isShotStrategy ? shotStrategy?.target ?? null : aimClick
  // Before the first shot the pin is often only estimated. Auto Aim lines the
  // minimap up on ball and pin, so the pin's uncertainty moves the click in
  // proportion to target distance over pin distance: a lot on a par 3 (Kiawah
  // 3, 11/4: 178 yd for 188), a few yards off a par-4 tee. Click only when the
  // worst case stays within one aim step (3 yd); otherwise ask for a hand aim.
  // The pin is exact from the first shot on either way.
  const estimatedPinCheck: EstimatedPinAim | null = !trustedLivePin && hole && aimPin && aimTarget
    ? estimatedPinAim({
        hole, ball, pin: aimPin, target: aimTarget,
        pinSlotsLocal: hudPin && hudPin.key === hudPinKey ? hudPin.candidatesLocal : null,
        distanceKnown: (hudShotOneYds ?? effectiveDistanceToPinYds) != null,
      })
    : null
  const currentAimKey = displayedClub && aimTarget
    ? `${shotConditionsKey ?? 'shot'}|${displayedClub}|${aimTarget[0].toFixed(0)},${aimTarget[1].toFixed(0)}`
    : null
  const companionCanAim = Boolean(companionStatus?.capabilities?.aimClick)
    && companionStatus?.gspro.status === 'connected'
  const latestAimRef = useRef({
    club: displayedClub, aimKey: currentAimKey, ball, pin: aimPin, pinExact: trustedLivePin != null, target: aimTarget,
    estimatedPin: estimatedPinCheck,
    companionCanAim, companionConnected: companionStatus?.gspro.status === 'connected',
    courseId, courseKey: liveSnapshot?.courseKey ?? null, holeNumber, shotKey: shotConditionsKey,
  })
  latestAimRef.current = {
    club: displayedClub, aimKey: currentAimKey, ball, pin: aimPin, pinExact: trustedLivePin != null, target: aimTarget,
    estimatedPin: estimatedPinCheck,
    companionCanAim, companionConnected: companionStatus?.gspro.status === 'connected',
    courseId, courseKey: liveSnapshot?.courseKey ?? null, holeNumber, shotKey: shotConditionsKey,
  }
  const armedHere = armPhase === 'armed' && eligibleArmedClub != null && eligibleArmedClub === displayedClub
  const aimChanged = armedHere && aimResult?.outcome !== 'not-sent'
    && armedAimKey != null && currentAimKey != null && armedAimKey !== currentAimKey

  const pressArm = () => {
    if (isShotStrategy || !displayedClub) return
    if (armPhase === 'aiming') return
    if (armPhase === 'filling') {
      if (armTimerRef.current != null) window.clearTimeout(armTimerRef.current)
      armTimerRef.current = null
      armRunRef.current += 1
      setArmPhase(eligibleArmedClub ? 'armed' : 'idle')
      return
    }
    const run = ++armRunRef.current
    setArmPhase('filling')
    armTimerRef.current = window.setTimeout(() => {
      armTimerRef.current = null
      if (run !== armRunRef.current) return
      const snap = latestAimRef.current
      if (!snap.club) { setArmPhase('idle'); return }
      setArmedClub(snap.club)
      setPreviewClub(snap.club)
      setArmPhase('aiming')
      const finish = (result: AimInGsproResult) => {
        if (run !== armRunRef.current) return
        setAimResult(result)
        setArmedAimKey(snap.aimKey)
        setArmPhase('armed')
      }
      // Auto Aim lines GSPro's minimap up on the ball and the pin. A pin Looper
      // only estimated turns and shrinks the click; refuse when that could
      // move this click by more than one aim step.
      const estimated = snap.pinExact ? null : snap.estimatedPin
      if (!snap.pinExact && !estimated?.allowed) {
        const spread = estimated && Number.isFinite(estimated.errorYds) ? Math.ceil(estimated.errorYds) : null
        finish({
          outcome: 'not-sent',
          message: spread != null
            ? `Aim by hand: GSPro hasn't reported this pin yet (it does after your first shot), and an estimated pin could put this aim ${spread} yd off.`
            : "Aim by hand: GSPro hasn't reported this hole's pin yet (it does after your first shot).",
        })
        return
      }
      if (!snap.companionCanAim) {
        finish({
          outcome: 'not-sent',
          message: snap.companionConnected
            ? 'Aim by hand: update the Looper Companion so Looper can aim for you.'
            : 'Aim by hand: Looper Companion or GSPro not connected.',
        })
        return
      }
      void aimInGspro({
        courseId: snap.courseId, courseKey: snap.courseKey, holeNumber: snap.holeNumber,
        ball: snap.ball, pin: snap.pin, target: snap.target,
        shotKey: snap.shotKey ?? `${snap.courseId}|${snap.holeNumber}`,
      }).then((result) => finish(
        estimated && result.outcome !== 'not-sent'
          ? { ...result, message: `${result.message} Pin estimated until your first shot; this aim is good to about ${Math.max(1, Math.ceil(estimated.errorYds))} yd.` }
          : result,
      ))
    }, ARM_FILL_MS)
  }

  const pickClub = (club: string) => {
    if (isShotStrategy) { setArmedClub(club); return }
    setPreviewClub(club)
    if (eligibleArmedClub && eligibleArmedClub !== club) {
      if (armTimerRef.current != null) window.clearTimeout(armTimerRef.current)
      armTimerRef.current = null
      armRunRef.current += 1
      setArmedClub(null)
      setArmPhase('idle')
      setAimResult(null)
      setArmedAimKey(null)
    }
  }

  const aimShort = aimResult?.outcome === 'aimed' ? 'AIMED IN GSPRO'
    : aimResult?.outcome === 'clicked-unverified' ? 'AIM SENT TO GSPRO'
      : aimResult?.outcome === 'clicked-mismatch' ? 'CHECK AIM IN GSPRO'
        : 'AIM BY HAND'
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
  const safeAimText = safePick && hole
    ? buildAimDescriptor({
        hole, ball, target: safePick.evaluation.planningTarget, aimPoint: safePick.candidate.aimPoint,
        aimOffsetYds: safePick.candidate.aimOffsetYds, pin: pinEstimate,
      }).text
    : null
  const mathEvaluation = safePick ? evaluations.find((evaluation) => evaluation.club === safePick.math.club) ?? null : null
  const mathAimText = safePick && hole && mathEvaluation
    ? buildAimDescriptor({
        hole, ball, target: mathEvaluation.planningTarget, aimPoint: safePick.math.candidate.aimPoint,
        aimOffsetYds: safePick.math.candidate.aimOffsetYds, pin: pinEstimate,
      }).text
    : null
  // A short-game tactical point must NEVER be formatted as a native full-shot
  // aim command. Native aim remains read-only and has no shot-strategy intent.
  const nativeAimIntent = prepareReadOnlyNativeAimIntent({
    snapshot: liveMatchesHole ? liveSnapshot : null,
    courseId,
    holeNumber,
    club: isShotStrategy ? null : displayedClub,
    teeLocalYds: hole?.markers.tee ?? null,
    targetLocalYds: isShotStrategy ? null : aimClick,
  })
  const nativeAimPreview = !isShotStrategy && nativeVisualActive
    ? prepareReadOnlyNativeAimPreview(nativeAimIntent, nativeObservations)
    : null
  const playerFacingAim = isShotStrategy
    ? shotStrategy?.aimInstruction ?? 'target line'
    : aimDescriptor?.text
      ?? (viewedEvaluation ? aimLabel(inspectedCandidate?.aimOffsetYds) : 'No modeled line')
  // Header status sits on the account-chip row, just left of the chip.
  useEffect(() => {
    const chip = document.querySelector('.looper-account-control')
    if (!chip) return
    const apply = () => document.documentElement.style.setProperty(
      '--looper-account-w', `${Math.ceil(chip.getBoundingClientRect().width)}px`)
    apply()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    observer?.observe(chip)
    return () => observer?.disconnect()
  }, [])

  // "Fairway width: 26 yd" sits right under the aim line; any other fact
  // (hazard start) stays in the reason line below.
  const aimWidthFact = aimDescriptor && aimDescriptor.confidence !== 'low'
    ? aimDescriptor.contextFacts.find((fact) => AIM_WIDTH_FACT.test(fact)) ?? null
    : null
  const otherAimFacts = aimDescriptor?.contextFacts.filter((fact) => !AIM_WIDTH_FACT.test(fact)) ?? []
  const flushedRead = !isShotStrategy
    ? pureFinishRead({ club: displayedClub, pureFinish: inspectedCandidate?.pureFinish })
    : null
  const aimContext = !aimDescriptor
    ? null
    : aimWidthFact && otherAimFacts.length === 0
      ? ''
      : buildAimContextSentence({ ...aimDescriptor, contextFacts: otherAimFacts })

  useEffect(() => {
    setInspectedAimOffset(null)
  }, [courseId, holeNumber, viewedEvaluation?.club, isShotStrategy])

  // A new physical shot must never inherit a previous club's "armed" state.
  useEffect(() => {
    setArmedClub(null)
    resetArm()
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
      // Waypoint OCR only measures a tee Looper can't place yet (~3.4 s per read).
      includeWaypoints: () => needsWaypointsRef.current,
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
          <a className="live-caddie-logo-link" href="/bag" aria-label="Looper dashboard">
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
            <button type="button" className="live-diagnostics-toggle" onClick={toggleDiagnostics}
              aria-pressed={showDiagnostics}>
              {showDiagnostics ? 'Hide details' : 'Details'}
            </button>
          </div>
        </header>

        <section className="live-caddie-setup-row">
          {/* Course and hole are chosen in Round Setup and by GSPro; here they
              are display only. */}
          <strong className="live-caddie-course-name">{selectedCourse?.name ?? 'No course'}</strong>
          <span className="live-caddie-hole-name">Hole {holeNumber}</span>
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
          <div className="live-caddie-secondary-context">
            {showDiagnostics && nativeVisualMessage ? <span>{nativeVisualMessage}</span> : null}
            <span>{shotContext}</span>
            {hudShotOneYds != null
              ? <span>{Math.round(hudShotOneYds)} yd to pin</span>
              : pinEstimate ? <span>{Math.round(pointDistance(ball, pinEstimate))} yd to pin</span> : null}
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
        {showDiagnostics ? (
          <NativePositionsBetaPanel
            courseId={courseId === UNSELECTED_COURSE_ID ? null : courseId}
            courseKey={liveSnapshot?.courseKey ?? null}
          />
        ) : null}

        {/* Developer readout for the native aim pipeline; the floating
            "Show where Looper would click" preview is the player-facing one. */}
        {nativeVisualActive && showDiagnostics ? (
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
        {showDiagnostics && nativeObservations?.ocr?.wind?.status ? (
          <div className="live-caddie-alert">
            Wind OCR {nativeObservations.ocr.wind.status}: {nativeObservations.ocr.wind.rawText ?? 'nothing'}{nativeObservations.ocr.wind.note ? ` · ${nativeObservations.ocr.wind.note}` : ''}
            {` · Looper uses ${windObservation?.status ?? 'no wind'}`
              + (windObservation?.speedMph != null ? ` ${windObservation.speedMph} mph` : '')
              + (windObservation?.directionDegrees != null ? ` from ${Math.round(windObservation.directionDegrees)}° (GSPro compass)` : '')
              + (sceneTurn?.rotationDeg ? `, course turned ${sceneTurn.rotationDeg.toFixed(1)}°` : '')}
          </div>
        ) : null}
        {showDiagnostics && recTiming ? (
          <div className="live-caddie-alert">
            Timing this shot: {recTiming.conditionsMs != null ? `wind & lie ${(recTiming.conditionsMs / 1000).toFixed(1)} s · ` : ''}
            recommendation {(recTiming.recMs / 1000).toFixed(1)} s ({recTiming.workers} worker{recTiming.workers === 1 ? '' : 's'}) · total {(recTiming.totalMs / 1000).toFixed(1)} s
            {nativeObservations?.timingMs ? ` · last GSPro read ${((nativeObservations.timingMs.total ?? 0) / 1000).toFixed(1)} s`
              + ` (capture ${((nativeObservations.timingMs.nativeCapture ?? 0) / 1000).toFixed(1)}`
              + `, waypoints ${((nativeObservations.timingMs.waypointOcr ?? 0) / 1000).toFixed(1)}`
              + `, wind ${((nativeObservations.timingMs.windOcr ?? 0) / 1000).toFixed(1)}`
              + `, lie ${((nativeObservations.timingMs.lieOcr ?? 0) / 1000).toFixed(1)})` : ''}
          </div>
        ) : null}
        {showDiagnostics ? (
          <div className="live-caddie-alert">
            GSPro player box: {nativeObservations?.ocr?.hud
              ? `${nativeObservations.ocr.hud.status}${nativeObservations.ocr.hud.shotNumber != null ? ` · Shot ${nativeObservations.ocr.hud.shotNumber}` : ''}${nativeObservations.ocr.hud.distanceToPinYds != null ? ` · ${nativeObservations.ocr.hud.distanceToPinYds} yd` : ''} · read "${nativeObservations.ocr.hud.rawText ?? ''}"`
              : 'not read (companion older than aim-click.5?)'}
            {hudPin ? ` · ${hudPin.note}` : ''}
            {pinCheck.note ? ` · ${pinCheck.note}` : ''}
          </div>
        ) : null}
        {showDiagnostics ? (
          <div className="live-caddie-alert">
            GSPro hazards on this hole: {gkdHazards && gkdOverlay?.source === rawHole
              ? `${gkdHazards.summary.penaltyAreas} penalty area${gkdHazards.summary.penaltyAreas === 1 ? '' : 's'}`
                + (gkdHazards.summary.innerOob ? `, ${gkdHazards.summary.innerOob} internal OB` : '')
                + (gkdHazards.summary.obMode
                  ? ` · OB ${gkdHazards.summary.obMode === 'boundary' ? 'beyond the course boundary' : 'region'}${gkdHazards.summary.obOnHole ? '' : ' (not near this hole)'}`
                  : ' · no OB polygon in the course file')
                + (gkdHazards.summary.obSkipped ? ' · OB left off: it would have covered the tee or green' : '')
              : 'not loaded (needs the GSPro course file and a registration)'}
            {gkdOverlay && gkdOverlay.source === rawHole
              ? ` · Green: ${greenAnchorLine({ ...gkdOverlay.greenSummary, outsideDetail: anchoredGreenOutside })}` : ''}
          </div>
        ) : null}
        {showDiagnostics && inspectedCandidate?.modeledSamples?.length ? (() => {
          const samples = inspectedCandidate.modeledSamples
          const early = samples.filter((q) => q.flightTag === 'trees-early').length / samples.length
          const late = samples.filter((q) => q.flightTag === 'trees-late').length / samples.length
          // Balls stopped by trees didn't roll: leave them out of the roll figure.
          const flown = samples.filter((q) => !q.flightTag)
          const roll = flown.length ? flown.reduce((a, q) => a + Math.hypot(q.landing[0] - q.carryLanding[0], q.landing[1] - q.carryLanding[1]), 0) / flown.length : 0
          const stock = flown.length ? flown.reduce((a, q) => a + (q.stockRollYds ?? 0), 0) / flown.length : 0
          return (
            <div className="live-caddie-alert">
              Flight: {early || late
                ? `${Math.round((early + late) * 100)}% of outcomes hit trees (${Math.round(early * 100)}% after launch, ${Math.round(late * 100)}% coming down)`
                : 'clear of trees'}
              {` · roll ${roll.toFixed(1)} yd of ${stock.toFixed(1)} stock (surface and slope)`}
            </div>
          )
        })() : null}
        {showDiagnostics && aimResult ? (
          <div className="live-caddie-alert">Last Arm: {aimResult.message}</div>
        ) : null}
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
            <ScreenOnlyCaddie companionConnected={companionStatus?.gspro.status === 'connected'} />
          </section>
        ) : !hole ? (
          <section className="live-empty-state">
            <span className="live-kicker">{loadError ? 'NO MAP FOR THIS HOLE' : 'LOADING COURSE'}</span>
            <h1>{selectedCourse?.name} · Hole {holeNumber}</h1>
            {loadError ? <ScreenOnlyCaddie companionConnected={companionStatus?.gspro.status === 'connected'} /> : null}
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
                        ? waitingForConditions ? 'READING WIND & LIE' : 'CALCULATING'
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
                    {aimWidthFact && !isShotStrategy ? <span className="live-aim-width">{aimWidthFact}</span> : null}
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
                    {flushedRead ? (
                      <span className="live-green-read"><strong>Flushed:</strong> {flushedRead}</span>
                    ) : null}
                    {viewedEvaluation?.startingBag ? (
                      <span className="live-starting-bag">
                        {viewedEvaluation.startingBag.shots === 0
                          ? `Starting-bag numbers for ${viewedEvaluation.club} (no range swings yet).`
                          : `${viewedEvaluation.club} still learning: ${viewedEvaluation.startingBag.shots} of ${BLEND_RULES.carry.fullAt} range swings.`}
                        {' '}
                      </span>
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
                    unmappedInPlay={gsproOnlyCourse}
                    onRefreshWind={companionStatus?.gspro.status === 'connected' ? refreshWind : undefined}
                    windRefreshing={windRefreshing}
                    decisionOptions={decisionOptionsJson}
                  />

                  <button
                    type="button"
                    className={`live-arm-recommendation${armedHere && !aimChanged ? ' armed' : ''}${armPhase === 'filling' ? ' filling' : ''}${armPhase === 'aiming' ? ' aiming' : ''}${aimChanged ? ' aim-changed' : ''}${isShotStrategy ? ' strategy-mode' : ''}`}
                    style={{ '--arm-fill-ms': `${ARM_FILL_MS}ms` } as CSSProperties}
                    disabled={isShotStrategy || !displayedClub}
                    onClick={pressArm}
                  >
                    <span className="live-arm-label">
                      {isShotStrategy
                        ? eligibleArmedClub ? `${eligibleArmedClub} PLAYER SELECTION` : 'CHOOSE ACTUAL CLUB BELOW'
                        : armPhase === 'filling'
                          ? `ARMING ${displayedClub}… TAP TO CANCEL`
                          : armPhase === 'aiming'
                            ? `${displayedClub} ARMED · AIMING IN GSPRO…`
                            : aimChanged
                              ? `${displayedClub} ARMED · AIM CHANGED, TAP TO RE-AIM`
                              : armedHere
                                ? `${displayedClub} ARMED · ${aimShort}`
                                : displayedClub
                                  ? `HITTING ${displayedClub} · TAP TO ARM`
                                  : evaluationPending
                                    ? 'CALCULATING RECOMMENDATION…'
                                    : 'WAITING FOR RECOMMENDATION'}
                    </span>
                  </button>
                  {armedHere && aimResult && aimResult.outcome !== 'aimed' ? (
                    <p className="live-arm-note">{aimResult.message}</p>
                  ) : null}
                  {safePick && !armedHere ? (
                    // One line, two states. Before the tap it offers the safe play; after
                    // the tap the card shows the safe play, so the line offers the way back.
                    <button
                      type="button"
                      className={`live-safe-pick${safePickChosen ? ' is-chosen' : ''}`}
                      aria-pressed={safePickChosen}
                      title={safePickChosen
                        ? 'Back to Looper\u2019s pick (lowest expected strokes).'
                        : safePick.differsBy === 'club'
                          ? `${safePick.club} instead of ${safePick.math.club}. Tap to switch the card to it, then arm as usual.`
                          : 'Same club, a different line. Tap to switch the card to it, then arm as usual.'}
                      onClick={() => {
                        if (safePickChosen) {
                          setPreviewClub(null)
                          setInspectedAimOffset(null)
                          return
                        }
                        pickClub(safePick.club)
                        setInspectedAimOffset(safePick.candidate.aimOffsetYds)
                      }}
                    >
                      {safePickChosen ? (
                        <>
                          <span className="live-safe-pick-label">Showing the safe play</span>
                          <span className="live-safe-pick-what">
                            Back to <strong>{safePick.math.club}</strong>{mathAimText ? ` · ${mathAimText.replace(/^Aim\s+/i, 'aim ')}` : ''}
                          </span>
                          <span className="live-safe-pick-why">Looper’s pick: lowest expected strokes · {describeMathPick(safePick)}</span>
                        </>
                      ) : (
                        <>
                          <span className="live-safe-pick-label">Safe play</span>
                          <span className="live-safe-pick-what">
                            <strong>{safePick.club}</strong>{safeAimText ? ` · ${safeAimText.replace(/^Aim\s+/i, 'aim ')}` : ''}
                          </span>
                          <span className="live-safe-pick-why">{describeSafeAlternative(safePick)}</span>
                        </>
                      )}
                    </button>
                  ) : null}
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
                    {(outcomeTiles(risk, gsproOnlyCourse ? 'in-play' : 'trouble') ?? OUTCOME_PLACEHOLDER).map((tile) => (
                      <div key={tile.label} className={`outcome-${tile.label.toLowerCase()}`}><strong>{tile.text}</strong><span>{tile.label}</span></div>
                    ))}
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
                  candidate={isShotStrategy || !inspectedCandidate ? null
                    : aimClick ? { ...inspectedCandidate, aimPoint: aimClick } : inspectedCandidate}
                  strategyAimPoint={isShotStrategy ? shotStrategy?.target ?? null : null}
                  show95={show95}
                  showRiskTail={showRiskTail}
                  showPracticeShots={showPracticeShots}
                  provisionalTeeRadiusYds={provisionalPositionRadiusYds ?? provisionalTeeRadiusYds}
                  greenRead={shownGreenRead}
                />

                <div className="live-map-legend">
                  <span><i className="ball" />Ball</span>
                  <span><i className="aim" />{isShotStrategy ? 'Strategy target' : 'Aim (GSPro click)'}</span>
                  {!isShotStrategy ? <span><i className="carry" />Landing</span> : null}
                  {!isShotStrategy ? <span><i className="mean" />Expected finish</span> : null}
                  <span><i className="pin" />Pin</span>
                  {!isShotStrategy ? <span><i className="core" />Core dispersion</span> : null}
                  {!isShotStrategy && showPracticeShots ? <span><i className="practice" />Your observed shots</span> : null}
                </div>
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
                {eligibleArmedClub ? <button type="button" onClick={() => { setArmedClub(null); resetArm() }}>Clear</button> : null}
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
                      className={`${!eligible ? 'ineligible ' : ''}${eligibleArmedClub === club ? 'armed ' : ''}${!eligibleArmedClub && eligiblePreviewClub === club ? 'previewing ' : ''}${!isShotStrategy && recommendation?.club === club ? 'recommended' : ''}`}
                      onClick={() => { if (eligible) pickClub(club) }}
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
                : "Tap a club to see its best line. Press Arm to commit: Looper aims it in GSPro. REC remains Looper's preferred club."}</p>
            </section>
          </>
        )}
      </div>
    </main>
  )
}
