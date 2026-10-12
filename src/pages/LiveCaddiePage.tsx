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
import { estimateProvisionalTee, readTeeBallPinDistanceYds } from '../courseGeometry/provisionalTeeEstimate'
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
  CourseSurfaceKind,
} from '../courseGeometry/types'
import {
  buildAimContextSentence,
  buildAimDescriptor,
} from '../liveCaddie/aimDescriptor'
import type {
  AimCandidateEvaluation,
  ClubAimEvaluation,
} from '../liveCaddie/aimOptimization'
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
import LiveDecisionDetails from './LiveDecisionDetails'
import './LiveCaddiePage.css'

const surfaceOrder: CourseSurfaceKind[] = [
  'rough',
  'deep-rough',
  'fairway',
  'tee',
  'green',
  'bunker',
  'penalty',
  'water',
]

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

const buildTacticalMapBounds = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  target: CoursePointYds,
  pinEstimate: CoursePointYds | null,
  candidate: AimCandidateEvaluation | null,
  provisionalTeeRadiusYds: number | null = null,
) => {
  const pinDistance = pinEstimate ? pointDistance(ball, pinEstimate) : Number.POSITIVE_INFINITY
  const includePin = Boolean(pinEstimate && pinDistance <= 285)
  const focusPoints: CoursePointYds[] = [ball, target]
  if (candidate) focusPoints.push(candidate.aimPoint, candidate.meanLanding)
  if (includePin && pinEstimate) focusPoints.push(pinEstimate)

  const maxCarryRadius = candidate?.probabilityContours.reduce(
    (maximum, contour) => Math.max(maximum, contour.carryRadiusYds),
    0,
  ) ?? 0
  const maxLateralRadius = candidate?.probabilityContours.reduce(
    (maximum, contour) => Math.max(maximum, contour.lateralRadiusYds),
    0,
  ) ?? 0

  const minY = ball[1] - Math.max(24, (provisionalTeeRadiusYds ?? 0) + 5)
  const furthestFocusY = Math.max(...focusPoints.map((point) => point[1]))
  const desiredMaxY = furthestFocusY + Math.max(115, maxCarryRadius + 70)
  const minimumForwardSpan = pinDistance < 180
    ? Math.max(130, pinDistance + 60)
    : 260
  const maxY = Math.max(
    minY + minimumForwardSpan,
    Math.min(desiredMaxY, ball[1] + 390),
  )

  let referenceMinX = Math.min(...focusPoints.map((point) => point[0])) - maxLateralRadius
  let referenceMaxX = Math.max(...focusPoints.map((point) => point[0])) + maxLateralRadius
  const surfaceWindowMinX = referenceMinX - 72
  const surfaceWindowMaxX = referenceMaxX + 72
  const surfaceWindowMinY = minY - 12
  const surfaceWindowMaxY = maxY + 12
  const framingKinds = new Set<CourseSurfaceKind>([
    'tee',
    'fairway',
    'green',
    'bunker',
    'water',
    'penalty',
  ])

  for (const surface of hole.surfaces) {
    if (!framingKinds.has(surface.kind)) continue
    for (const polygon of surface.polygons) {
      for (const [x, y] of polygon) {
        if (
          y < surfaceWindowMinY ||
          y > surfaceWindowMaxY ||
          x < surfaceWindowMinX ||
          x > surfaceWindowMaxX
        ) continue
        referenceMinX = Math.min(referenceMinX, x)
        referenceMaxX = Math.max(referenceMaxX, x)
      }
    }
  }

  const centerX = (referenceMinX + referenceMaxX) / 2
  const halfWidth = Math.min(
    96,
    Math.max(58, (referenceMaxX - referenceMinX) / 2 + 20),
  )

  return {
    minX: centerX - halfWidth,
    maxX: centerX + halfWidth,
    minY,
    maxY,
  }
}

function LiveCaddieMap({
  hole,
  ball,
  target,
  pinEstimate,
  candidate,
  show95,
  showRiskTail,
  showPracticeShots,
  provisionalTeeRadiusYds,
}: {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  pinEstimate: CoursePointYds | null
  candidate: AimCandidateEvaluation | null
  show95: boolean
  showRiskTail: boolean
  showPracticeShots: boolean
  provisionalTeeRadiusYds: number | null
}) {
  const viewSize = 100
  const pad = 4
  const displayBounds = buildTacticalMapBounds(hole, ball, target, pinEstimate, candidate, provisionalTeeRadiusYds)
  const spanX = Math.max(1, displayBounds.maxX - displayBounds.minX)
  const spanY = Math.max(1, displayBounds.maxY - displayBounds.minY)
  const scale = Math.min((viewSize - pad * 2) / spanX, (viewSize - pad * 2) / spanY)
  const usedWidth = spanX * scale
  const usedHeight = spanY * scale
  const offsetX = (viewSize - usedWidth) / 2
  const offsetY = (viewSize - usedHeight) / 2

  const project = (point: CoursePointYds): [number, number] => [
    offsetX + (point[0] - displayBounds.minX) * scale,
    viewSize - (offsetY + (point[1] - displayBounds.minY) * scale),
  ]

  const ballSvg = project(ball)
  const targetSvg = project(target)
  const pinSvg = pinEstimate ? project(pinEstimate) : null
  const aimSvg = candidate ? project(candidate.aimPoint) : null
  const meanSvg = candidate ? project(candidate.meanLanding) : null
  const shotDx = (aimSvg?.[0] ?? targetSvg[0]) - ballSvg[0]
  const shotDy = (aimSvg?.[1] ?? targetSvg[1]) - ballSvg[1]
  const shotAngle = (Math.atan2(shotDy, shotDx) * 180) / Math.PI + 90
  const visibleContours = candidate?.probabilityContours.filter(
    (contour) => contour.probability !== 0.95 || show95,
  ) ?? []
  const historical = candidate?.empiricalAllShots?.samples ?? []
  const historicalAverageWeight = historical.length > 0 ? 1 / historical.length : 1
  const tail = candidate?.riskProfile?.tailLandings ?? []
  const tailAverageWeight = candidate?.riskProfile && tail.length > 0
    ? candidate.riskProfile.tailProbability / tail.length
    : 1

  return (
    <div className="live-map-shell">
      <svg className="live-map" viewBox={`0 0 ${viewSize} ${viewSize}`}>
        <defs>
          <pattern id="liveWoodsPattern" width="5.2" height="5.2" patternUnits="userSpaceOnUse">
            <rect width="5.2" height="5.2" fill="#173d29" fillOpacity="0.2" />
            <circle cx="1" cy="1.4" r="0.9" fill="#6f9962" fillOpacity="0.16" />
            <circle cx="3.4" cy="1" r="1.15" fill="#4f7a4b" fillOpacity="0.14" />
            <circle cx="2.5" cy="3.7" r="1.25" fill="#7ba06b" fillOpacity="0.12" />
          </pattern>
          <pattern id="liveScrubPattern" width="4.4" height="4.4" patternUnits="userSpaceOnUse">
            <rect width="4.4" height="4.4" fill="#4d4a2d" fillOpacity="0.16" />
            <circle cx="1" cy="1.2" r="0.58" fill="#b5a967" fillOpacity="0.16" />
            <circle cx="3.2" cy="3" r="0.68" fill="#8c854f" fillOpacity="0.15" />
          </pattern>
          <pattern id="liveNativePattern" width="4.8" height="4.8" patternUnits="userSpaceOnUse">
            <rect width="4.8" height="4.8" fill="#595437" fillOpacity="0.2" />
            <path d="M1 4.8 L1.35 2.15 M2.6 4.8 L2.35 2.75 M4 4.8 L4.25 2.35" stroke="#c4b66f" strokeOpacity="0.24" strokeWidth="0.28" />
          </pattern>
          <pattern id="liveDunePattern" width="5.2" height="5.2" patternUnits="userSpaceOnUse">
            <rect width="5.2" height="5.2" fill="#8b7650" fillOpacity="0.2" />
            <path d="M0 1.5 C1.3 1 2.6 2 5.2 1.35 M0 3.8 C1.7 3.25 3.1 4.2 5.2 3.55" fill="none" stroke="#d9c18b" strokeOpacity="0.22" strokeWidth="0.24" />
          </pattern>
        </defs>

        {hole.mapFeatures?.flatMap((feature) => [
          ...(feature.polygons ?? []).map((polygon, index) => (
            <polygon
              key={`${feature.id}-polygon-${index}`}
              className={`live-map-feature map-${feature.kind}`}
              points={polygon.map((point) => project(point).join(',')).join(' ')}
            />
          )),
          ...(feature.lines ?? []).map((line, index) => (
            <polyline
              key={`${feature.id}-line-${index}`}
              className={`live-map-feature map-${feature.kind}`}
              points={line.map((point) => project(point).join(',')).join(' ')}
            />
          )),
        ])}

        {hole.contextLayers?.flatMap((layer) =>
          layer.polygons.map((polygon, index) => (
            <polygon
              key={`${layer.id}-${index}`}
              className={`live-context context-${layer.kind}`}
              points={polygon.map((point) => project(point).join(',')).join(' ')}
            />
          )),
        )}
        {hole.contours?.map((contour, index) => (
          <polyline
            key={`contour-${contour.elevationFt}-${index}`}
            className="live-terrain-contour"
            points={contour.points.map((point) => project(point).join(',')).join(' ')}
          />
        ))}
        {surfaceOrder.flatMap((kind) =>
          hole.surfaces
            .filter((surface) => surface.kind === kind)
            .flatMap((surface) =>
              surface.polygons.map((polygon, index) => (
                <polygon
                  key={`${surface.id}-${index}`}
                  className={`live-surface surface-${kind}`}
                  points={polygon.map((point) => project(point).join(',')).join(' ')}
                />
              )),
            ),
        )}

        {candidate && aimSvg && meanSvg ? (
          <>
            <line className="live-target-line" x1={ballSvg[0]} y1={ballSvg[1]} x2={meanSvg[0]} y2={meanSvg[1]} />
            <line className="live-aim-line" x1={ballSvg[0]} y1={ballSvg[1]} x2={aimSvg[0]} y2={aimSvg[1]} />
            {[...visibleContours].reverse().map((contour) => (
              <ellipse
                key={contour.probability}
                className={`live-probability probability-${Math.round(contour.probability * 100)}`}
                cx={meanSvg[0]}
                cy={meanSvg[1]}
                rx={Math.max(0.4, contour.lateralRadiusYds * scale)}
                ry={Math.max(0.4, contour.carryRadiusYds * scale)}
                transform={`rotate(${shotAngle} ${meanSvg[0]} ${meanSvg[1]})`}
              />
            ))}
            {showRiskTail && tail.map((sample, index) => {
              const point = project(sample.landing)
              return (
                <circle
                  key={`tail-${index}`}
                  className={`live-risk-dot risk-${sample.tier}`}
                  cx={point[0]}
                  cy={point[1]}
                  r={Math.max(0.28, Math.min(0.72, 0.38 * Math.sqrt(sample.weight / Math.max(1e-9, tailAverageWeight))))}
                />
              )
            })}
            {showPracticeShots && historical.map((sample, index) => {
              const point = project(sample.landing)
              return (
                <circle
                  key={`practice-${index}`}
                  className={`live-practice-dot sample-${sample.kind}`}
                  cx={point[0]}
                  cy={point[1]}
                  r={Math.max(0.25, Math.min(0.62, 0.34 * Math.sqrt(sample.weight / historicalAverageWeight))) }
                />
              )
            })}
            <circle className="live-mean-marker" cx={meanSvg[0]} cy={meanSvg[1]} r="1.05" />
            <circle className="live-aim-marker" cx={aimSvg[0]} cy={aimSvg[1]} r="0.82" />
          </>
        ) : null}
        {pinSvg ? <circle className="live-pin-marker" cx={pinSvg[0]} cy={pinSvg[1]} r="0.78" /> : null}
        {provisionalTeeRadiusYds != null ? (
          <circle cx={ballSvg[0]} cy={ballSvg[1]} r={provisionalTeeRadiusYds * scale}
            fill="#dabb6c" fillOpacity={0.10} stroke="#f0c777"
            strokeOpacity={0.72} strokeDasharray="1.2 1" strokeWidth={0.27}/>
        ) : null}
        <circle className="live-ball-marker" cx={ballSvg[0]} cy={ballSvg[1]} r="1.2" />
      </svg>
    </div>
  )
}

export default function LiveCaddiePage() {
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadSavedSessions())
  const [bagClubs, setBagClubs] = useState(() => [...activeBagClubIds])
  const [courseId, setCourseId] = useState<CourseId>(() => loadLastSelectedCourseId())
  const [holeNumber, setHoleNumber] = useState(1)
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
  const [visualCaptureStatus, setVisualCaptureStatus] = useState<BrowserGsproVisualCaptureStatus>('idle')
  const [visualCaptureError, setVisualCaptureError] = useState<string | null>(null)
  const [visualCaptureSource, setVisualCaptureSource] = useState<string | null>(null)
  const [companionStatus, setCompanionStatus] = useState<LooperCompanionStatus | null>(null)
  const [nativeVisualActive, setNativeVisualActive] = useState(false)
  const [nativeVisualMessage, setNativeVisualMessage] = useState<string | null>(null)
  const [nativeObservations, setNativeObservations] = useState<LooperCompanionLiveObservations | null>(null)
  const nativeVisualRef = useRef<LooperNativeObservationConnection | null>(null)
  const triedProvisionalTeeNative = useRef(new Set<string>())
  const [holeHeadingDegreesTrue, setHoleHeadingDegreesTrue] = useState<number | null>(null)
  const [show95, setShow95] = useState(false)
  const [showRiskTail, setShowRiskTail] = useState(false)
  const [showPracticeShots, setShowPracticeShots] = useState(false)
  const [inspectedAimOffset, setInspectedAimOffset] = useState<number | null>(null)
  const [armedClub, setArmedClub] = useState<string | null>(null)
  const lastShotKeyRef = useRef<string | null>(null)
  const visualCaptureRef = useRef<BrowserGsproVisualCaptureConnection | null>(null)

  const selectedCourse = courseId === UNSELECTED_COURSE_ID ? null : getCourseCatalogEntry(courseId)

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
  }, [courseId, holeNumber])

  // One bounded, read-only native observation at a new, UNMAPPED tee. The
  // manual Start Round pathway stays authoritative about Hole 1. This does
  // not create another hole tracker or run continuous screenshot capture.
  useEffect(() => {
    if (!hole || !liveSnapshot || liveSnapshot.holeNumber !== holeNumber
      || liveSnapshot.teePlacement !== 'provisional'
      || liveSnapshot.nextShotNumber !== 1
      || companionStatus?.gspro.status !== 'connected'
      || nativeVisualActive) return
    const key = [courseId, holeNumber, liveSnapshot.roundId ?? 'manual-start'].join(':')
    if (triedProvisionalTeeNative.current.has(key)) return
    triedProvisionalTeeNative.current.add(key)
    let cancelled = false
    void readLooperCompanionObservations(45000)
      .then(obs => { if (!cancelled) setNativeObservations(obs) })
      .catch(() => { /* Route-origin provisional estimate remains explicit. */ })
    return () => { cancelled = true }
  }, [hole, courseId, holeNumber, liveSnapshot, companionStatus?.gspro.status, nativeVisualActive])

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
    const seenCourse = shot?.courseKey ? resolveCourseIdFromGsproName(shot.courseKey) : null
    if (seenCourse && seenCourse !== courseId) return null
    const nativeHasThisTee = shot?.kind === 'pre_shot'
      && shot?.status === 'ready'
      && shot.holeNumber === hole.holeNumber && shot.shotNumber === 1
    // Manual start is the existing explicit user commitment to Hole 1.
    const isManuallyArmedHoleOne = hole.holeNumber === 1 && liveSnapshot.roundId == null
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
    return distance == null ? null : estimateProvisionalTee(hole, distance)
  }, [hole, liveSnapshot, nativeObservations, courseId])

  useEffect(() => {
    if (nativeProvisionalTee?.status !== 'provisional') return
    setBall(nativeProvisionalTee.point)
    if (hole) setTarget(chooseLiveLandingTarget(hole, nativeProvisionalTee.point, hole.markers.pin ?? null))
  }, [nativeProvisionalTee, hole])

  useEffect(() => {
    if (!hole || !liveSnapshot || liveSnapshot.holeNumber !== hole.holeNumber) return
    const nextBall = liveSnapshot.ballLocalYds
      ?? (liveSnapshot.ballSource === 'cached-tee' ? hole.markers.tee : null)
    if (!nextBall) return
    const nextPin = estimatePinFromGsproDistance(hole, nextBall, liveSnapshot.distanceToPinYds)
    setBall(nextBall)
    setTarget(chooseLiveLandingTarget(hole, nextBall, nextPin))
  }, [hole, liveSnapshot])

  const liveMatchesHole = Boolean(liveSnapshot?.holeNumber === holeNumber)
  const pinEstimate = hole
    ? estimatePinFromGsproDistance(
        hole,
        ball,
        liveMatchesHole ? liveSnapshot?.distanceToPinYds ?? null : null,
      )
    : null
  const liveLieSurface = lieObservation?.status === 'READY' && lieObservation.surface?.trim()
    ? lieObservation.surface.trim()
    : null
  const surface = liveLieSurface
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
  const ballTerrain = hole ? estimateCourseTerrain(hole, ball) : null
  const targetTerrain = hole ? estimateCourseTerrain(hole, target) : null
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
  const surfaceOverride = liveLieSurface
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
  const isTeeSurface = typeof authoritativeGsproSurface === 'string'
    && authoritativeGsproSurface.trim().toLowerCase() === 'tee'
  const hasOcrLie = lieObservation?.status === 'READY' && (
    (typeof lieObservation.upDownDegrees === 'number' && Number.isFinite(lieObservation.upDownDegrees))
    || (typeof lieObservation.leftRightDegrees === 'number' && Number.isFinite(lieObservation.leftRightDegrees))
  )
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
    if (!hole || isGreenSurface) {
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
        lieUpDownDeg,
        lieLeftRightDeg,
        lieSource,
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
    windMph,
    windRelativeDeg,
    elevationDeltaFt,
    elevationSource,
    airAltitudeFt,
    airAltitudeSource,
    surfaceOverride,
    lieUpDownDeg,
    lieLeftRightDeg,
    lieSource,
  ])

  const recommendation = evaluations[0] ?? null
  const viewedEvaluation = armedClub
    ? evaluations.find((evaluation) => evaluation.club === armedClub) ?? null
    : recommendation
  const viewedBestCandidate = viewedEvaluation?.bestCandidate ?? null
  const inspectedCandidate = viewedEvaluation
    ? viewedEvaluation.candidates.find((candidate) => candidate.aimOffsetYds === inspectedAimOffset)
      ?? viewedBestCandidate
      ?? null
    : null
  const risk = inspectedCandidate?.riskProfile ?? null
  const displayedClub = armedClub ?? viewedEvaluation?.club ?? recommendation?.club ?? null
  const isAlternateClub = Boolean(
    armedClub && recommendation?.club && armedClub !== recommendation.club,
  )
  const viewedClubRank = viewedEvaluation?.decisionRank ?? null
  const aimDescriptor = hole && viewedEvaluation && inspectedCandidate
    ? buildAimDescriptor({
        hole,
        ball,
        target: viewedEvaluation.planningTarget,
        aimPoint: inspectedCandidate.aimPoint,
        aimOffsetYds: inspectedCandidate.aimOffsetYds,
        pin: pinEstimate,
      })
    : null
  // Read-only envelope for future native pairing. The UI does NOT POST this
  // unverified local-hole aim point to the Windows companion.
  const nativeAimIntent = prepareReadOnlyNativeAimIntent({
    snapshot: liveMatchesHole ? liveSnapshot : null,
    courseId,
    holeNumber,
    club: displayedClub,
    teeLocalYds: hole?.markers.tee ?? null,
    targetLocalYds: inspectedCandidate?.aimPoint ?? null,
  })
  const nativeAimPreview = nativeVisualActive
    ? prepareReadOnlyNativeAimPreview(nativeAimIntent, nativeObservations)
    : null
  const playerFacingAim = aimDescriptor?.text
    ?? (viewedEvaluation ? aimLabel(inspectedCandidate?.aimOffsetYds) : 'No modeled line')
  const aimContext = aimDescriptor ? buildAimContextSentence(aimDescriptor) : null

  useEffect(() => {
    setInspectedAimOffset(null)
  }, [courseId, holeNumber, viewedEvaluation?.club])

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
            <a href="/dev/aim-lab" className="live-diagnostics-link">Aim Lab</a>
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
          <div className="live-caddie-secondary-context">
            {nativeVisualMessage ? <span>{nativeVisualMessage}</span> : null}
            <span>{shotContext}</span>
            {pinEstimate ? <span>{Math.round(pointDistance(ball, pinEstimate))} yd to pin</span> : null}
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

        {liveError ? <div className="live-caddie-alert bad">GSPro: {liveError}</div> : null}
        {visualCaptureError ? (
          <div className="live-caddie-alert bad">GSPro visuals: {visualCaptureError}</div>
        ) : null}
        {visualCaptureStatus === 'stopped' && !visualCaptureError ? (
          <div className="live-caddie-alert">GSPro visual capture stopped. Reconnect visuals for live wind and lie.</div>
        ) : null}
        {liveSnapshot?.teePlacement === 'provisional'
          && liveSnapshot.holeNumber === holeNumber
          && liveSnapshot.nextShotNumber === 1 ? (
          <div className="live-caddie-alert" data-tee-quality="provisional">
            Provisional first-use tee — about ±{nativeProvisionalTee?.status === 'provisional'
              ? nativeProvisionalTee.uncertaintyRadiusYds : liveSnapshot.teeUncertaintyYds ?? 50} yards.
            {nativeProvisionalTee?.status === 'provisional'
              ? ' GSPro ball/pin ruler constrained the forward tee estimate; lateral position remains unknown.'
              : ' Using approximate OSM route start until a reliable GSPro ball/pin ruler is available.'}
            {' '}Club choice is preliminary; exact forced carries, hazard margins, elevation at tee
            and native aim are not verified. Do not save this as a confirmed tee.
          </div>
        ) : null}
        {loadError ? <div className="live-caddie-alert bad">Course geometry: {loadError}</div> : null}
        {evaluationError ? <div className="live-caddie-alert bad">Decision engine: {evaluationError}</div> : null}
        {liveSnapshot?.warnings.map((warning) => <div className="live-caddie-alert" key={warning}>{warning}</div>)}

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
        ) : (
          <>
            <section className="live-caddie-main-grid">
              <aside className="live-decision-column">
                <article className="live-decision-card">
                  <div className="live-decision-label-row">
                    <span className="live-recommended-pill">
                      {evaluationPending
                        ? 'CALCULATING'
                        : isAlternateClub
                          ? `USER SELECTED${viewedClubRank ? ` · #${viewedClubRank} CLUB` : ''}`
                          : 'RECOMMENDED · #1 CLUB'}
                    </span>
                    {isAlternateClub && recommendation ? (
                      <span style={{ color: '#9fb09f', fontSize: '10px' }}>
                        Looper recommends {recommendation.club}
                      </span>
                    ) : inspectedCandidate && viewedBestCandidate && inspectedCandidate !== viewedBestCandidate ? (
                      <button className="live-reset-inspection" type="button" onClick={() => setInspectedAimOffset(null)}>
                        Viewing alternate · reset
                      </button>
                    ) : null}
                  </div>

                  <div className="live-club-hero">{displayedClub ?? '—'}</div>
                  <div className="live-aim-hero">
                    {playerFacingAim}
                  </div>
                  <p className="live-decision-reason">
                    {aimContext
                      ?? inspectedCandidate?.decisionReason
                      ?? viewedEvaluation?.decisionReason
                      ?? (evaluationPending
                        ? 'Looper is calculating the club, aim and next-shot value in the background.'
                        : displayedClub
                          ? `Looper does not yet have enough modeled support to rank a ${displayedClub} line for this shot.`
                          : 'Looper is waiting for enough player data to rank this shot.')}
                  </p>

                  <ConditionsMathPanel
                    evaluation={viewedEvaluation}
                    windMph={windMph}
                    windRelativeDeg={windRelativeDeg}
                    hasLiveWind={hasLiveWind}
                    elevationDeltaFt={elevationDeltaFt}
                    lieUpDownDeg={hasLiveLie ? lieUpDownDeg : null}
                    lieLeftRightDeg={hasLiveLie ? lieLeftRightDeg : null}
                  />

                  <button
                    type="button"
                    className={`live-arm-recommendation${armedClub && armedClub === displayedClub ? ' armed' : ''}`}
                    disabled={!displayedClub}
                    onClick={() => displayedClub && setArmedClub(displayedClub)}
                  >
                    {armedClub && armedClub === displayedClub
                      ? `${displayedClub} ARMED FOR NEXT SHOT`
                      : displayedClub
                        ? `HITTING ${displayedClub} · TAP TO ARM`
                        : evaluationPending
                          ? 'CALCULATING RECOMMENDATION…'
                          : 'WAITING FOR RECOMMENDATION'}
                  </button>
                </article>

                <article className="live-outcomes-card">
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
                </article>
              </aside>

              <article className="live-map-card">
                <div className="live-map-topbar">
                  <div>
                    <span className="live-kicker">SHOT MAP</span>
                    <h2>{displayedClub
                      ? `${displayedClub} · ${viewedEvaluation ? playerFacingAim : 'no modeled line'}`
                      : evaluationPending
                        ? 'Calculating recommendation…'
                        : 'Waiting for recommendation'}</h2>
                  </div>
                  <div className="live-map-toggles">
                    <button type="button" className="always-on">50 / 80%</button>
                    <button type="button" className={show95 ? 'active' : ''} onClick={() => setShow95((value) => !value)}>95%</button>
                    <button type="button" className={showPracticeShots ? 'active' : ''} onClick={() => setShowPracticeShots((value) => !value)}>
                      Practice shots{viewedEvaluation ? ` · ${viewedEvaluation.empiricalShotCount}` : ''}
                    </button>
                    <button type="button" className={showRiskTail ? 'active' : ''} onClick={() => setShowRiskTail((value) => !value)}>Risk tail</button>
                  </div>
                </div>

                <LiveCaddieMap
                  hole={hole}
                  ball={ball}
                  target={target}
                  pinEstimate={pinEstimate}
                  candidate={inspectedCandidate}
                  show95={show95}
                  showRiskTail={showRiskTail}
                  showPracticeShots={showPracticeShots}
                />

                <div className="live-map-legend">
                  <span><i className="ball" />Ball</span>
                  <span><i className="aim" />Aim</span>
                  <span><i className="mean" />Expected finish</span>
                  <span><i className="pin" />Pin</span>
                  <span><i className="core" />Core dispersion</span>
                  {showPracticeShots ? <span><i className="practice" />Your observed shots</span> : null}
                </div>
              </article>
            </section>

            <LiveDecisionDetails
              evaluations={evaluations}
              viewedEvaluation={viewedEvaluation}
              inspectedCandidate={inspectedCandidate}
              ball={ball}
              target={target}
              onInspectAim={(aimOffsetYds) => setInspectedAimOffset(aimOffsetYds)}
            />

            <section className="live-club-strip-card">
              <div className="live-club-strip-heading">
                <div>
                  <span className="live-kicker">ACTUAL CLUB</span>
                  <strong>{armedClub ? `${armedClub} armed for the next physical shot` : 'Tap the club you are actually hitting'}</strong>
                </div>
                {armedClub ? <button type="button" onClick={() => setArmedClub(null)}>Clear</button> : null}
              </div>
              <div className="live-club-strip">
                {bagClubs.map((club) => {
                  const clubEvaluation = evaluations.find((evaluation) => evaluation.club === club) ?? null
                  return (
                    <button
                      type="button"
                      key={club}
                      className={`${armedClub === club ? 'armed ' : ''}${recommendation?.club === club ? 'recommended' : ''}`}
                      onClick={() => setArmedClub(club)}
                    >
                      <strong>{club}</strong>
                      {recommendation?.club === club
                        ? <span>REC</span>
                        : armedClub === club && clubEvaluation?.decisionRank
                          ? <span>#{clubEvaluation.decisionRank} CLUB</span>
                          : null}
                    </button>
                  )
                })}
              </div>
              <p>Selecting a club arms it for the next GSPro shot and switches the screen to that club's best modeled line. REC remains Looper's preferred club.</p>
            </section>
          </>
        )}
      </div>
    </main>
  )
}
