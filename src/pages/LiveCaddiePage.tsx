import { useEffect, useMemo, useRef, useState } from 'react'
import {
  connectBrowserGsproCourseStateFolder,
  connectToBrowserGsproCourseState,
  prepareBrowserGsproCourseStateRuntime,
  type BrowserGsproCourseSnapshot,
  type BrowserGsproCourseStatus,
} from '../adapters/browserGsproCourseState'
import looperLogoWhite from '../assets/LooperLogoWhite.png'
import {
  courseCatalog,
  getCourseCatalogEntry,
  UNSELECTED_COURSE_ID,
  type CourseId,
} from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import {
  loadLastSelectedCourseId,
  saveLastSelectedCourseId,
} from '../courseGeometry/courseSelection'
import { classifyPoint, fairwayCorridorAtForwardY } from '../courseGeometry/geometry'
import { estimateGreywolfTerrain as estimateCourseTerrain } from '../courseGeometry/lidar'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceKind,
} from '../courseGeometry/types'
import {
  evaluateAimLab,
  type AimCandidateEvaluation,
  type ClubAimEvaluation,
} from '../liveCaddie/aimOptimization'
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
import './LiveCaddiePage.css'

const surfaceOrder: CourseSurfaceKind[] = [
  'rough',
  'water',
  'fairway',
  'green',
  'bunker',
  'tee',
  'deep-rough',
  'penalty',
]

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

const sortedAimOptions = (evaluation: ClubAimEvaluation | null) => {
  if (!evaluation) return []
  return [...evaluation.candidates]
    .filter((candidate) => candidate.decisionRank != null)
    .sort((left, right) => (left.decisionRank ?? 999) - (right.decisionRank ?? 999))
    .slice(0, 4)
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
}: {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  pinEstimate: CoursePointYds | null
  candidate: AimCandidateEvaluation | null
  show95: boolean
  showRiskTail: boolean
  showPracticeShots: boolean
}) {
  const viewSize = 100
  const pad = 4
  const bounds = hole.viewBounds ?? hole.bounds
  const displayBounds = {
    minX: bounds.minX,
    maxX: bounds.maxX,
    minY: Math.max(bounds.minY, -28),
    maxY: bounds.maxY,
  }
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
        </defs>

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

        <line className="live-target-line" x1={ballSvg[0]} y1={ballSvg[1]} x2={targetSvg[0]} y2={targetSvg[1]} />
        {candidate && aimSvg && meanSvg ? (
          <>
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
                  r={Math.max(0.25, Math.min(0.62, 0.34 * Math.sqrt(sample.weight / historicalAverageWeight)))}
                />
              )
            })}
            <circle className="live-mean-marker" cx={meanSvg[0]} cy={meanSvg[1]} r="1.05" />
            <circle className="live-aim-marker" cx={aimSvg[0]} cy={aimSvg[1]} r="0.82" />
          </>
        ) : null}
        {pinSvg ? <circle className="live-pin-marker" cx={pinSvg[0]} cy={pinSvg[1]} r="0.78" /> : null}
        <circle className="live-target-marker" cx={targetSvg[0]} cy={targetSvg[1]} r="1.1" />
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
  const [hole, setHole] = useState<CourseHoleGeometry | null>(null)
  const [ball, setBall] = useState<CoursePointYds>([0, 0])
  const [target, setTarget] = useState<CoursePointYds>([0, 220])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [evaluationError, setEvaluationError] = useState<string | null>(null)
  const [livePrepared, setLivePrepared] = useState(false)
  const [liveStatus, setLiveStatus] = useState<BrowserGsproCourseStatus>('idle')
  const [liveSnapshot, setLiveSnapshot] = useState<BrowserGsproCourseSnapshot | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [connectionVersion, setConnectionVersion] = useState(0)
  const [windMph] = useState(0)
  const [windRelativeDeg] = useState(0)
  const [show95, setShow95] = useState(false)
  const [showRiskTail, setShowRiskTail] = useState(false)
  const [showPracticeShots, setShowPracticeShots] = useState(false)
  const [inspectedAimOffset, setInspectedAimOffset] = useState<number | null>(null)
  const [armedClub, setArmedClub] = useState<string | null>(null)
  const lastShotKeyRef = useRef<string | null>(null)

  const selectedCourse = courseId === UNSELECTED_COURSE_ID ? null : getCourseCatalogEntry(courseId)

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
    setHole(null)
    if (courseId === UNSELECTED_COURSE_ID) return () => { active = false }
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
  }, [courseId, holeNumber])

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
  const surface = liveMatchesHole && liveSnapshot?.surface
    ? liveSnapshot.surface
    : hole
      ? classifyPoint(hole, ball).kind
      : 'unknown'
  const ballTerrain = hole ? estimateCourseTerrain(hole, ball) : null
  const targetTerrain = hole ? estimateCourseTerrain(hole, target) : null
  const elevationDeltaFt = ballTerrain && targetTerrain
    ? targetTerrain.elevationFt - ballTerrain.elevationFt
    : null

  const evaluations = useMemo(() => {
    if (!hole) return [] as ClubAimEvaluation[]
    try {
      const result = evaluateAimLab(sessions, hole, ball, target, {
        windMph,
        windRelativeDeg,
        elevationDeltaFt,
        elevationSource: ballTerrain && targetTerrain
          ? ballTerrain.source === 'lidar-dem' && targetTerrain.source === 'lidar-dem'
            ? `${selectedCourse?.name ?? 'Course'} direct LiDAR DEM`
            : `${selectedCourse?.name ?? 'Course'} terrain proxy`
          : 'No terrain model',
        surfaceOverride: liveMatchesHole ? liveSnapshot?.surface ?? null : null,
      })
      setEvaluationError(null)
      return result
    } catch (error) {
      setEvaluationError(error instanceof Error ? error.message : String(error))
      return [] as ClubAimEvaluation[]
    }
  }, [sessions, hole, ball, target, windMph, windRelativeDeg, elevationDeltaFt, ballTerrain, targetTerrain, liveMatchesHole, liveSnapshot?.surface, selectedCourse?.name])

  const recommendation = evaluations[0] ?? null
  const recommendedCandidate = recommendation?.bestCandidate ?? null
  const inspectedCandidate = recommendation
    ? recommendation.candidates.find((candidate) => candidate.aimOffsetYds === inspectedAimOffset)
      ?? recommendedCandidate
      ?? null
    : null
  const risk = inspectedCandidate?.riskProfile ?? null
  const aimOptions = sortedAimOptions(recommendation)
  const targetDistance = pointDistance(ball, target)

  useEffect(() => {
    setInspectedAimOffset(null)
  }, [courseId, holeNumber, recommendation?.club])

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

  const selectCourse = (nextCourseId: CourseId) => {
    setCourseId(nextCourseId)
    setHoleNumber(1)
    setLiveSnapshot(null)
    setArmedClub(null)
    lastShotKeyRef.current = null
  }

  const outcomeDetails = risk ? [
    ['Bunker', risk.bySurface.bunker ?? 0],
    ['Deep rough / woods', risk.bySurface['deep-rough'] ?? 0],
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
          <div className="live-caddie-secondary-context">
            <span>{surface}</span>
            {pinEstimate ? <span>{Math.round(pointDistance(ball, pinEstimate))} yd to pin</span> : null}
            {elevationDeltaFt != null ? <span>{signed(elevationDeltaFt, 0)} ft elevation</span> : null}
          </div>
        </section>

        {liveError ? <div className="live-caddie-alert bad">GSPro: {liveError}</div> : null}
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
            <span className="live-kicker">LOADING</span>
            <h1>{selectedCourse?.name} · Hole {holeNumber}</h1>
          </section>
        ) : (
          <>
            <section className="live-caddie-main-grid">
              <aside className="live-decision-column">
                <article className="live-decision-card">
                  <div className="live-decision-label-row">
                    <span className="live-recommended-pill">RECOMMENDED</span>
                    {inspectedCandidate && recommendedCandidate && inspectedCandidate !== recommendedCandidate ? (
                      <button className="live-reset-inspection" type="button" onClick={() => setInspectedAimOffset(null)}>
                        Viewing alternate · reset
                      </button>
                    ) : null}
                  </div>

                  <div className="live-club-hero">{recommendation?.club ?? '—'}</div>
                  <div className="live-aim-hero">{aimLabel(inspectedCandidate?.aimOffsetYds)}</div>
                  <p className="live-decision-reason">
                    {inspectedCandidate?.decisionReason ?? recommendation?.decisionReason ?? 'Looper is waiting for enough player data to rank this shot.'}
                  </p>

                  <div className="live-adjustment-stack">
                    <div>
                      <span>Air / conditions</span>
                      <strong>{recommendation ? `${signed(recommendation.airborneCarryDeltaYds)} yd` : '—'}</strong>
                      <small>{windMph ? `${windMph} mph wind` : 'wind + elevation response'}</small>
                    </div>
                    <div>
                      <span>Lie / surface</span>
                      <strong>{recommendation ? `${signed(recommendation.surfaceCarryDeltaYds)} yd` : '—'}</strong>
                      <small>{recommendation?.surfaceLabel ?? surface}</small>
                    </div>
                    <div>
                      <span>Lateral shift</span>
                      <strong>{recommendation ? `${signed(recommendation.airborneLateralDeltaYds + recommendation.surfaceLateralDeltaYds)} yd` : '—'}</strong>
                      <small>conditions + lie</small>
                    </div>
                    <div>
                      <span>Modeled carry</span>
                      <strong>{recommendation ? `${Math.round(recommendation.modeledCarryYds)} yd` : '—'}</strong>
                      <small>{recommendation ? `stock ${Math.round(recommendation.stockCarryYds)}` : `${Math.round(targetDistance)} yd target`}</small>
                    </div>
                  </div>

                  <button
                    type="button"
                    className={`live-arm-recommendation${armedClub === recommendation?.club ? ' armed' : ''}`}
                    disabled={!recommendation}
                    onClick={() => recommendation && setArmedClub(recommendation.club)}
                  >
                    {armedClub === recommendation?.club
                      ? `${recommendation?.club} ARMED FOR NEXT SHOT`
                      : recommendation
                        ? `HITTING ${recommendation.club} · TAP TO ARM`
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
                    <div className="outcome-trouble"><strong>{pct(risk?.seriousTrouble)}</strong><span>Serious trouble</span></div>
                    <div className="outcome-catastrophe"><strong>{pct(risk?.catastrophe)}</strong><span>Catastrophe</span></div>
                  </div>
                  {outcomeDetails.length ? (
                    <div className="live-outcome-details">
                      {outcomeDetails.map(([label, value]) => <span key={label}>{label} {pct(value)}</span>)}
                    </div>
                  ) : <div className="live-outcome-details"><span>No material bunker / woods / penalty probability in the current model.</span></div>}
                </article>

                {aimOptions.length > 1 ? (
                  <article className="live-compare-card">
                    <div className="live-section-heading compact">
                      <div><span className="live-kicker">COMPARE AIM</span><h2>Same club, different line</h2></div>
                    </div>
                    <div className="live-aim-options">
                      {aimOptions.map((candidate) => {
                        const isRecommended = candidate === recommendedCandidate
                        const isViewed = candidate === inspectedCandidate
                        return (
                          <button
                            type="button"
                            className={`${isViewed ? 'viewed ' : ''}${isRecommended ? 'recommended' : ''}`}
                            key={candidate.aimOffsetYds}
                            onClick={() => setInspectedAimOffset(candidate.aimOffsetYds)}
                          >
                            <strong>{aimLabel(candidate.aimOffsetYds)}</strong>
                            <span>{isRecommended ? 'Recommended' : `Rank ${candidate.decisionRank ?? '—'}`}</span>
                          </button>
                        )
                      })}
                    </div>
                  </article>
                ) : null}
              </aside>

              <article className="live-map-card">
                <div className="live-map-topbar">
                  <div>
                    <span className="live-kicker">SHOT MAP</span>
                    <h2>{recommendation ? `${recommendation.club} · ${aimLabel(inspectedCandidate?.aimOffsetYds)}` : 'Waiting for recommendation'}</h2>
                  </div>
                  <div className="live-map-toggles">
                    <button type="button" className="always-on">50 / 80%</button>
                    <button type="button" className={show95 ? 'active' : ''} onClick={() => setShow95((value) => !value)}>95%</button>
                    <button type="button" className={showPracticeShots ? 'active' : ''} onClick={() => setShowPracticeShots((value) => !value)}>
                      Practice shots{recommendation ? ` · ${recommendation.empiricalShotCount}` : ''}
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

            <section className="live-club-strip-card">
              <div className="live-club-strip-heading">
                <div>
                  <span className="live-kicker">ACTUAL CLUB</span>
                  <strong>{armedClub ? `${armedClub} armed for the next physical shot` : 'Tap the club you are actually hitting'}</strong>
                </div>
                {armedClub ? <button type="button" onClick={() => setArmedClub(null)}>Clear</button> : null}
              </div>
              <div className="live-club-strip">
                {bagClubs.map((club) => (
                  <button
                    type="button"
                    key={club}
                    className={`${armedClub === club ? 'armed ' : ''}${recommendation?.club === club ? 'recommended' : ''}`}
                    onClick={() => setArmedClub(club)}
                  >
                    <strong>{club}</strong>
                    {recommendation?.club === club ? <span>REC</span> : null}
                  </button>
                ))}
              </div>
              <p>Arming is UI-only in this first pass. The persistence + inference layer will attach this explicit selection to the next captured GSPro shot.</p>
            </section>
          </>
        )}
      </div>
    </main>
  )
}
