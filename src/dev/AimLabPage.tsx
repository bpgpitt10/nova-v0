import { useEffect, useMemo, useRef, useState } from 'react'
import {
  connectBrowserGsproCourseStateFolder,
  connectToBrowserGsproCourseState,
  prepareBrowserGsproCourseStateRuntime,
  type BrowserGsproCourseSnapshot,
  type BrowserGsproCourseStatus,
} from '../adapters/browserGsproCourseState'
import { getCurrentLooperUser } from '../cloud/supabaseClient'
import {
  courseCatalog,
  getCourseCatalogEntry,
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
  AIM_SCORE_ASSUMPTIONS,
  evaluateAimLab,
  type ClubAimEvaluation,
} from '../liveCaddie/aimOptimization'
import {
  loadSavedSessions,
  SESSION_HISTORY_UPDATED_EVENT,
} from '../lib/sessions'
import type { SavedSession } from '../types'
import './aimLab.css'

const pct = (value: number | null | undefined) => {
  if (typeof value !== 'number') return '—'
  const percentage = value * 100
  if (percentage === 0) return '0%'
  if (percentage < 5) return `${percentage.toFixed(1)}%`
  return `${Math.round(percentage)}%`
}

const signedYds = (value: number | null | undefined) =>
  typeof value === 'number' ? `${value >= 0 ? '+' : ''}${value.toFixed(1)} yd` : '—'

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

type LastShotReview = {
  shotKey: string
  holeNumber: number
  actualStart: CoursePointYds | null
  actualLanding: CoursePointYds | null
  actualSurface: string | null
  recommendedClub: string | null
  recommendedAimYds: number | null
  expectedLanding: CoursePointYds | null
}

type AimLabMode = 'manual' | 'live'
const AIM_LAB_MODE_STORAGE_KEY = 'looper.aim-lab.mode.v1'

const loadAimLabMode = (): AimLabMode => {
  if (typeof window === 'undefined') return 'manual'
  try {
    return window.localStorage.getItem(AIM_LAB_MODE_STORAGE_KEY) === 'live' ? 'live' : 'manual'
  } catch {
    return 'manual'
  }
}

const saveAimLabMode = (mode: AimLabMode) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(AIM_LAB_MODE_STORAGE_KEY, mode)
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

function AimMap({
  hole,
  ball,
  target,
  pinEstimate,
  selected,
  lastShot,
  editMode,
  interactive,
  show95Core,
  showFullRisk,
  showModeledLandings,
  showHistoricalLandings,
  onSetPoint,
}: {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  pinEstimate: CoursePointYds | null
  selected: ClubAimEvaluation | null
  lastShot: LastShotReview | null
  editMode: 'ball' | 'target'
  interactive: boolean
  show95Core: boolean
  showFullRisk: boolean
  showModeledLandings: boolean
  showHistoricalLandings: boolean
  onSetPoint: (point: CoursePointYds) => void
}) {
  const viewSize = 100
  const pad = 4
  const displayBounds = {
    minX: hole.bounds.minX,
    maxX: hole.bounds.maxX,
    minY: Math.max(hole.bounds.minY, -28),
    maxY: hole.bounds.maxY,
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
  const unproject = (x: number, y: number): CoursePointYds => [
    displayBounds.minX + (x - offsetX) / scale,
    displayBounds.minY + (viewSize - y - offsetY) / scale,
  ]

  const ballSvg = project(ball)
  const targetSvg = project(target)
  const pinSvg = pinEstimate ? project(pinEstimate) : null
  const best = selected?.bestCandidate ?? null
  const aimSvg = best ? project(best.aimPoint) : null
  const meanSvg = best ? project(best.meanLanding) : null
  const actualStartSvg = lastShot?.actualStart ? project(lastShot.actualStart) : null
  const actualLandingSvg = lastShot?.actualLanding ? project(lastShot.actualLanding) : null
  const priorExpectedSvg = lastShot?.expectedLanding ? project(lastShot.expectedLanding) : null
  const modeledSampleSvgs = best?.modeledSamples.map((sample) => ({
    ...sample,
    svg: project(sample.landing),
  })) ?? []
  const historicalSampleSvgs = best?.empiricalAllShots?.samples.map((sample) => ({
    ...sample,
    svg: project(sample.landing),
  })) ?? []
  const riskTailSvgs = best?.riskProfile?.tailLandings.map((sample) => ({
    ...sample,
    svg: project(sample.landing),
  })) ?? []

  const onClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!interactive) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * viewSize
    const y = ((event.clientY - rect.top) / rect.height) * viewSize
    onSetPoint(unproject(x, y))
  }

  const shotDx = (aimSvg?.[0] ?? targetSvg[0]) - ballSvg[0]
  const shotDy = (aimSvg?.[1] ?? targetSvg[1]) - ballSvg[1]
  const shotAngle = (Math.atan2(shotDy, shotDx) * 180) / Math.PI + 90
  const hasWoods = hole.contextLayers?.some((layer) => layer.kind === 'woods') ?? false
  const hasContours = (hole.contours?.length ?? 0) > 0
  const historicalAverageWeight = historicalSampleSvgs.length > 0 ? 1 / historicalSampleSvgs.length : 1
  const tailAverageWeight = best?.riskProfile && riskTailSvgs.length > 0
    ? best.riskProfile.tailProbability / riskTailSvgs.length
    : 1
  const visibleProbabilityContours = best?.probabilityContours.filter(
    (contour) => contour.probability !== 0.95 || show95Core,
  ) ?? []

  return (
    <div className="aim-map-shell">
      <svg
        className={`aim-map edit-${editMode}${interactive ? '' : ' live-locked'}`}
        viewBox={`0 0 ${viewSize} ${viewSize}`}
        onClick={onClick}
      >
        <defs>
          <pattern id="aimWoodsCanopyPattern" width="5.2" height="5.2" patternUnits="userSpaceOnUse">
            <rect width="5.2" height="5.2" fill="#173d29" fillOpacity="0.2" />
            <circle cx="1" cy="1.4" r="0.9" fill="#6f9962" fillOpacity="0.16" />
            <circle cx="3.4" cy="1" r="1.15" fill="#4f7a4b" fillOpacity="0.14" />
            <circle cx="2.5" cy="3.7" r="1.25" fill="#7ba06b" fillOpacity="0.12" />
            <circle cx="5" cy="4" r="1" fill="#3e6842" fillOpacity="0.16" />
          </pattern>
          <pattern id="aimScrubTexturePattern" width="4.4" height="4.4" patternUnits="userSpaceOnUse">
            <rect width="4.4" height="4.4" fill="#4d4a2d" fillOpacity="0.16" />
            <circle cx="1" cy="1.2" r="0.58" fill="#b5a967" fillOpacity="0.16" />
            <circle cx="3.2" cy="3" r="0.68" fill="#8c854f" fillOpacity="0.15" />
          </pattern>
        </defs>
        {hole.contextLayers?.flatMap((layer) =>
          layer.polygons.map((polygon, index) => (
            <polygon
              key={`${layer.id}-${index}`}
              className={`aim-context context-${layer.kind}`}
              points={polygon.map((point) => project(point).join(',')).join(' ')}
            />
          )),
        )}
        {hole.contours?.map((contour, index) => (
          <polyline
            key={`terrain-contour-${contour.elevationFt}-${index}`}
            className="terrain-contour"
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
                  className={`aim-surface surface-${kind}`}
                  points={polygon.map((point) => project(point).join(',')).join(' ')}
                />
              )),
            ),
        )}
        {actualStartSvg && actualLandingSvg && (
          <line
            className="actual-shot-line"
            x1={actualStartSvg[0]}
            y1={actualStartSvg[1]}
            x2={actualLandingSvg[0]}
            y2={actualLandingSvg[1]}
          />
        )}
        <line className="aim-line" x1={ballSvg[0]} y1={ballSvg[1]} x2={targetSvg[0]} y2={targetSvg[1]} />
        {best && aimSvg && meanSvg && (
          <>
            <line className="aim-line candidate" x1={ballSvg[0]} y1={ballSvg[1]} x2={aimSvg[0]} y2={aimSvg[1]} />
            {[...visibleProbabilityContours].reverse().map((contour) => (
              <ellipse
                key={`probability-${contour.probability}`}
                className={`probability-contour probability-${Math.round(contour.probability * 100)}`}
                cx={meanSvg[0]}
                cy={meanSvg[1]}
                rx={Math.max(0.4, contour.lateralRadiusYds * scale)}
                ry={Math.max(0.4, contour.carryRadiusYds * scale)}
                transform={`rotate(${shotAngle} ${meanSvg[0]} ${meanSvg[1]})`}
              />
            ))}
            {showFullRisk && riskTailSvgs.map((sample, index) => (
              <circle
                key={`risk-tail-${index}`}
                className={`risk-tail-landing risk-${sample.tier}`}
                cx={sample.svg[0]}
                cy={sample.svg[1]}
                r={Math.max(0.28, Math.min(0.72, 0.38 * Math.sqrt(sample.weight / Math.max(1e-9, tailAverageWeight))))}
              />
            ))}
            {showModeledLandings && modeledSampleSvgs.map((sample, index) => (
              <circle
                key={`modeled-sample-${index}`}
                className={`modeled-landing-sample sample-${sample.kind}`}
                cx={sample.svg[0]}
                cy={sample.svg[1]}
                r="0.16"
              />
            ))}
            {showHistoricalLandings && historicalSampleSvgs.map((sample, index) => (
              <circle
                key={`historical-sample-${index}`}
                className={`historical-landing-sample sample-${sample.kind}`}
                cx={sample.svg[0]}
                cy={sample.svg[1]}
                r={Math.max(0.25, Math.min(0.62, 0.34 * Math.sqrt(sample.weight / historicalAverageWeight)))}
              />
            ))}
            <circle className="mean-marker" cx={meanSvg[0]} cy={meanSvg[1]} r="1.1" />
            <circle className="aim-marker" cx={aimSvg[0]} cy={aimSvg[1]} r="0.9" />
          </>
        )}
        {priorExpectedSvg && (
          <circle className="prior-expected-marker" cx={priorExpectedSvg[0]} cy={priorExpectedSvg[1]} r="1.25" />
        )}
        {actualLandingSvg && (
          <circle className="actual-landing-marker" cx={actualLandingSvg[0]} cy={actualLandingSvg[1]} r="1.35" />
        )}
        {pinSvg && <circle className="pin-marker" cx={pinSvg[0]} cy={pinSvg[1]} r="0.8" />}
        <circle className="target-marker" cx={targetSvg[0]} cy={targetSvg[1]} r="1.2" />
        <circle className="ball-marker" cx={ballSvg[0]} cy={ballSvg[1]} r="1.25" />
      </svg>
      <div className="aim-map-legend">
        <span><i className="legend-dot ball" /> Ball</span>
        <span><i className="legend-dot target" /> Landing target</span>
        <span><i className="legend-dot pin" /> Pin estimate</span>
        <span><i className="legend-dot aim" /> Aim point</span>
        <span><i className="legend-dot mean" /> Expected center</span>
        {best && <span><i className="legend-line probability" /> 50 / 80% core{show95Core ? ' / 95%' : ''}</span>}
        {showFullRisk && riskTailSvgs.length > 0 && <span><i className="legend-dot risk-tail" /> Full-risk tail</span>}
        {hasWoods && <span><i className="legend-dot woods" /> Woods</span>}
        {hasContours && <span><i className="legend-line contour" /> Topo</span>}
        {lastShot?.actualLanding && <span><i className="legend-dot actual" /> Last actual</span>}
        {lastShot?.expectedLanding && <span><i className="legend-dot prior" /> Last expected</span>}
      </div>
    </div>
  )
}

function AimLabPage() {
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadSavedSessions())
  const [playerEmail, setPlayerEmail] = useState<string | null>(null)
  const [courseId, setCourseId] = useState<CourseId>(() => loadLastSelectedCourseId())
  const [holeNumber, setHoleNumber] = useState(1)
  const [hole, setHole] = useState<CourseHoleGeometry | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [ball, setBall] = useState<CoursePointYds>([0, 0])
  const [target, setTarget] = useState<CoursePointYds>([0, 220])
  const [editMode, setEditMode] = useState<'ball' | 'target'>('target')
  const [selectedClub, setSelectedClub] = useState<string | null>(null)
  const [windMph, setWindMph] = useState(0)
  const [windRelativeDeg, setWindRelativeDeg] = useState(0)
  const [uphillLieDeg, setUphillLieDeg] = useState(0)
  const [sidehillLieDeg, setSidehillLieDeg] = useState(0)
  const [mode, setMode] = useState<AimLabMode>(() => loadAimLabMode())
  const [livePrepared, setLivePrepared] = useState(false)
  const [liveStatus, setLiveStatus] = useState<BrowserGsproCourseStatus>('idle')
  const [liveSnapshot, setLiveSnapshot] = useState<BrowserGsproCourseSnapshot | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [liveConnectionVersion, setLiveConnectionVersion] = useState(0)
  const [lastShotReview, setLastShotReview] = useState<LastShotReview | null>(null)
  const [show95Core, setShow95Core] = useState(false)
  const [showFullRisk, setShowFullRisk] = useState(false)
  const [showModeledLandings, setShowModeledLandings] = useState(false)
  const [showHistoricalLandings, setShowHistoricalLandings] = useState(false)

  const selectedCourse = getCourseCatalogEntry(courseId)
  const selectedRef = useRef<ClubAimEvaluation | null>(null)
  const recommendationHoleRef = useRef(1)
  const lastProcessedShotKeyRef = useRef<string | null>(null)

  useEffect(() => {
    void getCurrentLooperUser().then((user) => setPlayerEmail(user?.email ?? null)).catch(() => {})
    const refresh = () => setSessions(loadSavedSessions())
    window.addEventListener(SESSION_HISTORY_UPDATED_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(SESSION_HISTORY_UPDATED_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  useEffect(() => {
    saveAimLabMode(mode)
  }, [mode])

  useEffect(() => {
    saveLastSelectedCourseId(courseId)
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
    if (mode !== 'live' || !livePrepared) return
    setLiveError(null)
    setLiveSnapshot(null)
    setLastShotReview(null)
    lastProcessedShotKeyRef.current = null

    const connection = connectToBrowserGsproCourseState({
      onStatusChange: setLiveStatus,
      onError: (error) => setLiveError(error instanceof Error ? error.message : String(error)),
      onSnapshot: (snapshot) => {
        setLiveError(null)
        setLiveSnapshot(snapshot)
        if (snapshot.holeNumber && snapshot.holeNumber !== recommendationHoleRef.current) {
          setHoleNumber(snapshot.holeNumber)
        }

        const shotKey = snapshot.latestShotKey
        if (!shotKey) return
        if (lastProcessedShotKeyRef.current == null) {
          lastProcessedShotKeyRef.current = shotKey
          return
        }
        if (lastProcessedShotKeyRef.current === shotKey) return

        const shot = snapshot.latestShot
        const recommendation = selectedRef.current
        setLastShotReview({
          shotKey,
          holeNumber: shot?.holeNumber ?? snapshot.holeNumber ?? recommendationHoleRef.current,
          actualStart: shot?.startLocalYds ?? null,
          actualLanding: shot?.endLocalYds ?? null,
          actualSurface: shot?.endingSurface ?? null,
          recommendedClub:
            recommendation && recommendationHoleRef.current === shot?.holeNumber
              ? recommendation.club
              : null,
          recommendedAimYds:
            recommendation && recommendationHoleRef.current === shot?.holeNumber
              ? recommendation.bestCandidate?.aimOffsetYds ?? null
              : null,
          expectedLanding:
            recommendation && recommendationHoleRef.current === shot?.holeNumber
              ? recommendation.bestCandidate?.meanLanding ?? null
              : null,
        })
        lastProcessedShotKeyRef.current = shotKey
      },
    })
    return () => connection.disconnect()
  }, [mode, livePrepared, liveConnectionVersion, courseId])

  useEffect(() => {
    let active = true
    setLoadError(null)
    setHole(null)
    void loadCourseHoleGeometry(courseId, holeNumber)
      .then((loaded) => {
        if (!active) return
        setHole(loaded)
        setBall(loaded.markers.tee)
        setTarget(defaultTarget(loaded))
        setEditMode('target')
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
    if (mode !== 'live' || !hole || !liveSnapshot || liveSnapshot.holeNumber !== hole.holeNumber) return
    const nextBall = liveSnapshot.ballLocalYds
      ?? (liveSnapshot.ballSource === 'cached-tee' ? hole.markers.tee : null)
    if (!nextBall) return
    const nextPin = estimatePinFromGsproDistance(hole, nextBall, liveSnapshot.distanceToPinYds)
    setBall(nextBall)
    setTarget(chooseLiveLandingTarget(hole, nextBall, nextPin))
    setEditMode('target')
  }, [mode, hole, liveSnapshot])

  const targetDistance = pointDistance(ball, target)
  const mapBallSurface = hole ? classifyPoint(hole, ball) : null
  const liveMatchesHole = mode === 'live' && liveSnapshot?.holeNumber === holeNumber
  const livePositionUnavailable = Boolean(
    liveMatchesHole
    && liveSnapshot?.latestShot
    && liveSnapshot.ballSource === 'unavailable',
  )
  const activeSurface = liveMatchesHole && liveSnapshot?.surface
    ? liveSnapshot.surface
    : mapBallSurface?.kind ?? 'unknown'
  const surfaceSource = liveMatchesHole && liveSnapshot?.surface
    ? 'GSPro currentRound'
    : 'Cached course geometry'
  const pinEstimate = hole
    ? estimatePinFromGsproDistance(
        hole,
        ball,
        liveMatchesHole ? liveSnapshot?.distanceToPinYds ?? null : null,
      )
    : null
  const pinSource = liveMatchesHole && liveSnapshot?.distanceToPinYds != null
    ? 'GSPro distance + cached green direction'
    : 'Cached green centroid'

  const ballTerrain = hole ? estimateCourseTerrain(hole, ball) : null
  const targetTerrain = hole ? estimateCourseTerrain(hole, target) : null
  const targetElevationDelta =
    ballTerrain && targetTerrain
      ? targetTerrain.elevationFt - ballTerrain.elevationFt
      : null

  const evaluationResult = useMemo(() => {
    if (!hole) return { evaluations: [] as ClubAimEvaluation[], error: null as string | null }
    if (livePositionUnavailable) {
      return {
        evaluations: [] as ClubAimEvaluation[],
        error: `Live ball coordinates are not registered for ${selectedCourse.name} yet. Shot ingestion remains active, but Looper will not issue a recommendation from a stale ball position.`,
      }
    }
    try {
      return {
        evaluations: evaluateAimLab(sessions, hole, ball, target, {
          windMph,
          windRelativeDeg,
          elevationDeltaFt: targetElevationDelta,
          elevationSource: ballTerrain && targetTerrain
            ? ballTerrain.source === 'lidar-dem' && targetTerrain.source === 'lidar-dem'
              ? `${selectedCourse.name} direct LiDAR DEM`
              : `${selectedCourse.name} LiDAR contour proxy`
            : 'No elevation model for this hole yet',
          surfaceOverride: liveMatchesHole ? liveSnapshot?.surface ?? null : null,
        }),
        error: null as string | null,
      }
    } catch (error) {
      console.error('[Aim Lab] recommendation evaluation failed; live tracking remains active', error)
      return {
        evaluations: [] as ClubAimEvaluation[],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [sessions, hole, holeNumber, ball, target, windMph, windRelativeDeg, targetElevationDelta, liveMatchesHole, livePositionUnavailable, liveSnapshot?.surface, selectedCourse.name])

  const evaluations = evaluationResult.evaluations
  const evaluationError = evaluationResult.error

  useEffect(() => {
    if (evaluations.length === 0) {
      setSelectedClub(null)
      return
    }
    if (!selectedClub || !evaluations.some((item) => item.club === selectedClub)) {
      setSelectedClub(evaluations[0].club)
    }
  }, [evaluations, selectedClub])

  const selected = evaluations.find((item) => item.club === selectedClub) ?? evaluations[0] ?? null
  const selectedRisk = selected?.bestCandidate?.riskProfile ?? null

  useEffect(() => {
    selectedRef.current = selected
    recommendationHoleRef.current = holeNumber
  }, [selected, holeNumber])

  const connectLiveState = async () => {
    setLiveError(null)
    try {
      await connectBrowserGsproCourseStateFolder()
      setLivePrepared(true)
      setLiveSnapshot(null)
      setLastShotReview(null)
      setMode('live')
      setLiveConnectionVersion((value) => value + 1)
      lastProcessedShotKeyRef.current = null
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : String(error))
    }
  }

  const selectCourse = (nextCourseId: CourseId) => {
    if (nextCourseId === courseId) return
    setCourseId(nextCourseId)
    setHoleNumber(1)
    setLiveSnapshot(null)
    setLastShotReview(null)
    lastProcessedShotKeyRef.current = null
  }

  const resetTee = () => {
    if (!hole || mode === 'live') return
    setBall(hole.markers.tee)
    setTarget(defaultTarget(hole))
    setEditMode('target')
  }

  const targetGreen = () => {
    if (!hole?.markers.pin || mode === 'live') return
    setTarget(hole.markers.pin)
    setEditMode('target')
  }

  const visibleLastShot = lastShotReview?.holeNumber === holeNumber ? lastShotReview : null

  return (
    <main className="aim-lab-page">
      <header className="aim-lab-header">
        <div>
          <p className="aim-eyebrow">LOOPER · PLAYABLE CADDIE SANDBOX</p>
          <h1>{selectedCourse.name} decision inspector</h1>
          <p>Cached course geometry + live GSPro state + player-specific shot model.</p>
        </div>
        <div className="aim-round-status">
          <strong>{playerEmail ?? 'Signed-in player'}</strong>
          <span>{sessions.length} sessions · {sessions.reduce((sum, session) => sum + session.shots.length, 0)} shots</span>
          <span className={`live-status ${mode === 'live' ? liveStatus : 'manual'}`}>{mode === 'live' ? `GSPro ${liveStatus}` : 'Manual sandbox'}</span>
        </div>
      </header>

      <section className="aim-toolbar">
        <label>
          Playing
          <select
            value={courseId}
            onChange={(event) => selectCourse(event.target.value as CourseId)}
          >
            {courseCatalog.map((entry) => (
              <option value={entry.id} key={entry.id}>{entry.name} · {entry.location}</option>
            ))}
          </select>
        </label>
        <button type="button" className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>Manual</button>
        <button
          type="button"
          className={mode === 'live' ? 'active' : ''}
          onClick={() => {
            if (livePrepared) setMode('live')
            else void connectLiveState()
          }}
        >GSPro Live</button>
        {!livePrepared && <button type="button" onClick={() => void connectLiveState()}>Connect GSPro state folder</button>}
        {mode === 'live' && liveStatus === 'error' && <button type="button" onClick={() => void connectLiveState()}>Reconnect / choose folder</button>}
        <label>
          Hole
          <select value={holeNumber} disabled={mode === 'live'} onChange={(event) => setHoleNumber(Number(event.target.value))}>
            {Array.from({ length: 18 }, (_, index) => index + 1).map((number) => <option value={number} key={number}>#{number}</option>)}
          </select>
        </label>
        <button type="button" onClick={resetTee} disabled={!hole || mode === 'live'}>Reset to tee</button>
        <button type="button" onClick={targetGreen} disabled={!hole?.markers.pin || mode === 'live'}>Target green</button>
        <button type="button" disabled={mode === 'live'} className={editMode === 'ball' ? 'active' : ''} onClick={() => setEditMode('ball')}>Click map: set ball</button>
        <button type="button" disabled={mode === 'live'} className={editMode === 'target' ? 'active' : ''} onClick={() => setEditMode('target')}>Click map: set target</button>
        <div className="aim-toolbar-reading"><span>Selected landing distance</span><strong>{targetDistance.toFixed(1)} yd</strong></div>
      </section>

      {liveError && <div className="aim-alert bad">GSPro Live: {liveError} · Looper will keep retrying; this does not interrupt GSPro play.</div>}
      {mode === 'live' && liveSnapshot?.warnings.map((warning) => <div className="aim-alert" key={warning}>{warning}</div>)}
      {loadError && <div className="aim-alert bad">{selectedCourse.name} Hole {holeNumber} map unavailable: {loadError} · live tracking stays connected and the next hole can load independently.</div>}
      {evaluationError && <div className="aim-alert bad">Recommendation engine paused for this state: {evaluationError} · live tracking and hole changes are still running.</div>}
      {!hole && !loadError && <div className="aim-alert">Loading {selectedCourse.name} Hole {holeNumber}…</div>}

      {hole && (
        <>
          <section className="aim-top-grid">
            <article className="aim-card map-card">
              <div className="aim-card-heading">
                <div><span>COURSE</span><h2>Hole {hole.holeNumber} geometry</h2></div>
                <small>{mode === 'live' ? (livePositionUnavailable ? 'GSPro shot received · live ball registration unavailable' : 'Ball follows GSPro automatically') : editMode === 'ball' ? 'Click to move ball' : 'Click to move landing target'}</small>
              </div>
              <AimMap
                hole={hole}
                ball={ball}
                target={target}
                pinEstimate={pinEstimate}
                selected={selected}
                lastShot={visibleLastShot}
                editMode={editMode}
                interactive={mode === 'manual'}
                show95Core={show95Core}
                showFullRisk={showFullRisk}
                showModeledLandings={showModeledLandings}
                showHistoricalLandings={showHistoricalLandings}
                onSetPoint={(point) => {
                  if (editMode === 'ball') setBall(point)
                  else setTarget(point)
                }}
              />
              <div className="aim-map-debug-controls">
                <label><input type="checkbox" checked={show95Core} onChange={(event) => setShow95Core(event.target.checked)} />Show 95% core contour</label>
                <label>
                  <input type="checkbox" checked={showFullRisk} onChange={(event) => setShowFullRisk(event.target.checked)} />
                  Show full-risk tail {selectedRisk ? `(${pct(selectedRisk.tailProbability)}, n=${selectedRisk.tailSampleCount})` : ''}
                </label>
                <label>
                  <input type="checkbox" checked={showModeledLandings} onChange={(event) => setShowModeledLandings(event.target.checked)} />
                  Show modeled landing dots {selected ? `(${selected.modeledSampleCount.toLocaleString()})` : ''}
                </label>
                <label>
                  <input type="checkbox" checked={showHistoricalLandings} onChange={(event) => setShowHistoricalLandings(event.target.checked)} />
                  Show observed Stock replay {selected ? `(n=${selected.empiricalShotCount})` : ''}
                </label>
                <small>50/80% describe the normal core. Full risk adds the learned planning-excluded tail. The recommendation still uses the old V0 core score for now.</small>
              </div>
            </article>

            <article className="aim-card state-card">
              <div className="aim-card-heading"><div><span>SHOT STATE</span><h2>What Looper knows right now</h2></div></div>
              <div className="state-grid">
                <div><span>Ball</span><strong>{ball[0].toFixed(1)} R / {ball[1].toFixed(1)} F</strong><small>{liveMatchesHole ? liveSnapshot?.ballSource : 'manual'}</small></div>
                <div><span>Landing target</span><strong>{target[0].toFixed(1)} R / {target[1].toFixed(1)} F</strong><small>{mode === 'live' ? 'auto tactical target' : 'manual'}</small></div>
                <div><span>Distance</span><strong>{targetDistance.toFixed(1)} yd</strong></div>
                <div><span>Surface</span><strong>{activeSurface}</strong><small>{surfaceSource}</small></div>
                <div><span>Pin estimate</span><strong>{pinEstimate ? `${pointDistance(ball, pinEstimate).toFixed(1)} yd` : '—'}</strong><small>{pinSource}</small></div>
                <div><span>Live shot</span><strong>{liveMatchesHole ? liveSnapshot?.latestShot?.holeShot ?? 'tee' : '—'}</strong><small>{liveMatchesHole ? liveSnapshot?.latestShotKey ?? 'waiting for first shot' : 'manual'}</small></div>
              </div>
              <div className="manual-context-grid">
                <label>Wind mph<input type="number" value={windMph} onChange={(event) => setWindMph(Number(event.target.value))} /></label>
                <label>Wind relative °<input type="number" value={windRelativeDeg} onChange={(event) => setWindRelativeDeg(Number(event.target.value))} /></label>
                <label>Uphill lie °<input type="number" value={uphillLieDeg} onChange={(event) => setUphillLieDeg(Number(event.target.value))} /></label>
                <label>Sidehill lie °<input type="number" value={sidehillLieDeg} onChange={(event) => setSidehillLieDeg(Number(event.target.value))} /></label>
              </div>
              <p className="aim-note">Wind, elevation and supported GSPro surface penalties are operative. Physical lie angles remain visible-only until the controlled identical-launch-packet test establishes GSPro’s slope response.</p>
              {visibleLastShot && (
                <div className="last-shot-card">
                  <span>LAST SHOT</span>
                  <strong>{visibleLastShot.recommendedClub ?? 'Recommendation unavailable'} {visibleLastShot.recommendedAimYds == null ? '' : `· aim ${signedYds(visibleLastShot.recommendedAimYds)}`}</strong>
                  <small>Actual: {visibleLastShot.actualLanding ? `${visibleLastShot.actualLanding[0].toFixed(1)} R / ${visibleLastShot.actualLanding[1].toFixed(1)} F` : '—'} · {visibleLastShot.actualSurface ?? 'surface unknown'}</small>
                </div>
              )}
            </article>
          </section>

          <section className="aim-card">
            <div className="aim-card-heading"><div><span>FACTOR STACK</span><h2>Value → effect → source → confidence</h2></div></div>
            <div className="aim-table-wrap">
              <table className="aim-table factor-table">
                <thead><tr><th>Factor</th><th>Raw value</th><th>Current model effect</th><th>Source</th><th>Status</th></tr></thead>
                <tbody>
                  <tr><td>Player Stock</td><td>{selected ? `${selected.club} · ${selected.stockCarryYds.toFixed(1)} yd` : '—'}</td><td>Measured baseline carry + 2D dispersion</td><td>Looper history</td><td><b className="status modeled">MODELED</b></td></tr>
                  <tr><td>Modeled landing sample</td><td>{selected ? selected.modeledSampleCount.toLocaleString() : '—'} deterministic landings</td><td>One canonical core cloud drives map contours, core percentages and V0 score</td><td>Player Stock distribution × current context</td><td><b className="status modeled">MODELED</b></td></tr>
                  <tr><td>Course geometry</td><td>{selectedCourse.name} H{holeNumber}</td><td>Every landing is classified against playable surfaces + woods/scrub context</td><td>Canonical cached course package</td><td><b className="status modeled">MODELED</b></td></tr>
                  <tr><td>Live ball position</td><td>{mode === 'live' ? (livePositionUnavailable ? 'Unavailable' : `${ball[0].toFixed(1)} R / ${ball[1].toFixed(1)} F`) : 'Manual'}</td><td>Moves shot origin and recalculates every candidate</td><td>{liveMatchesHole ? liveSnapshot?.ballSource ?? 'unavailable' : 'manual'}</td><td><b className={liveMatchesHole && !livePositionUnavailable ? 'status modeled' : 'status review'}>{liveMatchesHole && !livePositionUnavailable ? 'MODELED' : mode === 'live' ? 'UNAVAILABLE' : 'MANUAL'}</b></td></tr>
                  <tr><td>Elevation</td><td>{targetElevationDelta == null ? 'Unavailable' : `${targetElevationDelta >= 0 ? '+' : ''}${targetElevationDelta.toFixed(1)} ft to selected target`}</td><td>{targetElevationDelta == null ? 'No flight adjustment' : `${signedYds(selected?.airborneCarryDeltaYds)} combined wind/elevation carry delta`}</td><td>{ballTerrain && targetTerrain ? (ballTerrain.source === 'lidar-dem' && targetTerrain.source === 'lidar-dem' ? 'LiDAR DEM' : 'LiDAR contour proxy') : 'No terrain model'}</td><td>{targetElevationDelta == null ? <b className="status review">UNAVAILABLE</b> : <b className="status modeled">PROVISIONAL</b>}</td></tr>
                  <tr><td>Wind</td><td>{windMph} mph @ {windRelativeDeg}°</td><td>{selected ? `${signedYds(selected.airborneCarryDeltaYds)} carry · ${signedYds(selected.airborneLateralDeltaYds)} lateral (combined with elevation)` : '—'}</td><td>Manual now / live sensor later</td><td><b className="status modeled">PROVISIONAL</b></td></tr>
                  <tr><td>Surface</td><td>{activeSurface}</td><td>{selected ? `${selected.surfaceLabel} · ${signedYds(selected.surfaceCarryDeltaYds)} carry · ${signedYds(selected.surfaceLateralDeltaYds)} lateral` : '—'}</td><td>{surfaceSource}</td><td><b className="status modeled">MODELED</b></td></tr>
                  <tr><td>Uphill/downhill lie</td><td>{uphillLieDeg}°</td><td>No launch/carry change yet</td><td>Manual / live lie sensor later</td><td><b className="status pending">NOT MODELED</b></td></tr>
                  <tr><td>Ball above/below feet</td><td>{sidehillLieDeg}°</td><td>No start-line/curvature change yet</td><td>Manual / live lie sensor later</td><td><b className="status pending">NOT MODELED</b></td></tr>
                  <tr>
                    <td>Mishit / tail frequency</td>
                    <td>{selectedRisk ? `${pct(selectedRisk.mishitProbability)} mishit · ${pct(selectedRisk.tailProbability)} planning-excluded tail` : '—'}</td>
                    <td>Tail is mixed into the full-risk outcome profile; shot quality itself is not an outcome penalty</td>
                    <td>Looper weighted Stock history</td>
                    <td><b className="status review">RISK ONLY</b></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="aim-card">
            <div className="aim-card-heading">
              <div><span>SHOT CANDIDATES</span><h2>Your profile against this landing target</h2></div>
              <small>Click a club to inspect all 11 lateral aim candidates.</small>
            </div>
            <div className="aim-table-wrap">
              <table className="aim-table candidate-table">
                <thead><tr><th>Club</th><th>Stock</th><th>Air Δ</th><th>Surface Δ</th><th>Planned</th><th>Carry gap</th><th>Best aim</th><th>Preferred</th><th>Rough</th><th>Trouble</th><th>Penalty</th><th>Unknown</th><th>Score</th><th>Support</th></tr></thead>
                <tbody>
                  {evaluations.slice(0, 8).map((item) => {
                    const best = item.bestCandidate
                    const outcomes = best?.surfaceOutcomes
                    return (
                      <tr key={item.club} className={selected?.club === item.club ? 'selected' : ''} onClick={() => setSelectedClub(item.club)}>
                        <td><strong>{item.club}</strong></td>
                        <td>{item.stockCarryYds.toFixed(1)} yd</td>
                        <td>{signedYds(item.airborneCarryDeltaYds)}</td>
                        <td>{signedYds(item.surfaceCarryDeltaYds)}</td>
                        <td>{item.modeledCarryYds.toFixed(1)} yd</td>
                        <td>{signedYds(item.carryGapYds)}</td>
                        <td>{signedYds(best?.aimOffsetYds)}</td>
                        <td>{pct(outcomes?.preferred)}</td>
                        <td>{pct(outcomes?.rough)}</td>
                        <td>{pct(outcomes?.trouble)}</td>
                        <td>{pct(outcomes?.penalty)}</td>
                        <td>{pct(outcomes?.unknown)}</td>
                        <td>{best?.score == null ? '—' : best.score.toFixed(1)}</td>
                        <td>{item.supportShots} shots</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {selected && (
            <section className="aim-two-column">
              <article className="aim-card">
                <div className="aim-card-heading">
                  <div><span>AIM SWEEP · {selected.club.toUpperCase()}</span><h2>Core probability vs observed Stock replay</h2></div>
                  <small>V0-selected best highlighted · core n={selected.modeledSampleCount.toLocaleString()} · history n={selected.empiricalShotCount}</small>
                </div>
                <div className="aim-table-wrap">
                  <table className="aim-table aim-sweep-table">
                    <thead><tr><th>Aim</th><th>Core pref.</th><th>Hist. pref.</th><th>Core rough</th><th>Hist. rough</th><th>Core trouble</th><th>Hist. trouble</th><th>Core penalty</th><th>Hist. penalty</th><th>Core unknown</th><th>Hist. unknown</th><th>Δ elev</th><th>V0 score</th></tr></thead>
                    <tbody>
                      {selected.candidates.map((candidate) => {
                        const landingTerrain = estimateCourseTerrain(hole, candidate.meanLanding)
                        const elevationDelta = ballTerrain && landingTerrain ? landingTerrain.elevationFt - ballTerrain.elevationFt : null
                        return (
                          <tr key={candidate.aimOffsetYds} className={candidate === selected.bestCandidate ? 'best' : ''}>
                            <td><strong>{signedYds(candidate.aimOffsetYds)}</strong></td>
                            <td>{pct(candidate.surfaceOutcomes?.preferred)}</td>
                            <td>{pct(candidate.empiricalAllShots?.preferred)}</td>
                            <td>{pct(candidate.surfaceOutcomes?.rough)}</td>
                            <td>{pct(candidate.empiricalAllShots?.rough)}</td>
                            <td>{pct(candidate.surfaceOutcomes?.trouble)}</td>
                            <td>{pct(candidate.empiricalAllShots?.trouble)}</td>
                            <td>{pct(candidate.surfaceOutcomes?.penalty)}</td>
                            <td>{pct(candidate.empiricalAllShots?.penalty)}</td>
                            <td>{pct(candidate.surfaceOutcomes?.unknown)}</td>
                            <td>{pct(candidate.empiricalAllShots?.unknown)}</td>
                            <td>{elevationDelta == null ? '—' : `${elevationDelta >= 0 ? '+' : ''}${elevationDelta.toFixed(1)} ft`}</td>
                            <td>{candidate.score == null ? '—' : candidate.score.toFixed(1)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="aim-card assumptions-card">
                <div className="aim-card-heading"><div><span>SCORING ASSUMPTIONS</span><h2>V0 is intentionally simple</h2></div></div>
                <div className="score-formula">
                  <code>score = preferred×{AIM_SCORE_ASSUMPTIONS.preferredWeight} + non-penalty-trouble×({AIM_SCORE_ASSUMPTIONS.nonPenaltyTroubleWeight}) + penalty×({AIM_SCORE_ASSUMPTIONS.penaltyWeight}) + unknown×({AIM_SCORE_ASSUMPTIONS.unknownWeight}) + |carry gap|×({AIM_SCORE_ASSUMPTIONS.carryGapPerYard})</code>
                </div>
                <p><strong>This is not final golf strategy.</strong> Full risk is now calculated separately so we can validate it before changing the recommendation.</p>
                <div className="assumption-list">
                  <div><span>Aim search</span><strong>−15 to +15 yd, every 3 yd</strong></div>
                  <div><span>Core shape</span><strong>{selected.modeledSampleCount.toLocaleString()} deterministic Stock landings</strong></div>
                  <div><span>Default visual</span><strong>50 / 80% normal-core contours</strong></div>
                  <div><span>Full risk</span><strong>Core + learned planning-excluded tail · not scored yet</strong></div>
                  <div><span>Tactical outcome</span><strong>Success / manageable / serious trouble / catastrophe</strong></div>
                  <div><span>Wind</span><strong>looper-flight-physics-v1 · provisional</strong></div>
                  <div><span>Elevation</span><strong>LiDAR target elevation · provisional</strong></div>
                  <div><span>Surface response</span><strong>GSPro launch modifiers · modeled</strong></div>
                  <div><span>Physical lie response</span><strong>0 effect pending controlled test</strong></div>
                  <div><span>Smooth 90%</span><strong>Not synthesized yet</strong></div>
                </div>
                {selected.notes.length > 0 && <div className="aim-warning-list">{selected.notes.map((note) => <p key={note}>{note}</p>)}</div>}
              </article>
            </section>
          )}

          {selected && (
            <section className="aim-card risk-sweep-card">
              <div className="aim-card-heading">
                <div><span>FULL RISK · {selected.club.toUpperCase()}</span><h2>Outcome severity by aim</h2></div>
                <small>Inspection only · does not change V0-selected aim yet · tail {pct(selectedRisk?.tailProbability)}</small>
              </div>
              <div className="aim-table-wrap">
                <table className="aim-table risk-sweep-table">
                  <thead><tr><th>Aim</th><th>Success</th><th>Manageable</th><th>Serious trouble</th><th>Catastrophe</th><th>Unknown</th><th>Expected severity</th><th>Tail n</th></tr></thead>
                  <tbody>
                    {selected.candidates.map((candidate) => {
                      const risk = candidate.riskProfile
                      return (
                        <tr key={`risk-${candidate.aimOffsetYds}`} className={candidate === selected.bestCandidate ? 'best' : ''}>
                          <td><strong>{signedYds(candidate.aimOffsetYds)}</strong></td>
                          <td>{pct(risk?.success)}</td>
                          <td>{pct(risk?.manageable)}</td>
                          <td className="risk-serious-cell">{pct(risk?.seriousTrouble)}</td>
                          <td className="risk-catastrophe-cell">{pct(risk?.catastrophe)}</td>
                          <td>{pct(risk?.unknown)}</td>
                          <td>{risk ? risk.expectedSeverity.toFixed(2) : '—'}</td>
                          <td>{risk?.tailSampleCount ?? '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="aim-note">Mishit is a shot-quality label, not a risk bucket. A short/straight mishit can remain manageable; a tail shot only becomes serious or catastrophic when its modeled landing reaches serious trouble or a penalty surface.</p>
            </section>
          )}

          <footer className="aim-footer">
            <span>{hole.provenance.attribution}</span>
            <span>{hole.provenance.license}</span>
            <span>{selectedCourse.name} cached geometry · GSPro live state · provisional airborne physics</span>
          </footer>
        </>
      )}
    </main>
  )
}

export default AimLabPage
