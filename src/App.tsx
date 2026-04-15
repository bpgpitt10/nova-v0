import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type NovaConnection,
  type NovaConnectionStatus,
  type NovaFeedMode,
} from './adapters/nova'
import { mockNovaAdapter } from './adapters/mockNova'
import { novaWebSocketAdapter } from './adapters/novaWebSocket'
import looperLogoWhite from './assets/LooperLogoWhite.png'
import looperman from './assets/looperman.png'
import './App.css'
import LooperLandingPage from './pages/LooperLandingPage'
import ClubDetailV2, {
  type MetricKey as ClubDetailMetricKey,
  type MetricModel as ClubDetailMetricModel,
} from './pages/ClubDetailV2'
import {
  activeBagClubIds,
  getClubConfig,
  getClubLabel,
  type Club,
} from './lib/bagConfig'
import { confidenceConfig } from './lib/confidenceConfig'
import { guardedWeightedCarryMean } from './lib/carryOutlierGuard'
import {
  buildOpenGolfCoachInput,
  hasOpenGolfCoachInput,
  isOpenGolfCoachConfigured,
  logOpenGolfCoachPipeline,
  openGolfCoachEnricher,
} from './lib/openGolfCoach'
import {
  weightedAverage,
  weightedStandardDeviation,
} from './lib/recency'
import {
  formatShotRank,
  normalizeShotRank,
  shotRankScoreTone,
  shotRankWeight,
} from './lib/shotRank'
import { summarizeReviewClub } from './lib/scoring'
import {
  clearActiveSessionDraft,
  isSessionEligibleForAnalysis,
  loadActiveSessionDraft,
  loadSavedSessions,
  saveActiveSessionDraft,
  saveSessionHistory,
} from './lib/sessions'
import {
  includedClubShotsForSession,
  sessionHistoricalWeightForClub,
  weightedSessionMetricAverage,
} from './lib/historicalModel'
import {
  type ActiveSessionDraft,
  type IncomingNovaShot,
  type OpenGolfCoachPayload,
  type ReviewClubSummary,
  type SavedSession,
  type Shot,
} from './types'

type SessionState = 'setup' | 'live' | 'review'
type SessionFeedMode = 'mock' | 'real'
type ReviewView = 'dashboard' | 'clubDetail'
type ComparisonDirection = 'up' | 'down'
type ComparisonTone = 'up' | 'down' | 'neutral'

const LOCAL_NOVA_WS_URL_KEY = 'nova-ws-url'
const safeReadLocalStorage = (key: string) => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const navigateWithinApp = (path: string) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const resolveNovaWebSocketUrl = () => {
  const envUrl = import.meta.env.DEV
    ? (import.meta.env.VITE_NOVA_WS_URL as string | undefined)?.trim()
    : undefined
  if (envUrl) {
    return envUrl
  }

  const savedUrl = safeReadLocalStorage(LOCAL_NOVA_WS_URL_KEY)?.trim()
  if (savedUrl) {
    return savedUrl
  }

  return undefined
}

const novaWebSocketUrl = resolveNovaWebSocketUrl()

const formatDecimal = (value: number | undefined, unit = '') => {
  if (typeof value !== 'number') {
    return '-'
  }

  return `${value.toFixed(1)}${unit}`
}

const formatWhole = (value: number | undefined, unit = '') => {
  if (typeof value !== 'number') {
    return '-'
  }

  return `${Math.round(value)}${unit}`
}

const formatScore = (value: number | undefined) => {
  if (typeof value !== 'number') {
    return '-'
  }

  return `${Math.round(value)}`
}

const formatRank = (value: number | string | undefined) => formatShotRank(value)

const averageNumbers = (values: Array<number | undefined>) => {
  const definedValues = values.filter((value): value is number => typeof value === 'number')
  if (definedValues.length === 0) {
    return undefined
  }

  return definedValues.reduce((sum, value) => sum + value, 0) / definedValues.length
}

const standardDeviation = (values: Array<number | undefined>) => {
  const definedValues = values.filter((value): value is number => typeof value === 'number')
  if (definedValues.length === 0) {
    return undefined
  }

  const mean =
    definedValues.reduce((sum, value) => sum + value, 0) / definedValues.length
  const variance =
    definedValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    definedValues.length

  return Math.sqrt(variance)
}

const weightedAverageNumbers = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
) => {
  const average = weightedAverage(values, weights)
  return typeof average === 'number' ? average : undefined
}

const weightedStandardDeviationNumbers = (
  values: Array<number | undefined>,
  weights: Array<number | undefined>,
) => {
  const deviation = weightedStandardDeviation(values, weights)
  return typeof deviation === 'number' ? deviation : undefined
}

const payloadNumber = (payload: OpenGolfCoachPayload | undefined, keys: string[]) => {
  if (!payload) {
    return undefined
  }

  const parseNumberLike = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
    return undefined
  }

  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null

  const root = asRecord(payload)
  if (!root) {
    return undefined
  }

  const scopedObjects: Record<string, unknown>[] = [root]
  const coach = asRecord(root.open_golf_coach)
  if (coach) {
    scopedObjects.push(coach)
    const usCustomaryUnits = asRecord(coach.us_customary_units)
    if (usCustomaryUnits) {
      scopedObjects.push(usCustomaryUnits)
    }
    const siUnits = asRecord(coach.si_units)
    if (siUnits) {
      scopedObjects.push(siUnits)
    }
  }

  for (const source of scopedObjects) {
    for (const key of keys) {
      const parsed = parseNumberLike(source[key])
      if (typeof parsed === 'number') {
        return parsed
      }
    }
  }

  const visited = new Set<Record<string, unknown>>()
  const stack: Record<string, unknown>[] = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || visited.has(current)) {
      continue
    }
    visited.add(current)

    for (const key of keys) {
      const parsed = parseNumberLike(current[key])
      if (typeof parsed === 'number') {
        return parsed
      }
    }

    Object.values(current).forEach((value) => {
      const nested = asRecord(value)
      if (nested && !visited.has(nested)) {
        stack.push(nested)
      }
    })
  }

  return undefined
}

const carryValue = (shot: Shot) =>
  typeof shot.carryYards === 'number'
    ? shot.carryYards
    : payloadNumber(shot.openGolfCoach, [
        'carry_distance_yards',
        'carryDistanceYards',
        'carry',
      ])

const totalValue = (shot: Shot) =>
  typeof shot.totalYards === 'number'
    ? shot.totalYards
    : payloadNumber(shot.openGolfCoach, [
        'total_distance_yards',
        'totalDistanceYards',
        'total',
      ])

const offlineValue = (shot: Shot) =>
  typeof shot.offlineYards === 'number'
    ? shot.offlineYards
    : payloadNumber(shot.openGolfCoach, [
        'offline_distance_yards',
        'offlineDistanceYards',
        'offline',
      ])

const launchValue = (shot: Shot) =>
  typeof shot.verticalLaunchAngleDegrees === 'number'
    ? shot.verticalLaunchAngleDegrees
    : typeof shot.launchAngleDeg === 'number'
      ? shot.launchAngleDeg
      : payloadNumber(shot.openGolfCoach, [
          'vertical_launch_angle_degrees',
          'verticalLaunchAngleDegrees',
          'launch_angle_degrees',
          'launchAngleDeg',
        ])

const hlaValue = (shot: Shot) =>
  typeof shot.horizontalLaunchAngleDegrees === 'number'
    ? shot.horizontalLaunchAngleDegrees
    : payloadNumber(shot.openGolfCoach, [
        'horizontal_launch_angle_degrees',
        'horizontalLaunchAngleDegrees',
        'horizontal_launch_angle',
      ])

const spinValue = (shot: Shot) =>
  typeof shot.totalSpinRpm === 'number'
    ? shot.totalSpinRpm
    : typeof shot.spinRpm === 'number'
      ? shot.spinRpm
      : payloadNumber(shot.openGolfCoach, [
          'backspin_rpm',
          'total_spin_rpm',
          'totalSpinRpm',
          'spin_rpm',
        ])

const spinAxisValue = (shot: Shot) =>
  typeof shot.spinAxisDegrees === 'number'
    ? shot.spinAxisDegrees
    : payloadNumber(shot.openGolfCoach, [
        'spin_axis_degrees',
        'spinAxisDegrees',
        'spin_axis',
      ])

const descentValue = (shot: Shot) =>
  // Primary descent field from confirmed OpenGolfCoach payload.
  payloadNumber(shot.openGolfCoach, [
    'descent_angle_degrees',
    'descent_angle_deg',
    'descent_angle',
    'descentAngleDegrees',
    'descentAngleDeg',
    'descentAngle',
  ])

const clubPathValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, ['club_path_degrees', 'clubPathDegrees', 'club_path'])

const faceToPathValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, [
    'club_face_to_path_degrees',
    'clubFaceToPathDegrees',
    'club_face_to_path',
  ])

const faceToTargetValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, [
    'club_face_to_target_degrees',
    'clubFaceToTargetDegrees',
    'club_face_to_target',
  ])

const smashFactorValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, ['smash_factor', 'smashFactor', 'smash'])

const peakHeightValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, [
    'peak_height_yards',
    'peakHeightYards',
    'peak_height',
    'peakHeight',
  ])

const clubSpeedValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, [
    'club_speed_mph',
    'clubSpeedMph',
    'club_speed_miles_per_hour',
    'clubSpeedMilesPerHour',
  ])

const ballSpeedMphValue = (shot: Shot) =>
  typeof shot.ballSpeedMph === 'number'
    ? shot.ballSpeedMph
    : payloadNumber(shot.openGolfCoach, [
        'ball_speed_mph',
        'ballSpeedMph',
        'ball_speed_miles_per_hour',
        'ballSpeedMilesPerHour',
      ])

const comparisonTolerance = {
  score: 3,
  component: 4,
}

const rankWeightForShot = (shot: Shot) => shotRankWeight(shot.shotRanking)

const comparisonDirection = (delta: number | undefined): ComparisonDirection =>
  typeof delta === 'number' && delta < 0 ? 'down' : 'up'

const comparisonTone = (
  delta: number | undefined,
  tolerance: number,
): ComparisonTone => {
  if (typeof delta !== 'number') {
    return 'neutral'
  }

  if (Math.abs(delta) <= tolerance) {
    return 'neutral'
  }

  return delta > 0 ? 'up' : 'down'
}

const capitalizeFirst = (value: string) =>
  value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value

const caddieCallClassName = (caddieCall: ReviewClubSummary['caddieCall']) =>
  `caddie-call-pill caddie-call-${caddieCall.toLowerCase().replace(/\s+/g, '-')}`

const caddieToneClassName = (caddieCall: ReviewClubSummary['caddieCall']) =>
  `caddie-tone-${caddieCall.toLowerCase().replace(/\s+/g, '-')}`

const dashboardDescriptor = (caddieCall: ReviewClubSummary['caddieCall']) => {
  switch (caddieCall) {
    case 'Attack':
      return 'Green light club'
    case 'Play':
      return 'Go-to option'
    case 'Manage':
      return 'Needs a plan'
    case 'Careful':
      return 'Caution required'
    case 'Liability':
      return 'Emergency use only'
    case 'Insufficient Data':
      return 'Need more swings'
  }
}

const componentDisplayOrder: Array<keyof ReviewClubSummary['componentScores']> = [
  'distanceWindow',
  'directionWindow',
  'flightQuality',
  'patternStability',
  'dataConfidence',
]

const componentLabel = (component: keyof ReviewClubSummary['componentScores']) => {
  switch (component) {
    case 'distanceWindow':
      return 'Carry Expectation'
    case 'directionWindow':
      return 'Direction Control'
    case 'flightQuality':
      return 'Shot Behavior'
    case 'patternStability':
      return 'Pattern Trend'
    case 'dataConfidence':
      return 'Data Confidence'
  }
}

const componentGolfLabel = (component: keyof ReviewClubSummary['componentScores']) => {
  switch (component) {
    case 'distanceWindow':
      return 'Carry expectation'
    case 'directionWindow':
      return 'Direction control'
    case 'flightQuality':
      return 'Shot behavior'
    case 'patternStability':
      return 'Pattern trend'
    case 'dataConfidence':
      return 'Data confidence'
  }
}

const strongestComponentLabel = (
  componentScores: ReviewClubSummary['componentScores'],
  direction: 'high' | 'low',
) => {
  const rankedComponents = Object.entries(componentScores)
    .map(
      ([key, value]) =>
        [key, typeof value === 'number' ? value : 0] as [
          keyof ReviewClubSummary['componentScores'],
          number,
        ],
    )
    .sort((left, right) =>
      direction === 'high' ? right[1] - left[1] : left[1] - right[1],
    )

  return componentLabel(rankedComponents[0][0])
}

const clubGroupLabel = (club: Club) => {
  const category = getClubConfig(club)?.category

  if (category === 'wood') {
    return 'Woods'
  }

  if (category === 'hybrid') {
    return 'Hybrids'
  }

  if (club === '5i' || club === '6i') {
    return 'Long Irons'
  }

  if (club === '7i' || club === '8i' || club === '9i' || club === 'PW') {
    return 'Scoring Irons'
  }

  return 'Wedges'
}

const clubAnchorId = (club: Club) => `club-${club.toLowerCase().replace(/\s+/g, '-')}`

const buildShot = (
  incomingShot: IncomingNovaShot,
  club: Club,
  source: Shot['source'],
): Shot => ({
  // Current state:
  // - Nova/mock provides the live shot event.
  // - OpenGolfCoach is planned as the derived-values enrichment step.
  // For now we preserve the current fields and also capture the normalized raw
  // inputs that OpenGolfCoach will eventually consume.
  id:
    incomingShot.id ??
    `${source}-${incomingShot.timestamp ?? Date.now()}-${crypto.randomUUID()}`,
  club,
  included: true,
  capturedAt: incomingShot.timestamp ?? new Date().toISOString(),
  enrichmentStatus: 'raw_only',
  ballSpeedMetersPerSecond:
    incomingShot.ballSpeedMetersPerSecond ??
    incomingShot.ball_speed_meters_per_second,
  verticalLaunchAngleDegrees:
    incomingShot.verticalLaunchAngleDegrees ??
    incomingShot.vertical_launch_angle_degrees,
  horizontalLaunchAngleDegrees:
    incomingShot.horizontalLaunchAngleDegrees ??
    incomingShot.horizontal_launch_angle_degrees,
  totalSpinRpm: incomingShot.totalSpinRpm ?? incomingShot.total_spin_rpm,
  spinAxisDegrees: incomingShot.spinAxisDegrees ?? incomingShot.spin_axis_degrees,
  ballSpeedMph: incomingShot.ballSpeedMph,
  carryYards: incomingShot.carryYards ?? incomingShot.carry,
  totalYards: incomingShot.totalYards ?? incomingShot.total,
  offlineYards: incomingShot.offlineYards ?? incomingShot.offline,
  launchAngleDeg: incomingShot.launchAngleDeg ?? incomingShot.vla,
  spinRpm: incomingShot.spinRpm ?? incomingShot.spin,
  shotName: incomingShot.shotName ?? incomingShot.shot_name,
  shotRanking: incomingShot.shotRanking,
  source,
})

const currentSessionMetadata = (feedMode: SessionFeedMode) => ({
  app: 'nova-validation' as const,
  schemaVersion: 2,
  feedMode,
  includeInAnalysis: true,
})

const mergeDerivedValues = (
  shot: Shot,
  payload: OpenGolfCoachPayload | null,
  derivedValues: Awaited<ReturnType<typeof openGolfCoachEnricher.enrichShot>>['derivedValues'],
): Shot => ({
  ...shot,
  enrichmentStatus: 'enriched',
  openGolfCoach: payload ?? shot.openGolfCoach,
  carryYards: derivedValues.carry_distance_yards ?? shot.carryYards,
  totalYards: derivedValues.total_distance_yards ?? shot.totalYards,
  offlineYards: derivedValues.offline_distance_yards ?? shot.offlineYards,
  shotName: derivedValues.shot_name ?? shot.shotName,
  shotRanking: derivedValues.shot_rank ?? shot.shotRanking,
})

type AppProps = {
  forceDashboardRoute?: boolean
  forceSessionIntelligenceRoute?: boolean
}

function App({
  forceDashboardRoute = false,
  forceSessionIntelligenceRoute = false,
}: AppProps) {
  const normalizedPath =
    typeof window !== 'undefined'
      ? window.location.pathname.replace(/\/+$/, '') || '/'
      : '/'
  if (!forceDashboardRoute && !forceSessionIntelligenceRoute && normalizedPath === '/') {
    return <LooperLandingPage />
  }

  type DashboardNavTarget = 'dashboard' | 'bag' | 'lastSession'
  type ClubDriverKey = keyof ReviewClubSummary['componentScores']
  const useClubDetailV2 = (() => {
    if (typeof window === 'undefined') {
      return true
    }
    const param = new URLSearchParams(window.location.search).get('clubDetail')
    return param !== 'v1'
  })()
  const sessionIntelligenceSearch = forceSessionIntelligenceRoute
    ? new URLSearchParams(window.location.search)
    : null
  const routeFeedMode =
    sessionIntelligenceSearch?.get('feed') === 'real' ? 'real' : 'mock'
  const fallbackClub = activeBagClubIds[0] ?? '7i'
  const routeClubParam = sessionIntelligenceSearch?.get('club')
  const routeClub = activeBagClubIds.includes(routeClubParam as Club)
    ? (routeClubParam as Club)
    : fallbackClub
  const resumedDraft = forceSessionIntelligenceRoute ? loadActiveSessionDraft() : null
  const startedAtFallback = new Date().toISOString()
  const [sessionState, setSessionState] = useState<SessionState>(() =>
    forceSessionIntelligenceRoute ? 'live' : forceDashboardRoute ? 'review' : 'setup',
  )
  const [selectedFeedMode, setSelectedFeedMode] = useState<SessionFeedMode>(() =>
    forceSessionIntelligenceRoute
      ? resumedDraft?.metadata.feedMode ?? routeFeedMode
      : 'mock',
  )
  const [selectedClub, setSelectedClub] = useState<Club>(() =>
    forceSessionIntelligenceRoute ? routeClub : fallbackClub,
  )
  const [selectedDetailClub, setSelectedDetailClub] = useState<Club>(fallbackClub)
  const [reviewView, setReviewView] = useState<ReviewView>('dashboard')
  const [openClubDriver, setOpenClubDriver] = useState<ClubDriverKey | null>(null)
  const [dashboardNavTarget, setDashboardNavTarget] =
    useState<DashboardNavTarget>('dashboard')
  const [isLastSessionOpen, setIsLastSessionOpen] = useState(false)
  const [shots, setShots] = useState<Shot[]>(() =>
    forceSessionIntelligenceRoute ? resumedDraft?.shots ?? [] : [],
  )
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>(() =>
    loadSavedSessions(),
  )
  const historicalModelNowMs = Date.now()
  const analysisSessions = useMemo(
    () =>
      [...savedSessions]
        .filter((session) => isSessionEligibleForAnalysis(session, historicalModelNowMs))
        .sort(
          (left, right) =>
            new Date(right.endedAt).getTime() - new Date(left.endedAt).getTime(),
        ),
    [historicalModelNowMs, savedSessions],
  )
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [feedMode, setFeedMode] = useState<NovaFeedMode | null>(null)
  const [connectionStatus, setConnectionStatus] =
    useState<NovaConnectionStatus>('disconnected')
  const [helperReachable, setHelperReachable] = useState<boolean | null>(null)
  const [lastEnrichmentStatus, setLastEnrichmentStatus] = useState<
    'idle' | 'success' | 'failure'
  >('idle')
  const [sessionStartedAt] = useState<string | null>(() =>
    forceSessionIntelligenceRoute ? resumedDraft?.startedAt ?? startedAtFallback : null,
  )
  const [liveSessionId] = useState<string | null>(() =>
    forceSessionIntelligenceRoute ? resumedDraft?.id ?? crypto.randomUUID() : null,
  )
  const selectedClubRef = useRef(selectedClub)
  const connectionRef = useRef<NovaConnection | null>(null)
  const liveNovaUnavailable = selectedFeedMode === 'real' && !novaWebSocketUrl

  const navigateDashboardSection = (
    sectionId: 'dashboard-overview' | 'dashboard-bag' | 'dashboard-review',
    navTarget: DashboardNavTarget,
    expandLastSession = false,
  ) => {
    setDashboardNavTarget(navTarget)
    setReviewView('dashboard')
    if (expandLastSession) {
      setIsLastSessionOpen(true)
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    })
  }

  useEffect(() => {
    selectedClubRef.current = selectedClub
  }, [selectedClub])

  useEffect(() => {
    if (sessionState !== 'live' || !sessionStartedAt || !liveSessionId) {
      clearActiveSessionDraft()
      return undefined
    }

    const draft: ActiveSessionDraft = {
      id: liveSessionId,
      startedAt: sessionStartedAt,
      shots,
      metadata: currentSessionMetadata(selectedFeedMode),
    }

    saveActiveSessionDraft(draft)

    return undefined
  }, [liveSessionId, selectedFeedMode, sessionStartedAt, sessionState, shots])

  useEffect(() => {
    if (sessionState !== 'live') {
      return undefined
    }

    const resolvedWsUrl = novaWebSocketUrl
    let isActive = true
    let activeSource: Shot['source'] = 'mock'
    if (selectedFeedMode === 'real' && !resolvedWsUrl) {
      setFeedMode('real')
      setConnectionStatus('error')
      return undefined
    }

    const adapter = selectedFeedMode === 'real'
      ? novaWebSocketAdapter(resolvedWsUrl as string)
      : mockNovaAdapter
    const connection: NovaConnection = adapter.connectToShots(
      (incomingShot) => {
        if (!isActive) {
          return
        }

        const shot = buildShot(incomingShot, selectedClubRef.current, activeSource)
        console.info('[Shot Pipeline] live shot received', {
          shotId: shot.id,
          source: activeSource,
          capturedAt: shot.capturedAt,
          ranking: shot.shotRanking,
        })
        setShots((currentShots) => [shot, ...currentShots])
        console.info('[Shot Pipeline] raw shot persisted in active session state', {
          shotId: shot.id,
          included: shot.included,
        })

        const openGolfCoachInput = buildOpenGolfCoachInput(incomingShot)
        const hasInput = hasOpenGolfCoachInput(openGolfCoachInput)
        logOpenGolfCoachPipeline('shot_received_for_enrichment', {
          shotId: shot.id,
          hasInput,
          input: openGolfCoachInput,
        })
        console.info('[Shot Pipeline] enrichment request started', {
          shotId: shot.id,
          hasInput,
          payload: openGolfCoachInput,
        })
        if (!hasInput) {
          console.warn('[Shot Pipeline] enrichment input sparse, attempting anyway', {
            shotId: shot.id,
          })
        }

        void openGolfCoachEnricher
          .enrichShot(openGolfCoachInput)
          .then((result) => {
            if (!isActive) {
              return
            }

            if (result.status === 'failure') {
              logOpenGolfCoachPipeline('enrichment_result_failure', {
                shotId: shot.id,
                status: result.status,
              })
              console.error('[Shot Pipeline] enrichment failed', { shotId: shot.id })
              setHelperReachable(false)
              setLastEnrichmentStatus('failure')
              setShots((currentShots) =>
                currentShots.map((currentShot) =>
                  currentShot.id === shot.id
                    ? { ...currentShot, enrichmentStatus: 'enrichment_failed' }
                    : currentShot,
                ),
              )
              return
            }

            if (result.status === 'success') {
              logOpenGolfCoachPipeline('enrichment_result_success', {
                shotId: shot.id,
                status: result.status,
                hasPayload: Boolean(result.payload),
              })
              console.info('[Shot Pipeline] enrichment succeeded', { shotId: shot.id })
              setHelperReachable(true)
              setLastEnrichmentStatus('success')
            }

            if (!result.payload) {
              logOpenGolfCoachPipeline('enrichment_result_no_payload', {
                shotId: shot.id,
                status: result.status,
              })
              console.warn('[Shot Pipeline] enrichment returned no payload to merge', {
                shotId: shot.id,
                status: result.status,
              })
              return
            }

            console.info('[Shot Pipeline] applying enrichment merge to shot state', {
              shotId: shot.id,
              status: result.status,
              derivedValues: result.derivedValues,
              payloadKeys:
                result.payload && typeof result.payload === 'object'
                  ? Object.keys(result.payload)
                  : [],
            })
            logOpenGolfCoachPipeline('enrichment_merge_applied', {
              shotId: shot.id,
              status: result.status,
              derivedValues: result.derivedValues,
            })
            setShots((currentShots) =>
              currentShots.map((currentShot) =>
                currentShot.id === shot.id
                  ? mergeDerivedValues(currentShot, result.payload, result.derivedValues)
                  : currentShot,
              ),
            )
          })
          .catch((error) => {
            if (!isActive) {
              return
            }
            logOpenGolfCoachPipeline('enrichment_result_exception', {
              shotId: shot.id,
              error: error instanceof Error ? error.message : String(error),
            })
            console.error('[Shot Pipeline] enrichment failed with error', {
              shotId: shot.id,
              error,
            })
            setHelperReachable(false)
            setLastEnrichmentStatus('failure')
            setShots((currentShots) =>
              currentShots.map((currentShot) =>
                currentShot.id === shot.id
                  ? { ...currentShot, enrichmentStatus: 'enrichment_failed' }
                  : currentShot,
              ),
            )
          })
      },
      setConnectionStatus,
      (event) => {
        if (import.meta.env.DEV) {
          console.info('[Nova WS] message debug', {
            normalized: Boolean(event.normalizedShot),
            rawPreview: event.rawMessage?.slice(0, 220),
          })
        }
      },
    )

    activeSource = connection.mode === 'mock' ? 'mock' : 'nova'
    connectionRef.current = connection
    setFeedMode(connection.mode)

    return () => {
      isActive = false
      connection.disconnect()
      connectionRef.current = null
    }
  }, [selectedFeedMode, sessionState])

  const dashboardShots = useMemo(
    () => analysisSessions.flatMap((savedSession) => savedSession.shots),
    [analysisSessions],
  )

  const dashboardSummaries: ReviewClubSummary[] = useMemo(
    () =>
      activeBagClubIds
        .map((club) => summarizeReviewClub(club, dashboardShots, analysisSessions, null))
        .filter((summary): summary is ReviewClubSummary => summary !== null),
    [analysisSessions, dashboardShots],
  )

  const rankedDashboardSummaries = useMemo(
    () =>
      [...dashboardSummaries].sort((left, right) => right.caddieScore - left.caddieScore),
    [dashboardSummaries],
  )

  const dashboardSummaryLead = rankedDashboardSummaries[0] ?? null

  const dashboardSummariesByClub = useMemo(
    () => new Map(dashboardSummaries.map((summary) => [summary.club, summary])),
    [dashboardSummaries],
  )

  const latestSessionSummariesByClub = useMemo(() => {
    const summaries = new Map<Club, ReviewClubSummary>()
    const latestSession = analysisSessions[0]

    if (!latestSession) {
      return summaries
    }

    activeBagClubIds.forEach((club) => {
      const summary = summarizeReviewClub(
        club,
        latestSession.shots,
        analysisSessions.filter((session) => session.id !== latestSession.id),
        latestSession.id,
      )

      if (summary) {
        summaries.set(club, summary)
      }
    })

    return summaries
  }, [analysisSessions])

  const previousSummariesByClub = useMemo(() => {
    const summaries = new Map<Club, ReviewClubSummary>()
    const previousSession = analysisSessions[1]

    if (!previousSession) {
      return summaries
    }

    activeBagClubIds.forEach((club) => {
      const summary = summarizeReviewClub(
        club,
        previousSession.shots,
        analysisSessions.filter((session) => session.id !== previousSession.id),
        previousSession.id,
      )

      if (summary) {
        summaries.set(club, summary)
      }
    })

    return summaries
  }, [analysisSessions])

  const historicalAveragesByClub = useMemo(() => {
    const map = new Map<
      Club,
      {
        score?: number
        distanceWindow?: number
        directionWindow?: number
        flightQuality?: number
        patternStability?: number
        dataConfidence?: number
      }
    >()

    const historicalSessions = analysisSessions.slice(1)

    activeBagClubIds.forEach((club) => {
      const summaryPoints = historicalSessions
        .map((session) =>
          ({
            summary: summarizeReviewClub(
              club,
              session.shots,
              analysisSessions.filter((savedSession) => savedSession.id !== session.id),
              session.id,
            ),
            weight: sessionHistoricalWeightForClub(
              session,
              club,
              historicalModelNowMs,
            ),
          }),
        )
        .filter(
          (point): point is { summary: ReviewClubSummary; weight: number } =>
            point.summary !== null && point.weight > 0,
        )

      map.set(club, {
        score: weightedAverageNumbers(
          summaryPoints.map((point) => point.summary.caddieScore),
          summaryPoints.map((point) => point.weight),
        ),
        distanceWindow: weightedAverageNumbers(
          summaryPoints.map((point) => point.summary.componentScores.distanceWindow),
          summaryPoints.map((point) => point.weight),
        ),
        directionWindow: weightedAverageNumbers(
          summaryPoints.map((point) => point.summary.componentScores.directionWindow),
          summaryPoints.map((point) => point.weight),
        ),
        flightQuality: weightedAverageNumbers(
          summaryPoints.map(
            (point) => point.summary.componentScores.flightQuality ?? undefined,
          ),
          summaryPoints.map((point) => point.weight),
        ),
        patternStability: weightedAverageNumbers(
          summaryPoints.map(
            (point) => point.summary.componentScores.patternStability ?? undefined,
          ),
          summaryPoints.map((point) => point.weight),
        ),
        dataConfidence: weightedAverageNumbers(
          summaryPoints.map((point) => point.summary.componentScores.dataConfidence),
          summaryPoints.map((point) => point.weight),
        ),
      })
    })

    return map
  }, [analysisSessions, historicalModelNowMs])

  const lastSessionComparisonRows = useMemo(() => {
    const latestSession = analysisSessions[0]
    if (!latestSession) {
      return []
    }

    return activeBagClubIds
      .map((club) => {
        const sessionShots = latestSession.shots.filter(
          (shot) => shot.club === club && shot.included,
        )
        if (sessionShots.length === 0) {
          return null
        }

        const summary = latestSessionSummariesByClub.get(club)
        if (!summary) {
          return null
        }

        const history = historicalAveragesByClub.get(club)

        const scoreDelta =
          typeof history?.score === 'number'
            ? summary.caddieScore - history.score
            : undefined
        const distanceDelta =
          typeof history?.distanceWindow === 'number'
            ? summary.componentScores.distanceWindow - history.distanceWindow
            : undefined
        const directionDelta =
          typeof history?.directionWindow === 'number'
            ? summary.componentScores.directionWindow - history.directionWindow
            : undefined
        const flightDelta =
          typeof summary.componentScores.flightQuality === 'number' &&
          typeof history?.flightQuality === 'number'
            ? summary.componentScores.flightQuality - history.flightQuality
            : undefined
        const patternDelta =
          typeof summary.componentScores.patternStability === 'number' &&
          typeof history?.patternStability === 'number'
            ? summary.componentScores.patternStability - history.patternStability
            : undefined
        const confidenceDelta =
          typeof history?.dataConfidence === 'number'
            ? summary.componentScores.dataConfidence - history.dataConfidence
            : undefined

        return {
          club,
          summary,
          shots: sessionShots.length,
          historicalScore: history?.score,
          scoreDelta,
          scoreDirection: comparisonDirection(scoreDelta),
          scoreTone: comparisonTone(scoreDelta, comparisonTolerance.score),
          componentComparisons: [
            {
              key: 'distanceWindow',
              label: componentLabel('distanceWindow'),
              value: summary.componentScores.distanceWindow,
              historical: history?.distanceWindow,
              delta: distanceDelta,
              direction: comparisonDirection(distanceDelta),
              tone: comparisonTone(distanceDelta, comparisonTolerance.component),
            },
            {
              key: 'directionWindow',
              label: componentLabel('directionWindow'),
              value: summary.componentScores.directionWindow,
              historical: history?.directionWindow,
              delta: directionDelta,
              direction: comparisonDirection(directionDelta),
              tone: comparisonTone(directionDelta, comparisonTolerance.component),
            },
            {
              key: 'flightQuality',
              label: componentLabel('flightQuality'),
              value:
                typeof summary.componentScores.flightQuality === 'number'
                  ? summary.componentScores.flightQuality
                  : undefined,
              historical: history?.flightQuality,
              delta: flightDelta,
              direction: comparisonDirection(flightDelta),
              tone: comparisonTone(flightDelta, comparisonTolerance.component),
            },
            {
              key: 'patternStability',
              label: componentLabel('patternStability'),
              value:
                typeof summary.componentScores.patternStability === 'number'
                  ? summary.componentScores.patternStability
                  : undefined,
              historical: history?.patternStability,
              delta: patternDelta,
              direction: comparisonDirection(patternDelta),
              tone: comparisonTone(patternDelta, comparisonTolerance.component),
            },
            {
              key: 'dataConfidence',
              label: componentLabel('dataConfidence'),
              value: summary.componentScores.dataConfidence,
              historical: history?.dataConfidence,
              delta: confidenceDelta,
              direction: comparisonDirection(confidenceDelta),
              tone: comparisonTone(confidenceDelta, comparisonTolerance.component),
            },
          ] as const,
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
  }, [analysisSessions, historicalAveragesByClub, latestSessionSummariesByClub])

  const lastSessionInsights = useMemo(() => {
    if (lastSessionComparisonRows.length === 0) {
      return 'Last session does not yet have enough included club shots to compare against history.'
    }

    const definedMetrics = lastSessionComparisonRows.flatMap((row) =>
      row.componentComparisons.flatMap((component) =>
        typeof component.delta === 'number'
          ? [
              {
                club: row.club,
                metric: component.label,
                delta: component.delta,
              },
            ]
          : [],
      ),
    )
    const scoreMoves = lastSessionComparisonRows
      .map((row) => ({
        club: row.club,
        delta: row.scoreDelta,
      }))
      .filter((row): row is { club: Club; delta: number } => typeof row.delta === 'number')

    const bestMetric = [...definedMetrics].sort((left, right) => right.delta - left.delta)[0]
    const worstMetric = [...definedMetrics].sort((left, right) => left.delta - right.delta)[0]
    const bestScoreMove = [...scoreMoves].sort((left, right) => right.delta - left.delta)[0]
    const worstScoreMove = [...scoreMoves].sort((left, right) => left.delta - right.delta)[0]
    const stableClubs = lastSessionComparisonRows.filter(
      (row) => row.scoreTone === 'neutral',
    ).length

    const lead = bestScoreMove
      ? `${getClubLabel(bestScoreMove.club)} outperformed its normal score profile by ${formatScore(Math.abs(bestScoreMove.delta))} points.`
      : 'This session sat close to the established score profile across the bag.'

    const slip = worstScoreMove && worstScoreMove.delta < 0
      ? `${getClubLabel(worstScoreMove.club)} slipped ${formatScore(Math.abs(worstScoreMove.delta))} points versus its historical baseline.`
      : 'No major score drop-offs appeared versus normal.'

    const standout =
      bestMetric && worstMetric
        ? `Largest component swing was ${getClubLabel(bestMetric.club)} on ${bestMetric.metric} (+${formatScore(Math.abs(bestMetric.delta))}), while ${getClubLabel(worstMetric.club)} gave back the most on ${worstMetric.metric} (${worstMetric.delta <= 0 ? '-' : '+'}${formatScore(Math.abs(worstMetric.delta))}).`
        : 'Component variation is still building as more historical sessions accumulate.'

    return `${lead} ${slip} ${standout} ${stableClubs} clubs finished inside the neutral tolerance band.`
  }, [lastSessionComparisonRows])

  const dashboardClubCards = useMemo(
    () =>
      activeBagClubIds.map((club) => {
        const summary = dashboardSummariesByClub.get(club) ?? null
        const latestSummary = latestSessionSummariesByClub.get(club) ?? null
        const previousSummary = previousSummariesByClub.get(club) ?? null
        const delta =
          latestSummary && previousSummary
            ? latestSummary.caddieScore - previousSummary.caddieScore
            : null

        return {
          club,
          summary,
          delta,
          descriptor: summary ? dashboardDescriptor(summary.caddieCall) : 'Need more swings',
        }
      }),
    [dashboardSummariesByClub, latestSessionSummariesByClub, previousSummariesByClub],
  )

  const featuredDriverCard = useMemo(
    () =>
      activeBagClubIds.includes('Driver')
        ? dashboardClubCards.find((card) => card.club === 'Driver') ?? null
        : null,
    [dashboardClubCards],
  )

  const dashboardGridCards = useMemo(
    () =>
      featuredDriverCard
        ? dashboardClubCards.filter((card) => card.club !== 'Driver')
        : dashboardClubCards,
    [dashboardClubCards, featuredDriverCard],
  )

  const featuredDriverSummary = featuredDriverCard?.summary ?? null
  const featuredDriverIncludedShots = useMemo(
    () =>
      featuredDriverCard
        ? analysisSessions
            .flatMap((session) => session.shots)
            .filter((shot) => shot.club === featuredDriverCard.club && shot.included)
        : [],
    [analysisSessions, featuredDriverCard],
  )
  const featuredDriverRead = useMemo(() => {
    if (!featuredDriverCard || !featuredDriverSummary) {
      return null
    }

    const componentEntries = Object.entries(featuredDriverSummary.componentScores).map(
      ([key, value]) =>
        [key, typeof value === 'number' ? value : 0] as [
          keyof ReviewClubSummary['componentScores'],
          number,
        ],
    )
    const strongest = [...componentEntries].sort((left, right) => right[1] - left[1])[0][0]
    const weakest = [...componentEntries].sort((left, right) => left[1] - right[1])[0][0]
    const strongestLabel = componentGolfLabel(strongest)
    const weakestLabel = componentGolfLabel(weakest)

    const offlineAverage = featuredDriverSummary.offlineAverageYards
    const offlineDispersion = featuredDriverSummary.offlineStdDevYards
    const oneSidedMissExposure =
      typeof offlineAverage === 'number' && typeof offlineDispersion === 'number'
        ? Math.abs(offlineAverage) + offlineDispersion
        : null
    // Approximate total left-to-right dispersion width from one-sided exposure.
    const effectiveTotalDispersion =
      typeof oneSidedMissExposure === 'number' ? oneSidedMissExposure * 2 : null
    const bias =
      typeof offlineAverage !== 'number' || Math.abs(offlineAverage) < 4
        ? 'neutral'
        : offlineAverage > 0
          ? 'right'
          : 'left'

    const missOutcome = (() => {
      if (effectiveTotalDispersion === null) {
        return {
          label: 'Miss outcome',
          detail: 'Miss profile is still building.',
          tier: 'unknown' as const,
        }
      }

      // Work backward from penalty-risk threshold:
      // penalty language only starts once effective total dispersion > ~48 yd.
      if (effectiveTotalDispersion <= 24) {
        return {
          label: 'Miss stays in play',
          detail: bias === 'neutral' ? 'Fairway should hold.' : `${capitalizeFirst(bias)} miss stays in play.`,
          tier: 'tight' as const,
        }
      }
      if (effectiveTotalDispersion <= 34) {
        return {
          label: 'Rough is in play',
          detail:
            bias === 'neutral'
              ? 'Miss can leak into the rough.'
              : `${capitalizeFirst(bias)} miss can leak into the rough.`,
          tier: 'moderate' as const,
        }
      }
      if (effectiveTotalDispersion <= 42) {
        return {
          label: 'Miss likely finds rough',
          detail:
            bias === 'neutral'
              ? 'Miss likely finds rough.'
              : `${capitalizeFirst(bias)} miss likely finds rough.`,
          tier: 'wide' as const,
        }
      }
      if (effectiveTotalDispersion <= 48) {
        return {
          label: 'Trouble comes into play',
          detail:
            bias === 'neutral'
              ? 'Trouble comes into play when the hole narrows.'
              : `${capitalizeFirst(bias)} miss can bring hazards into play.`,
          tier: 'dangerous' as const,
        }
      }
      return {
        label: effectiveTotalDispersion > 56 ? 'High penalty risk' : 'Penalty risk',
        detail:
          bias === 'neutral'
            ? 'Big numbers come into play if the miss is not controlled.'
            : `${capitalizeFirst(bias)} miss is a high penalty-risk pattern.`,
        tier: 'chaotic' as const,
      }
    })()

    const smashAverage = averageNumbers(featuredDriverIncludedShots.map(smashFactorValue))
    const smashNote =
      featuredDriverCard.club === 'Driver' && typeof smashAverage === 'number'
        ? smashAverage >= 1.46
          ? 'Smash is holding up.'
          : smashAverage >= 1.41
            ? 'Smash is playable.'
            : 'Smash contact is costing you.'
        : null

    const mainLead = (() => {
      switch (featuredDriverSummary.caddieCall) {
        case 'Attack':
          return `${getClubLabel(featuredDriverCard.club)} is a green-light option right now.`
        case 'Play':
          return `${getClubLabel(featuredDriverCard.club)} is playable, with ${strongestLabel.toLowerCase()} holding up.`
        case 'Manage':
          return `${getClubLabel(featuredDriverCard.club)} is playable, but it needs management.`
        case 'Careful':
          return `${getClubLabel(featuredDriverCard.club)} needs a conservative line right now.`
        case 'Liability':
          return `${getClubLabel(featuredDriverCard.club)} is a high-risk pull right now.`
        case 'Insufficient Data':
          return `${getClubLabel(featuredDriverCard.club)} still needs more clean shots before this is a firm read.`
      }
    })()

    const practicalLine =
      missOutcome.tier === 'tight' || missOutcome.tier === 'moderate'
        ? 'You can use it, but keep the start line disciplined.'
        : missOutcome.tier === 'wide'
          ? 'Use it when the hole gives you room for the miss.'
          : 'If the hole punishes the miss, back off.'

    return {
      mainRead: `${mainLead} ${missOutcome.detail}`,
      insightRows: [
        `${strongestLabel} is holding. ${weakestLabel} is still the cost.`,
        `${practicalLine}${smashNote ? ` ${smashNote}` : ''}`,
      ],
      meta: {
        missOutcome: missOutcome.label,
        biggestDrag: weakestLabel,
        smashAverage:
          featuredDriverCard.club === 'Driver' ? smashAverage : undefined,
      },
    }
  }, [analysisSessions, featuredDriverCard, featuredDriverIncludedShots, featuredDriverSummary])

  const bestClubSummary = dashboardSummaryLead
  const weakestClubSummary =
    rankedDashboardSummaries.length > 0
      ? rankedDashboardSummaries[rankedDashboardSummaries.length - 1]
      : null

  const biggestMover = useMemo(() => {
    const cardsWithDelta = dashboardClubCards.flatMap((card) =>
      card.summary !== null && typeof card.delta === 'number'
        ? [{ ...card, summary: card.summary, delta: card.delta }]
        : [],
    )

    return cardsWithDelta.sort(
      (left, right) => Math.abs(right.delta) - Math.abs(left.delta),
    )[0] ?? null
  }, [dashboardClubCards])

  const dashboardGameStatusNarrative = useMemo(() => {
    if (!bestClubSummary || !weakestClubSummary) {
      return 'There is enough here to start a read, but not enough to give the bag the full treatment yet.'
    }

    const strongClubCount = dashboardSummaries.filter((summary) =>
      ['Attack', 'Play'].includes(summary.caddieCall),
    ).length
    const strongestClubLabel = getClubLabel(bestClubSummary.club)
    const weakestClubLabel = getClubLabel(weakestClubSummary.club)

    const leadSentence =
      bestClubSummary.caddieCall === 'Attack'
        ? `${strongestClubLabel} is carrying the bag right now, and you do not need much convincing to hit it.`
        : `${strongestClubLabel} is the cleanest option in the bag right now, the one you can lean on when the hole asks for a committed swing.`

    const depthSentence =
      strongClubCount >= 4
        ? `There is a real top tier forming, with ${strongClubCount} clubs grading out as go-to options or better.`
        : strongClubCount >= 2
          ? `You have a couple of clubs you can trust, but the rest of the bag still wants a little supervision.`
          : 'Right now this bag is living off a small handful of trustworthy answers, and the drop-off behind them is pretty obvious.'

    const weakSentence =
      weakestClubSummary.caddieCall === 'Liability'
        ? `${weakestClubLabel} is the one making you pay for bad decisions, so that club needs the conservative line until it earns its way back in.`
        : `${weakestClubLabel} is still the club asking the hardest questions, so keep that one on a shorter leash.`

    const moverSentence = biggestMover
      ? `${getClubLabel(biggestMover.club)} is ${biggestMover.delta >= 0 ? 'moving the right way' : 'slipping a bit'}, and that trend is worth watching before it becomes the whole conversation.`
      : 'The bag shape is settling in, even if the trend line is still young.'

    return `${leadSentence} ${depthSentence} ${weakSentence} ${moverSentence}`
  }, [bestClubSummary, biggestMover, dashboardSummaries, weakestClubSummary])

  const spotlightCards = useMemo(() => {
    if (!bestClubSummary) {
      return []
    }

    const strongestDriver = strongestComponentLabel(
      bestClubSummary.componentScores,
      'high',
    )
    const weakestDriver = weakestClubSummary
      ? strongestComponentLabel(weakestClubSummary.componentScores, 'low')
      : null

    return [
      {
        key: 'spotlight-on-your-game',
        title: 'Spotlight on Your Game',
        accent: bestClubSummary.caddieCall,
        summary: `${getClubLabel(bestClubSummary.club)} is the clearest go-to club in the bag right now.`,
        bullets: [
          `${bestClubSummary.caddieCall} at ${formatScore(bestClubSummary.caddieScore)} with ${bestClubSummary.includedShots} included shots.`,
          `${strongestDriver} is carrying the read.`,
        ],
      },
      {
        key: 'trend-to-watch',
        title: 'Trend to Watch',
        accent:
          biggestMover?.summary.caddieCall ??
          weakestClubSummary?.caddieCall ??
          'Insufficient Data',
        summary: biggestMover
          ? `${getClubLabel(biggestMover.club)} is the club moving the fastest against the prior session.`
          : weakestClubSummary
            ? `${getClubLabel(weakestClubSummary.club)} is still the area that needs the most attention.`
            : 'Keep building the read.',
        bullets: [
          biggestMover
            ? `${getClubLabel(biggestMover.club)} is ${biggestMover.delta >= 0 ? 'moving up' : 'slipping'} ${Math.abs(Math.round(biggestMover.delta))} points versus the prior session.`
            : 'No prior-session comparison yet.',
          weakestClubSummary
            ? `${getClubLabel(weakestClubSummary.club)} is ${weakestClubSummary.caddieCall.toLowerCase()} right now. Biggest drag is ${weakestDriver}.`
            : 'More sessions will sharpen the bag shape.',
        ],
      },
    ]
  }, [bestClubSummary, biggestMover, weakestClubSummary])

  const groupInsights = useMemo(() => {
    const scoresByGroup = new Map<string, number[]>()

    dashboardSummaries.forEach((summary) => {
      const group = clubGroupLabel(summary.club)
      scoresByGroup.set(group, [...(scoresByGroup.get(group) ?? []), summary.caddieScore])
    })

    const rankedGroups = [...scoresByGroup.entries()]
      .map(([group, scores]) => ({
        group,
        averageScore: scores.reduce((sum, score) => sum + score, 0) / scores.length,
      }))
      .sort((left, right) => right.averageScore - left.averageScore)

    return {
      strongest: rankedGroups[0] ?? null,
      weakest: rankedGroups[rankedGroups.length - 1] ?? null,
    }
  }, [dashboardSummaries])

  const scoreSpread =
    bestClubSummary && weakestClubSummary
      ? bestClubSummary.caddieScore - weakestClubSummary.caddieScore
      : null

  useEffect(() => {
    if (sessionState !== 'review') {
      return
    }

    const hasSelection = dashboardClubCards.some((card) => card.club === selectedDetailClub)
    if (hasSelection) {
      return
    }

    const fallbackClub =
      dashboardClubCards.find((card) => card.summary !== null)?.club ?? activeBagClubIds[0]
    setSelectedDetailClub(fallbackClub)
  }, [dashboardClubCards, selectedDetailClub, sessionState])

  const selectedClubSummary = dashboardSummariesByClub.get(selectedDetailClub) ?? null
  const selectedClubHistoricalShots = useMemo(
    () =>
      analysisSessions.flatMap((session) =>
        session.shots.filter((shot) => shot.club === selectedDetailClub),
      ),
    [analysisSessions, selectedDetailClub],
  )

  const selectedClubHistoricalShotWeights = useMemo(() => {
    const map = new Map<string, number>()
    analysisSessions.forEach((session) => {
      const clubIncludedCount = includedClubShotsForSession(session, selectedDetailClub).length
      const sessionWeight = sessionHistoricalWeightForClub(
        session,
        selectedDetailClub,
        historicalModelNowMs,
      )
      const normalizedShotWeight =
        clubIncludedCount > 0 ? sessionWeight / clubIncludedCount : 0
      session.shots.forEach((shot) => {
        if (shot.club === selectedDetailClub && !map.has(shot.id)) {
          map.set(shot.id, normalizedShotWeight)
        }
      })
    })
    return map
  }, [analysisSessions, historicalModelNowMs, selectedDetailClub])

  const selectedClubMetrics = useMemo(() => {
    const shotWeights = selectedClubHistoricalShots.map(
      (shot) => selectedClubHistoricalShotWeights.get(shot.id) ?? 1,
    )
    const carryAverage = guardedWeightedCarryMean(
      selectedClubHistoricalShots.map(carryValue),
      shotWeights,
      confidenceConfig.displayCarryOutlierThresholdPct,
      confidenceConfig.displayCarryOutlierThresholdFloorYards,
    )
    const totalAverage = weightedAverageNumbers(
      selectedClubHistoricalShots.map(totalValue),
      shotWeights,
    )
    const offlineAverage = weightedAverageNumbers(
      selectedClubHistoricalShots.map(offlineValue),
      shotWeights,
    )
    const offlineStdDeviation = weightedStandardDeviationNumbers(
      selectedClubHistoricalShots.map(offlineValue),
      shotWeights,
    )
    const vlaAverage = weightedAverageNumbers(
      selectedClubHistoricalShots.map(launchValue),
      shotWeights,
    )
    const spinAverage = weightedAverageNumbers(
      selectedClubHistoricalShots.map(spinValue),
      shotWeights,
    )
    const descentAverage = weightedAverageNumbers(
      selectedClubHistoricalShots.map(descentValue),
      shotWeights,
    )
    const includedShotCount = selectedClubHistoricalShots.filter((shot) => shot.included).length
    const enrichedShotCount = selectedClubHistoricalShots.filter(
      (shot) => shot.enrichmentStatus === 'enriched' && shot.openGolfCoach,
    ).length
    const shotRankSummary =
      selectedClubSummary?.shotRankSummary ??
      (() => {
        const rankCounts = new Map<string, number>()
        selectedClubHistoricalShots.forEach((shot) => {
          if (typeof shot.shotRanking === 'undefined') {
            return
          }
          const rank = normalizeShotRank(shot.shotRanking) ?? `${shot.shotRanking}`
          rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1)
        })
        if (rankCounts.size === 0) {
          return 'No rank data yet'
        }
        return [...rankCounts.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 3)
          .map(([rank, count]) => `${rank} (${count})`)
          .join(', ')
      })()

    return {
      carryAverage,
      totalAverage,
      offlineAverage,
      offlineStdDeviation,
      vlaAverage,
      spinAverage,
      descentAverage,
      includedShotCount,
      enrichedShotCount,
      shotRankSummary,
    }
  }, [
    selectedClubHistoricalShots,
    selectedClubHistoricalShotWeights,
    selectedClubSummary,
  ])

  const selectedClubSessionSeries = useMemo(
    () =>
      [...analysisSessions]
        .reverse()
        .map((session) => {
          const clubShots = session.shots.filter((shot) => shot.club === selectedDetailClub)
          if (clubShots.length === 0) {
            return null
          }

          const summary = summarizeReviewClub(
            selectedDetailClub,
            session.shots,
            analysisSessions.filter((savedSession) => savedSession.id !== session.id),
            session.id,
          )

          const carryAverage = averageNumbers(clubShots.map(carryValue))
          const offlineAverage = averageNumbers(clubShots.map(offlineValue))
          const dispersion = standardDeviation(clubShots.map(offlineValue))
          const bias = averageNumbers(clubShots.map(offlineValue))
          const vlaAverage = averageNumbers(clubShots.map(launchValue))
          const spinAverage = averageNumbers(clubShots.map(spinValue))
          const descentAverage = averageNumbers(clubShots.map(descentValue))

          return {
            id: session.id,
            endedAt: session.endedAt,
            shotCount: clubShots.length,
            score: summary?.caddieScore,
            confidence: summary?.componentScores.dataConfidence,
            carryAverage,
            offlineAverage,
            dispersion,
            bias,
            vlaAverage,
            spinAverage,
            descentAverage,
          }
        })
        .filter((point): point is NonNullable<typeof point> => point !== null),
    [analysisSessions, selectedDetailClub],
  )

  const sessionWeightedAverageForSelectedClub = (
    session: SavedSession,
    extractor: (shot: Shot) => number | undefined,
    rankWeightedWithinSession = false,
  ) =>
    weightedSessionMetricAverage(
      session,
      selectedDetailClub,
      extractor,
      rankWeightedWithinSession ? (shot) => rankWeightForShot(shot) : undefined,
    )

  const sessionWeightedCarryForSelectedClub = (
    session: SavedSession,
    rankWeightedWithinSession = false,
  ) => {
    const carryShots = session.shots.filter(
      (shot) =>
        shot.club === selectedDetailClub &&
        shot.included &&
        typeof carryValue(shot) === 'number',
    )
    if (carryShots.length === 0) {
      return undefined
    }
    return guardedWeightedCarryMean(
      carryShots.map(carryValue),
      carryShots.map((shot) => (rankWeightedWithinSession ? rankWeightForShot(shot) : 1)),
      confidenceConfig.displayCarryOutlierThresholdPct,
      confidenceConfig.displayCarryOutlierThresholdFloorYards,
    )
  }

  const sessionWeightedStdDevForSelectedClub = (
    session: SavedSession,
    extractor: (shot: Shot) => number | undefined,
    rankWeightedWithinSession = false,
  ) => {
    const clubShots = session.shots.filter(
      (shot) =>
        shot.club === selectedDetailClub &&
        shot.included &&
        typeof extractor(shot) === 'number',
    )
    if (clubShots.length === 0) {
      return undefined
    }
    return weightedStandardDeviationNumbers(
      clubShots.map(extractor),
      clubShots.map((shot) => (rankWeightedWithinSession ? rankWeightForShot(shot) : 1)),
    )
  }

  const weightedRecentBaselineForSelectedClubMetric = (
    sessionMetric: (session: SavedSession) => number | undefined,
  ) => {
    const orderedSessions = [...analysisSessions].sort(
      (left, right) => new Date(right.endedAt).getTime() - new Date(left.endedAt).getTime(),
    )
    const latestClubSession = orderedSessions.find((session) =>
      typeof sessionMetric(session) === 'number',
    )
    if (!latestClubSession) {
      return null
    }

    const weightedRecentValue = sessionMetric(latestClubSession)
    const baselinePoints = orderedSessions
      .filter((session) => session.id !== latestClubSession.id)
      .map((session) => ({
        value: sessionMetric(session),
        weight: sessionHistoricalWeightForClub(
          session,
          selectedDetailClub,
          historicalModelNowMs,
        ),
      }))
      .filter(
        (point): point is { value: number; weight: number } =>
          typeof point.value === 'number' && Number.isFinite(point.value) && point.weight > 0,
      )

    const weightedBaselineValue = weightedAverageNumbers(
      baselinePoints.map((point) => point.value),
      baselinePoints.map((point) => point.weight),
    )

    if (
      typeof weightedRecentValue !== 'number' ||
      !Number.isFinite(weightedRecentValue) ||
      typeof weightedBaselineValue !== 'number' ||
      !Number.isFinite(weightedBaselineValue)
    ) {
      return null
    }

    return {
      weightedRecentValue,
      weightedBaselineValue,
      delta: weightedRecentValue - weightedBaselineValue,
    }
  }

  const baselineComparison = useMemo(() => {
    if (selectedClubSessionSeries.length === 0) {
      return null
    }

    const latest = selectedClubSessionSeries[selectedClubSessionSeries.length - 1]
    const prior =
      selectedClubSessionSeries.length > 1
        ? selectedClubSessionSeries[selectedClubSessionSeries.length - 2]
        : null

    const scoreComparison = (() => {
      const latestSummary = latestSessionSummariesByClub.get(selectedDetailClub)
      const baseline = historicalAveragesByClub.get(selectedDetailClub)?.score
      if (typeof latestSummary?.caddieScore !== 'number' || typeof baseline !== 'number') {
        return undefined
      }
      return latestSummary.caddieScore - baseline
    })()

    const carryComparison = weightedRecentBaselineForSelectedClubMetric((session) =>
      sessionWeightedCarryForSelectedClub(session, false),
    )
    const dispersionComparison = weightedRecentBaselineForSelectedClubMetric((session) =>
      sessionWeightedStdDevForSelectedClub(session, offlineValue, false),
    )

    return {
      latest,
      prior,
      scoreDelta: scoreComparison,
      carryDelta: carryComparison?.delta,
      offlineDelta: dispersionComparison?.delta,
    }
  }, [
    analysisSessions,
    historicalAveragesByClub,
    latestSessionSummariesByClub,
    selectedClubSessionSeries,
    selectedDetailClub,
    sessionWeightedCarryForSelectedClub,
    sessionWeightedStdDevForSelectedClub,
    weightedRecentBaselineForSelectedClubMetric,
  ])

  const trendCards = useMemo(() => {
    const formatDelta = (delta: number | undefined, unit: string) => {
      if (typeof delta !== 'number') {
        return 'No weighted baseline'
      }
      const rounded = Math.abs(delta).toFixed(1)
      return `${delta >= 0 ? '+' : '-'}${rounded}${unit} vs weighted baseline`
    }

    const carryTrend = weightedRecentBaselineForSelectedClubMetric((session) =>
      sessionWeightedCarryForSelectedClub(session, false),
    )
    const offlineTrend = weightedRecentBaselineForSelectedClubMetric((session) =>
      sessionWeightedStdDevForSelectedClub(session, offlineValue, false),
    )
    const biasTrend = weightedRecentBaselineForSelectedClubMetric((session) =>
      sessionWeightedAverageForSelectedClub(session, offlineValue, false),
    )
    const vlaTrend = weightedRecentBaselineForSelectedClubMetric((session) =>
      sessionWeightedAverageForSelectedClub(session, launchValue, false),
    )
    const spinTrend = weightedRecentBaselineForSelectedClubMetric((session) =>
      sessionWeightedAverageForSelectedClub(session, spinValue, false),
    )

    const cards = [
      {
        key: 'carry',
        label: 'Carry',
        series: selectedClubSessionSeries
          .map((point) => point.carryAverage)
          .filter((value): value is number => typeof value === 'number'),
        value:
          carryTrend && typeof carryTrend.weightedRecentValue === 'number'
            ? `${formatDecimal(carryTrend.weightedRecentValue, ' yd')}`
            : '-',
        detail:
          carryTrend && typeof carryTrend.weightedRecentValue === 'number'
            ? formatDelta(carryTrend.delta, ' yd')
            : 'No carry trend yet',
      },
      {
        key: 'offline-dispersion',
        label: 'Offline / Dispersion',
        series: selectedClubSessionSeries
          .map((point) => point.dispersion)
          .filter((value): value is number => typeof value === 'number'),
        value:
          offlineTrend && typeof offlineTrend.weightedRecentValue === 'number'
            ? `${formatDecimal(offlineTrend.weightedRecentValue, ' yd')}`
            : '-',
        detail:
          offlineTrend && typeof offlineTrend.weightedRecentValue === 'number'
            ? formatDelta(offlineTrend.delta, ' yd')
            : 'No dispersion trend yet',
      },
      {
        key: 'bias',
        label: 'Bias',
        series: selectedClubSessionSeries
          .map((point) => point.bias)
          .filter((value): value is number => typeof value === 'number'),
        value:
          biasTrend && typeof biasTrend.weightedRecentValue === 'number'
            ? `${biasTrend.weightedRecentValue >= 0 ? 'Right' : 'Left'} ${formatDecimal(Math.abs(biasTrend.weightedRecentValue), ' yd')}`
            : '-',
        detail:
          biasTrend && typeof biasTrend.weightedRecentValue === 'number'
            ? formatDelta(biasTrend.delta, ' yd')
            : 'No bias trend yet',
      },
      {
        key: 'vla',
        label: 'VLA',
        series: selectedClubSessionSeries
          .map((point) => point.vlaAverage)
          .filter((value): value is number => typeof value === 'number'),
        value:
          vlaTrend && typeof vlaTrend.weightedRecentValue === 'number'
            ? `${formatDecimal(vlaTrend.weightedRecentValue, ' deg')}`
            : '-',
        detail:
          vlaTrend && typeof vlaTrend.weightedRecentValue === 'number'
            ? formatDelta(vlaTrend.delta, ' deg')
            : 'No launch trend yet',
      },
      {
        key: 'spin',
        label: 'Spin',
        series: selectedClubSessionSeries
          .map((point) => point.spinAverage)
          .filter((value): value is number => typeof value === 'number'),
        value:
          spinTrend && typeof spinTrend.weightedRecentValue === 'number'
            ? `${formatWhole(spinTrend.weightedRecentValue, ' rpm')}`
            : '-',
        detail:
          spinTrend && typeof spinTrend.weightedRecentValue === 'number'
            ? formatDelta(spinTrend.delta, ' rpm')
            : 'No spin trend yet',
      },
    ]

    return cards
  }, [
    selectedClubSessionSeries,
    sessionWeightedAverageForSelectedClub,
    sessionWeightedCarryForSelectedClub,
    sessionWeightedStdDevForSelectedClub,
    weightedRecentBaselineForSelectedClubMetric,
  ])

  const selectedClubInsights = useMemo(() => {
    if (!selectedClubSummary) {
      return [
        'Build more sessions for this club so the read can separate stable outcomes from noise.',
      ]
    }

    const biasAverage = selectedClubMetrics.offlineAverage
    const biasLine =
      typeof biasAverage === 'number'
        ? `Ball flight is averaging ${biasAverage >= 0 ? 'right' : 'left'} by ${formatDecimal(Math.abs(biasAverage), ' yd')}.`
        : 'Directional bias is still forming.'

    const dispersionLine =
      typeof selectedClubMetrics.offlineStdDeviation === 'number'
        ? `Dispersion is ${formatDecimal(selectedClubMetrics.offlineStdDeviation, ' yd')} wide, so start line discipline is the biggest lever.`
        : 'Dispersion needs more shots before the pattern locks in.'

    const enrichmentLine =
      selectedClubMetrics.enrichedShotCount > 0
        ? `${formatWhole(selectedClubMetrics.enrichedShotCount)} shots are OpenGolfCoach-enriched, giving this read full modeled support.`
        : 'OpenGolfCoach enrichment has not landed for this club yet.'

    return [selectedClubSummary.explanation, biasLine, dispersionLine, enrichmentLine].slice(
      0,
      3,
    )
  }, [selectedClubMetrics, selectedClubSummary])

  const selectedClubNarrative = useMemo(() => {
    if (!selectedClubSummary) {
      return `There is not enough included data on ${getClubLabel(selectedDetailClub)} yet to give a confident read.`
    }

    const carryLine =
      typeof selectedClubMetrics.carryAverage === 'number'
        ? `Carry is averaging ${formatDecimal(selectedClubMetrics.carryAverage, ' yd')}`
        : 'Carry still needs more confirmed shots'
    const dispersionLine =
      typeof selectedClubMetrics.offlineStdDeviation === 'number'
        ? `with ${formatDecimal(selectedClubMetrics.offlineStdDeviation, ' yd')} of offline dispersion`
        : 'with dispersion still forming'

    return `${getClubLabel(selectedDetailClub)} is currently a ${selectedClubSummary.caddieCall.toLowerCase()} club at ${formatScore(selectedClubSummary.caddieScore)}. ${carryLine} ${dispersionLine}, and ${selectedClubSummary.insights[0] ?? 'the pattern is becoming clearer session over session.'}`
  }, [selectedClubMetrics.carryAverage, selectedClubMetrics.offlineStdDeviation, selectedClubSummary, selectedDetailClub])

  const selectedClubDispersionPoints = useMemo(
    () =>
      selectedClubHistoricalShots.flatMap((shot) => {
        const carry = carryValue(shot)
        const offline = offlineValue(shot)
        if (typeof carry !== 'number' || typeof offline !== 'number') {
          return []
        }

        return [{ id: shot.id, carry, offline, included: shot.included }]
      }),
    [selectedClubHistoricalShots],
  )

  const looperRead = useMemo(() => {
    if (!selectedClubSummary) {
      return {
        primary: `${getClubLabel(selectedDetailClub)} is still finding its shape.`,
        explanation: 'The pattern is not settled yet, so this one is still a cautious play.',
        implication: 'Take the bigger side of the target and keep the miss simple.',
      }
    }

    const components: Array<
      [keyof Pick<ReviewClubSummary['componentScores'], 'distanceWindow' | 'directionWindow' | 'flightQuality' | 'patternStability'>, number]
    > = [
      [
        'patternStability',
        typeof selectedClubSummary.componentScores.patternStability === 'number'
          ? selectedClubSummary.componentScores.patternStability
          : 0,
      ],
      ['directionWindow', selectedClubSummary.componentScores.directionWindow],
      ['distanceWindow', selectedClubSummary.componentScores.distanceWindow],
      [
        'flightQuality',
        typeof selectedClubSummary.componentScores.flightQuality === 'number'
          ? selectedClubSummary.componentScores.flightQuality
          : 0,
      ],
    ]

    const ranked = [...components].sort((left, right) => right[1] - left[1])
    const strongest = ranked[0][0]
    const weakest = ranked[ranked.length - 1][0]

    const plainLabel = (
      key: 'distanceWindow' | 'directionWindow' | 'flightQuality' | 'patternStability',
    ) => {
      switch (key) {
        case 'patternStability':
          return 'pattern trend'
        case 'directionWindow':
          return 'direction control'
        case 'distanceWindow':
          return 'carry expectation'
        case 'flightQuality':
          return 'shot behavior'
      }
    }

    switch (selectedClubSummary.caddieCall) {
      case 'Attack':
        return {
          primary: `${getClubLabel(selectedDetailClub)} is giving you a proper green light right now.`,
          explanation: `${capitalizeFirst(plainLabel(strongest))} is holding, and ${plainLabel(weakest)} is only a touch loose.`,
          implication: 'Trust the stock swing and go right at it.',
        }
      case 'Play':
        return {
          primary: `${getClubLabel(selectedDetailClub)} is playable, but it wants a bit of management.`,
          explanation: "Flight's holding, but carry still drifts a touch.",
          implication: 'Play to the fat side and let it earn your trust before you go flag hunting.',
        }
      case 'Manage':
        return {
          primary: `${getClubLabel(selectedDetailClub)} is playable, but it wants a bit of management.`,
          explanation: "Flight's holding, but carry still drifts a touch.",
          implication: 'Play to the fat side and let it earn your trust before you go flag hunting.',
        }
      case 'Careful':
        return {
          primary: `${getClubLabel(selectedDetailClub)} is in careful territory at the minute.`,
          explanation: `${capitalizeFirst(plainLabel(weakest))} is loose enough to bring trouble in quickly.`,
          implication: 'Use a conservative target and keep risk out of the miss.',
        }
      case 'Liability':
        return {
          primary: `${getClubLabel(selectedDetailClub)} is behaving like a troublemaker right now.`,
          explanation: `${capitalizeFirst(plainLabel(weakest))} is leaking, and the overall pattern is not steady enough.`,
          implication: 'Step to a safer club unless the hole leaves you no choice.',
        }
      case 'Insufficient Data':
        return {
          primary: `${getClubLabel(selectedDetailClub)} is still writing its story.`,
          explanation: 'There is not enough clean evidence yet to call this one stable or loose.',
          implication: 'Keep the target simple while this read builds.',
        }
    }
  }, [selectedClubSummary, selectedDetailClub])

  const selectedClubComponentBreakdown = useMemo(() => {
    const history = historicalAveragesByClub.get(selectedDetailClub)
    const scores = selectedClubSummary?.componentScores
    const orderedKeys = componentDisplayOrder

    return orderedKeys.map((key) => {
      const rawValue = scores?.[key]
      const value = typeof rawValue === 'number' ? rawValue : undefined
      const historical =
        typeof history?.[key] === 'number' ? (history[key] as number) : undefined
      const delta =
        typeof value === 'number' && typeof historical === 'number'
          ? value - historical
          : undefined
      return {
        key,
        label: componentLabel(key),
        value,
        delta,
        direction: comparisonDirection(delta),
        tone: comparisonTone(delta, comparisonTolerance.component),
      }
    })
  }, [historicalAveragesByClub, selectedClubSummary, selectedDetailClub])

  const selectedClubPerformanceDrivers = useMemo(() => {
    const history = historicalAveragesByClub.get(selectedDetailClub)
    const scores = selectedClubSummary?.componentScores

    const buildDriverCopy = (key: ClubDriverKey, score?: number) => {
      const stable = typeof score === 'number' && score >= 70
      const playable = typeof score === 'number' && score >= 50 && score < 70

      switch (key) {
        case 'patternStability':
          return {
            why: stable
              ? 'You are seeing a repeatable shot shape more often than not.'
              : playable
                ? 'The pattern shows up, but it still comes and goes.'
                : 'This shape is still too streaky from swing to swing.',
            meaning: stable
              ? 'You can trust this club for a committed stock swing.'
              : playable
                ? 'Pick safer targets and avoid forcing shape.'
                : 'Treat this as a conservative option until the shape settles.',
          }
        case 'directionWindow':
          return {
            why: stable
              ? 'Start lines are holding the target corridor.'
              : playable
                ? 'Start lines are close, with the odd leak.'
                : 'The left-right window is still wandering too much.',
            meaning: stable
              ? 'You can aim tighter when the shot calls for it.'
              : playable
                ? 'Favor the fat side and keep the miss in play.'
                : 'Build in extra room and avoid short-side misses.',
          }
        case 'distanceWindow':
          return {
            why: stable
              ? 'Carry is landing in a reliable window.'
              : playable
                ? 'Carry is mostly there, with a little jump now and then.'
                : 'Carry is still jumpy for precise targets.',
            meaning: stable
              ? 'This club can be used with confident yardage intent.'
              : playable
                ? 'Club up or down based on safe coverage, not perfect number hunting.'
                : 'Use this club where a little distance drift is acceptable.',
          }
        case 'flightQuality':
          return {
            why: stable
              ? 'Flight is behaving in a playable, repeatable window.'
              : playable
                ? 'Flight is usable, but not fully settled yet.'
                : 'Flight shape is still loose under pressure swings.',
            meaning: stable
              ? 'You can lean on this shape when you need a predictable flight.'
              : playable
                ? 'Keep the shot simple and avoid over-shaping.'
                : 'Play for control first while flight cleans up.',
          }
        case 'dataConfidence':
          return {
            why: stable
              ? 'You have enough clean shots for a trustworthy read.'
              : playable
                ? 'The read is useful, but still building support.'
                : 'There is not enough clean evidence to be fully sure yet.',
            meaning: stable
              ? 'You can make decisions off this profile with confidence.'
              : playable
                ? 'Use the read as guidance, not gospel.'
                : 'Default to safer decisions until more shots confirm the pattern.',
          }
      }
    }

    const rows: Array<{
      key: ClubDriverKey
      label: string
      value?: number
      delta?: number
      direction: ComparisonDirection
      tone: ComparisonTone
      why: string
      meaning: string
    }> = [
      {
        key: 'patternStability',
        label: componentLabel('patternStability'),
        value:
          typeof scores?.patternStability === 'number'
            ? scores.patternStability
            : undefined,
        delta:
          typeof scores?.patternStability === 'number' &&
          typeof history?.patternStability === 'number'
            ? scores.patternStability - history.patternStability
            : undefined,
        direction: comparisonDirection(
          typeof scores?.patternStability === 'number' &&
            typeof history?.patternStability === 'number'
            ? scores.patternStability - history.patternStability
            : undefined,
        ),
        tone: comparisonTone(
          typeof scores?.patternStability === 'number' &&
            typeof history?.patternStability === 'number'
            ? scores.patternStability - history.patternStability
            : undefined,
          comparisonTolerance.component,
        ),
        ...buildDriverCopy(
          'patternStability',
          typeof scores?.patternStability === 'number'
            ? scores.patternStability
            : undefined,
        ),
      },
      {
        key: 'directionWindow',
        label: componentLabel('directionWindow'),
        value: scores?.directionWindow,
        delta:
          typeof scores?.directionWindow === 'number' &&
          typeof history?.directionWindow === 'number'
            ? scores.directionWindow - history.directionWindow
            : undefined,
        direction: comparisonDirection(
          typeof scores?.directionWindow === 'number' &&
            typeof history?.directionWindow === 'number'
            ? scores.directionWindow - history.directionWindow
            : undefined,
        ),
        tone: comparisonTone(
          typeof scores?.directionWindow === 'number' &&
            typeof history?.directionWindow === 'number'
            ? scores.directionWindow - history.directionWindow
            : undefined,
          comparisonTolerance.component,
        ),
        ...buildDriverCopy('directionWindow', scores?.directionWindow),
      },
      {
        key: 'distanceWindow',
        label: componentLabel('distanceWindow'),
        value: scores?.distanceWindow,
        delta:
          typeof scores?.distanceWindow === 'number' &&
          typeof history?.distanceWindow === 'number'
            ? scores.distanceWindow - history.distanceWindow
            : undefined,
        direction: comparisonDirection(
          typeof scores?.distanceWindow === 'number' &&
            typeof history?.distanceWindow === 'number'
            ? scores.distanceWindow - history.distanceWindow
            : undefined,
        ),
        tone: comparisonTone(
          typeof scores?.distanceWindow === 'number' &&
            typeof history?.distanceWindow === 'number'
            ? scores.distanceWindow - history.distanceWindow
            : undefined,
          comparisonTolerance.component,
        ),
        ...buildDriverCopy('distanceWindow', scores?.distanceWindow),
      },
      {
        key: 'flightQuality',
        label: componentLabel('flightQuality'),
        value:
          typeof scores?.flightQuality === 'number' ? scores.flightQuality : undefined,
        delta:
          typeof scores?.flightQuality === 'number' &&
          typeof history?.flightQuality === 'number'
            ? scores.flightQuality - history.flightQuality
            : undefined,
        direction: comparisonDirection(
          typeof scores?.flightQuality === 'number' &&
            typeof history?.flightQuality === 'number'
            ? scores.flightQuality - history.flightQuality
            : undefined,
        ),
        tone: comparisonTone(
          typeof scores?.flightQuality === 'number' &&
            typeof history?.flightQuality === 'number'
            ? scores.flightQuality - history.flightQuality
            : undefined,
          comparisonTolerance.component,
        ),
        ...buildDriverCopy(
          'flightQuality',
          typeof scores?.flightQuality === 'number' ? scores.flightQuality : undefined,
        ),
      },
      {
        key: 'dataConfidence',
        label: componentLabel('dataConfidence'),
        value: scores?.dataConfidence,
        delta:
          typeof scores?.dataConfidence === 'number' &&
          typeof history?.dataConfidence === 'number'
            ? scores.dataConfidence - history.dataConfidence
            : undefined,
        direction: comparisonDirection(
          typeof scores?.dataConfidence === 'number' &&
            typeof history?.dataConfidence === 'number'
            ? scores.dataConfidence - history.dataConfidence
            : undefined,
        ),
        tone: comparisonTone(
          typeof scores?.dataConfidence === 'number' &&
            typeof history?.dataConfidence === 'number'
            ? scores.dataConfidence - history.dataConfidence
            : undefined,
          comparisonTolerance.component,
        ),
        ...buildDriverCopy('dataConfidence', scores?.dataConfidence),
      },
    ]

    return [...rows].sort(
      (left, right) =>
        componentDisplayOrder.indexOf(left.key) -
        componentDisplayOrder.indexOf(right.key),
    )
  }, [historicalAveragesByClub, selectedDetailClub, selectedClubSummary])

  const selectedClubBallFlightRows = useMemo(() => {
    const pickLaunchRead = (value: number | undefined) => {
      if (typeof value !== 'number') {
        return 'Not enough launch data yet.'
      }
      if (value < 11) {
        return 'Launch is low.'
      }
      if (value > 18) {
        return 'Launch is slightly high.'
      }
      return 'Launch is in range.'
    }

    const pickSpinRead = (value: number | undefined) => {
      if (typeof value !== 'number') {
        return 'Spin data is still building.'
      }
      if (value < 3800) {
        return 'Spin is on the low side.'
      }
      if (value > 7200) {
        return 'Spin is running high.'
      }
      return 'Spin is in range.'
    }

    const pickDescentRead = (value: number | undefined) => {
      if (typeof value !== 'number') {
        return 'Descent data is not available yet.'
      }
      if (value < 35) {
        return 'Descent is a little flat.'
      }
      if (value > 52) {
        return 'Descent is landing on the steep side.'
      }
      return 'Descent angle looks playable.'
    }

    const pickCarryRead = (value: number | undefined) => {
      if (typeof value !== 'number') {
        return 'Carry window needs more shots.'
      }
      const spread = selectedClubMetrics.offlineStdDeviation
      if (typeof spread === 'number' && spread <= 8) {
        return 'Carry is stable.'
      }
      if (typeof spread === 'number' && spread > 14) {
        return 'Carry is a touch loose.'
      }
      return 'Carry is in a workable window.'
    }

    return [
      {
        key: 'launch',
        label: 'Launch (VLA)',
        value:
          typeof selectedClubMetrics.vlaAverage === 'number'
            ? formatDecimal(selectedClubMetrics.vlaAverage, ' deg')
            : '-',
        interpretation: pickLaunchRead(selectedClubMetrics.vlaAverage),
      },
      {
        key: 'spin',
        label: 'Spin',
        value:
          typeof selectedClubMetrics.spinAverage === 'number'
            ? formatWhole(selectedClubMetrics.spinAverage, ' rpm')
            : '-',
        interpretation: pickSpinRead(selectedClubMetrics.spinAverage),
      },
      {
        key: 'descent',
        label: 'Descent Angle',
        value:
          typeof selectedClubMetrics.descentAverage === 'number'
            ? formatDecimal(selectedClubMetrics.descentAverage, ' deg')
            : '-',
        interpretation: pickDescentRead(selectedClubMetrics.descentAverage),
      },
      {
        key: 'carry',
        label: 'Carry',
        value:
          typeof selectedClubMetrics.carryAverage === 'number'
            ? formatDecimal(selectedClubMetrics.carryAverage, ' yd')
            : '-',
        interpretation: pickCarryRead(selectedClubMetrics.carryAverage),
      },
    ]
  }, [
    selectedClubMetrics.carryAverage,
    selectedClubMetrics.descentAverage,
    selectedClubMetrics.offlineStdDeviation,
    selectedClubMetrics.spinAverage,
    selectedClubMetrics.vlaAverage,
  ])

  const selectedClubDeliveryRows = useMemo(() => {
    const shotWeights = selectedClubHistoricalShots.map(
      (shot) => selectedClubHistoricalShotWeights.get(shot.id) ?? 1,
    )
    const clubPathAvg = weightedAverageNumbers(
      selectedClubHistoricalShots.map(clubPathValue),
      shotWeights,
    )
    const faceToPathAvg = weightedAverageNumbers(
      selectedClubHistoricalShots.map(faceToPathValue),
      shotWeights,
    )
    const faceToTargetAvg = weightedAverageNumbers(
      selectedClubHistoricalShots.map(faceToTargetValue),
      shotWeights,
    )
    const smashAvg = weightedAverageNumbers(
      selectedClubHistoricalShots.map(smashFactorValue),
      shotWeights,
    )
    const clubSpeedAvg = weightedAverageNumbers(
      selectedClubHistoricalShots.map(clubSpeedValue),
      shotWeights,
    )
    const ballSpeedAvg = weightedAverageNumbers(
      selectedClubHistoricalShots.map(ballSpeedMphValue),
      shotWeights,
    )
    const peakHeightAvg = weightedAverageNumbers(
      selectedClubHistoricalShots.map(peakHeightValue),
      shotWeights,
    )

    const faceRead = (value: number | undefined) => {
      if (typeof value !== 'number') {
        return 'Still building.'
      }
      if (Math.abs(value) <= 1) {
        return 'Holding near neutral.'
      }
      return value > 0 ? 'Tending open.' : 'Tending closed.'
    }

    const pathRead = (value: number | undefined) => {
      if (typeof value !== 'number') {
        return 'Still building.'
      }
      if (Math.abs(value) <= 1.5) {
        return 'Path is fairly neutral.'
      }
      return value > 0 ? 'Path is moving out-to-in.' : 'Path is moving in-to-out.'
    }

    const smashRead = (value: number | undefined) => {
      if (typeof value !== 'number') {
        return 'No clean strike read yet.'
      }
      if (value >= 1.42) {
        return 'Contact efficiency looks strong.'
      }
      if (value >= 1.3) {
        return 'Contact is playable.'
      }
      return 'Contact is leaving speed on the table.'
    }

    const speedRead = (value: number | undefined) => {
      if (typeof value !== 'number') {
        return 'Not enough speed data yet.'
      }
      return 'Speed is stable.'
    }

    const peakRead = (value: number | undefined) => {
      if (typeof value !== 'number') {
        return 'Peak height is still building.'
      }
      if (value < 25) {
        return 'Flight is coming out flat.'
      }
      if (value > 40) {
        return 'Flight is climbing high.'
      }
      return 'Peak height is in a playable window.'
    }

    return [
      {
        key: 'club-path',
        label: 'Club Path',
        value: typeof clubPathAvg === 'number' ? formatDecimal(clubPathAvg, ' deg') : '-',
        interpretation: pathRead(clubPathAvg),
      },
      {
        key: 'face-to-path',
        label: 'Face to Path',
        value:
          typeof faceToPathAvg === 'number' ? formatDecimal(faceToPathAvg, ' deg') : '-',
        interpretation: faceRead(faceToPathAvg),
      },
      {
        key: 'face-to-target',
        label: 'Face to Target',
        value:
          typeof faceToTargetAvg === 'number' ? formatDecimal(faceToTargetAvg, ' deg') : '-',
        interpretation: faceRead(faceToTargetAvg),
      },
      {
        key: 'smash',
        label: 'Smash Factor',
        value: typeof smashAvg === 'number' ? formatDecimal(smashAvg) : '-',
        interpretation: smashRead(smashAvg),
      },
      {
        key: 'club-speed',
        label: 'Club Speed',
        value: typeof clubSpeedAvg === 'number' ? formatDecimal(clubSpeedAvg, ' mph') : '-',
        interpretation: speedRead(clubSpeedAvg),
      },
      {
        key: 'ball-speed',
        label: 'Ball Speed',
        value: typeof ballSpeedAvg === 'number' ? formatDecimal(ballSpeedAvg, ' mph') : '-',
        interpretation: speedRead(ballSpeedAvg),
      },
      {
        key: 'peak-height',
        label: 'Peak Height',
        value: typeof peakHeightAvg === 'number' ? formatDecimal(peakHeightAvg, ' yd') : '-',
        interpretation: peakRead(peakHeightAvg),
      },
    ]
  }, [selectedClubHistoricalShots, selectedClubHistoricalShotWeights])

  const selectedClubShotProfiles = useMemo(() => {
    const includedShots = selectedClubHistoricalShots.filter((shot) => shot.included)
    if (includedShots.length === 0) {
      return {
        bestAvailable: null,
        mostLikely: null,
        executionGapRows: [] as Array<{ label: string; value: string }>,
        takeaway: 'Not enough included shots to profile this club yet.',
      }
    }

    const recencyWeight = (shot: Shot) => selectedClubHistoricalShotWeights.get(shot.id) ?? 1
    const buildProfile = (
      rows: Array<{ shot: Shot; effectiveWeight: number }>,
      key: 'best' | 'likely',
    ) => {
      if (rows.length === 0) {
        return null
      }
      const shots = rows.map((row) => row.shot)
      const weights = rows.map((row) => row.effectiveWeight)
      const offline = shots.map(offlineValue)
      const absOffline = offline.map((value) =>
        typeof value === 'number' ? Math.abs(value) : undefined,
      )
      const carry = shots.map(carryValue)

      return {
        key,
        carry: guardedWeightedCarryMean(
          carry,
          weights,
          confidenceConfig.displayCarryOutlierThresholdPct,
          confidenceConfig.displayCarryOutlierThresholdFloorYards,
        ),
        total: weightedAverageNumbers(shots.map(totalValue), weights),
        offlineMean: weightedAverageNumbers(offline, weights),
        dispersion: weightedAverageNumbers(absOffline, weights),
        dispersionVariability: weightedStandardDeviationNumbers(offline, weights),
        carryVariability: weightedStandardDeviationNumbers(carry, weights),
        launch: weightedAverageNumbers(shots.map(launchValue), weights),
        hla: weightedAverageNumbers(
          shots.map((shot) => shot.horizontalLaunchAngleDegrees),
          weights,
        ),
        spin: weightedAverageNumbers(shots.map(spinValue), weights),
        smashFactor: weightedAverageNumbers(shots.map(smashFactorValue), weights),
      }
    }

    const mostLikely = buildProfile(
      includedShots.map((shot) => ({
        shot,
        effectiveWeight: recencyWeight(shot),
      })),
      'likely',
    )

    const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
    const weightedAvailableScore = (
      rows: Array<{ score: number | undefined; weight: number }>,
    ) => {
      const available = rows.filter(
        (row): row is { score: number; weight: number } =>
          typeof row.score === 'number' && Number.isFinite(row.score) && row.weight > 0,
      )
      if (available.length === 0) {
        return undefined
      }
      const weightTotal = available.reduce((sum, row) => sum + row.weight, 0)
      if (weightTotal <= 0) {
        return undefined
      }
      return available.reduce((sum, row) => sum + row.score * row.weight, 0) / weightTotal
    }

    const stockCarry = mostLikely?.carry
    const stockOfflineAbs = mostLikely?.dispersion
    const stockHlaAbs =
      typeof mostLikely?.hla === 'number' ? Math.abs(mostLikely.hla) : undefined
    const carryImprovementCap = 12
    const carryDownsideCap = 10
    const offlineImprovementCap = 10
    const offlineDownsideCap = 12
    const hlaBonusCap = 2
    const sparseSupportAllowed = includedShots.length < 4

    // Conservative tuning defaults by broad club bucket, not universal golf ideals.
    const flightFloorByClub = (() => {
      const normalizedClub = selectedDetailClub.trim().toUpperCase()
      const isDriverBucket =
        normalizedClub === 'DRIVER' || normalizedClub === 'MINI DRIVER'
      const isFairwayHybridUtilityBucket =
        /^\d+W$/.test(normalizedClub) ||
        /^\d+H$/.test(normalizedClub) ||
        normalizedClub.includes('UTILITY') ||
        normalizedClub.includes('DRIVING IRON') ||
        normalizedClub.includes('UDI')
      const isShortIronWedgeBucket =
        normalizedClub === '8I' ||
        normalizedClub === '9I' ||
        ['PW', 'GW', 'SW', 'LW'].includes(normalizedClub)
      const isLongMidIronBucket = /^[3-7]I$/.test(normalizedClub)

      if (isDriverBucket) {
        return { launch: 2.4, spin: 550 }
      }
      if (isFairwayHybridUtilityBucket) {
        return { launch: 2.1, spin: 500 }
      }
      if (isShortIronWedgeBucket) {
        return { launch: 1.3, spin: 300 }
      }
      if (isLongMidIronBucket) {
        return { launch: 1.8, spin: 425 }
      }
      return { launch: 1.8, spin: 425 }
    })()

    const launchCenter = weightedAverageNumbers(
      includedShots.map(launchValue),
      includedShots.map((shot) => recencyWeight(shot)),
    )
    const launchSpread = weightedStandardDeviationNumbers(
      includedShots.map(launchValue),
      includedShots.map((shot) => recencyWeight(shot)),
    )
    const spinCenter = weightedAverageNumbers(
      includedShots.map(spinValue),
      includedShots.map((shot) => recencyWeight(shot)),
    )
    const spinSpread = weightedStandardDeviationNumbers(
      includedShots.map(spinValue),
      includedShots.map((shot) => recencyWeight(shot)),
    )

    const coherenceScore = (
      value: number | undefined,
      center: number | undefined,
      spread: number | undefined,
      floor: number,
    ) => {
      if (typeof value !== 'number' || typeof center !== 'number') {
        return undefined
      }
      const effectiveSpread = Math.max(spread ?? 0, floor)
      const deviation = Math.abs(value - center)
      if (deviation <= effectiveSpread) {
        return 1
      }
      if (deviation >= effectiveSpread * 2.5) {
        return 0
      }
      return clamp01(1 - (deviation - effectiveSpread) / (effectiveSpread * 1.5))
    }

    const candidates = includedShots.flatMap((shot) => {
      const carry = carryValue(shot)
      const offline = offlineValue(shot)
      if (
        typeof carry !== 'number' ||
        typeof offline !== 'number' ||
        typeof stockCarry !== 'number' ||
        typeof stockOfflineAbs !== 'number'
      ) {
        return []
      }

      const carryDelta = carry - stockCarry
      const carryOutcome =
        carryDelta >= 0
          ? clamp01(carryDelta / carryImprovementCap)
          : -clamp01(Math.abs(carryDelta) / carryDownsideCap) * 0.45
      const offlineDelta = stockOfflineAbs - Math.abs(offline)
      const offlineOutcome =
        offlineDelta >= 0
          ? clamp01(offlineDelta / offlineImprovementCap)
          : -clamp01(Math.abs(offlineDelta) / offlineDownsideCap) * 0.45
      const shotHla = hlaValue(shot)
      const hlaBonus =
        typeof shotHla === 'number' && typeof stockHlaAbs === 'number'
          ? clamp01((stockHlaAbs - Math.abs(shotHla)) / hlaBonusCap)
          : undefined
      const outcomeScore =
        weightedAvailableScore([
          { score: carryOutcome, weight: 0.55 },
          { score: offlineOutcome, weight: 0.35 },
          { score: hlaBonus, weight: 0.1 },
        ]) ?? 0

      const flightScore = weightedAvailableScore([
        {
          score: coherenceScore(
            launchValue(shot),
            launchCenter,
            launchSpread,
            flightFloorByClub.launch,
          ),
          weight: 0.5,
        },
        {
          score: coherenceScore(
            spinValue(shot),
            spinCenter,
            spinSpread,
            flightFloorByClub.spin,
          ),
          weight: 0.5,
        },
      ])

      const normalizedRank = normalizeShotRank(shot.shotRanking)
      const baseStrikeScore =
        typeof normalizedRank === 'undefined'
          ? 0.5
          : clamp01(0.5 + (shotRankWeight(shot.shotRanking) - 1) * 1.2)
      const measuredOutcomeStrong =
        carryOutcome >= 0.45 && Math.abs(offline) <= Math.max(stockOfflineAbs, 6)
      const strikeScore =
        normalizedRank === 'B' && measuredOutcomeStrong
          ? Math.max(baseStrikeScore, 0.58)
          : baseStrikeScore

      const neighborCount = includedShots.reduce((count, candidate) => {
        if (candidate.id === shot.id) {
          return count
        }
        const candidateCarry = carryValue(candidate)
        const candidateOffline = offlineValue(candidate)
        if (typeof candidateCarry !== 'number' || typeof candidateOffline !== 'number') {
          return count
        }
        return Math.abs(candidateCarry - carry) <= 12 && Math.abs(candidateOffline - offline) <= 15
          ? count + 1
          : count
      }, 0)
      const supportScore =
        neighborCount <= 0 ? 0 : neighborCount === 1 ? 0.4 : neighborCount === 2 ? 0.7 : 1

      if (!sparseSupportAllowed && supportScore <= 0) {
        return []
      }

      const pureScore =
        weightedAvailableScore([
          { score: outcomeScore, weight: 0.4 },
          { score: flightScore, weight: 0.2 },
          { score: strikeScore, weight: 0.1 },
          { score: supportScore, weight: 0.3 },
        ]) ?? 0

      return [
        {
          shot,
          pureScore,
          effectiveWeight: recencyWeight(shot) * (0.7 + pureScore * 0.6),
        },
      ]
    })

    const bestSubset = (() => {
      if (candidates.length === 0) {
        return []
      }
      const ranked = [...candidates].sort((left, right) => right.pureScore - left.pureScore)
      const subsetSize = Math.min(Math.max(Math.round(ranked.length * 0.4), 3), 8)
      return ranked.slice(0, subsetSize)
    })()

    const bestAvailable = buildProfile(bestSubset, 'best')

    const numberGap = (best: number | undefined, likely: number | undefined) =>
      typeof best === 'number' && typeof likely === 'number' ? best - likely : undefined

    const carryGap = numberGap(bestAvailable?.carry, mostLikely?.carry)
    const dispersionGap = numberGap(bestAvailable?.dispersion, mostLikely?.dispersion)
    const variabilityGap = numberGap(
      bestAvailable?.dispersionVariability,
      mostLikely?.dispersionVariability,
    )
    const spinGap = numberGap(bestAvailable?.spin, mostLikely?.spin)

    const executionGapRows = [
      typeof carryGap === 'number'
        ? {
            label: 'Carry',
            value: `${carryGap >= 0 ? '+' : '-'}${Math.abs(carryGap).toFixed(1)} yd`,
          }
        : null,
      typeof dispersionGap === 'number'
        ? {
            label: 'Dispersion',
            value: `${dispersionGap >= 0 ? '+' : '-'}${Math.abs(dispersionGap).toFixed(1)} yd`,
          }
        : null,
      typeof variabilityGap === 'number'
        ? {
            label: 'Variability',
            value: `${variabilityGap >= 0 ? '+' : '-'}${Math.abs(variabilityGap).toFixed(1)} yd`,
          }
        : null,
      typeof spinGap === 'number'
        ? {
            label: 'Spin',
            value:
              Math.abs(spinGap) < 120
                ? 'Nearly unchanged'
                : `${spinGap >= 0 ? '+' : '-'}${Math.abs(Math.round(spinGap))} rpm`,
          }
        : null,
    ].filter((row): row is { label: string; value: string } => row !== null)

    const takeaway = (() => {
      if (executionGapRows.length === 0) {
        return 'Execution gap will sharpen as more clean swings come in.'
      }

      if (
        typeof dispersionGap === 'number' &&
        typeof variabilityGap === 'number' &&
        typeof carryGap === 'number' &&
        dispersionGap <= -2 &&
        variabilityGap <= -2 &&
        Math.abs(carryGap) <= 1.5
      ) {
        return 'Execution mainly tightens the miss, not the distance.'
      }

      if (
        typeof carryGap === 'number' &&
        carryGap >= 2 &&
        (typeof dispersionGap !== 'number' || dispersionGap > -1.5)
      ) {
        return 'Best swings add distance more than they tighten the miss.'
      }

      if (typeof dispersionGap === 'number' && dispersionGap <= -2) {
        return 'The gain comes mostly from reducing spread.'
      }

      if (
        typeof carryGap === 'number' &&
        typeof dispersionGap === 'number' &&
        Math.abs(carryGap) < 1 &&
        Math.abs(dispersionGap) < 1
      ) {
        return 'Most likely and best-executed outcomes are close right now.'
      }

      return 'Execution changes this club, but not in one single dimension.'
    })()

    return {
      bestAvailable,
      mostLikely,
      executionGapRows,
      takeaway,
    }
  }, [selectedClubHistoricalShotWeights, selectedClubHistoricalShots, selectedDetailClub])

  const selectedDetailIncludedShots = useMemo(
    () =>
      selectedClubHistoricalShots
        .filter((shot) => shot.included)
        .sort((left, right) => {
          const leftTime = new Date(left.capturedAt).getTime()
          const rightTime = new Date(right.capturedAt).getTime()
          return leftTime - rightTime
        }),
    [selectedClubHistoricalShots],
  )

  const selectedClubLatestSessionIncludedShotCount = useMemo(() => {
    const orderedSessions = [...analysisSessions].sort(
      (left, right) => new Date(right.endedAt).getTime() - new Date(left.endedAt).getTime(),
    )
    const latestClubSession = orderedSessions.find((session) =>
      session.shots.some((shot) => shot.club === selectedDetailClub && shot.included),
    )
    if (!latestClubSession) {
      return 0
    }
    return latestClubSession.shots.filter(
      (shot) => shot.club === selectedDetailClub && shot.included,
    ).length
  }, [analysisSessions, selectedDetailClub])

  const clubDetailSwingsIncludedCount =
    dashboardNavTarget === 'lastSession'
      ? selectedClubLatestSessionIncludedShotCount
      : selectedDetailIncludedShots.length

  const selectedClubMetricModels = useMemo<ClubDetailMetricModel[]>(() => {
    // TODO(v2): Promote metric-specific interpretation rules into a dedicated
    // diagnosis module once we finalize Club Detail language tuning.
    const sessionWeightedMetric = (
      extractor: (shot: Shot) => number | undefined,
      rankWeightedWithinSession = true,
    ) =>
      weightedAverageNumbers(
        analysisSessions.map((session) =>
          weightedSessionMetricAverage(
            session,
            selectedDetailClub,
            extractor,
            rankWeightedWithinSession ? (shot) => rankWeightForShot(shot) : undefined,
          ),
        ),
        analysisSessions.map((session) =>
          sessionHistoricalWeightForClub(session, selectedDetailClub, historicalModelNowMs),
        ),
      )

    const sessionWeightedCarryMetric = () =>
      weightedAverageNumbers(
        analysisSessions.map((session) => {
          const includedShots = session.shots.filter(
            (shot) =>
              shot.club === selectedDetailClub &&
              shot.included &&
              typeof carryValue(shot) === 'number',
          )
          if (includedShots.length === 0) {
            return undefined
          }
          const carryValues = includedShots.map(carryValue)
          const carryWeights = includedShots.map((shot) => rankWeightForShot(shot))
          return guardedWeightedCarryMean(
            carryValues,
            carryWeights,
            confidenceConfig.displayCarryOutlierThresholdPct,
            confidenceConfig.displayCarryOutlierThresholdFloorYards,
          )
        }),
        analysisSessions.map((session) =>
          sessionHistoricalWeightForClub(session, selectedDetailClub, historicalModelNowMs),
        ),
      )

    const seriesFromExtractor = (extractor: (shot: Shot) => number | undefined) =>
      selectedDetailIncludedShots
        .map(extractor)
        .filter((value): value is number => typeof value === 'number')

    const sessionWeightedAverageForMetric = (
      session: SavedSession,
      extractor: (shot: Shot) => number | undefined,
    ) =>
      weightedSessionMetricAverage(
        session,
        selectedDetailClub,
        extractor,
        (shot) => rankWeightForShot(shot),
      )

    const sessionWeightedCarryForMetric = (session: SavedSession) => {
      const carryShots = session.shots.filter(
        (shot) =>
          shot.club === selectedDetailClub &&
          shot.included &&
          typeof carryValue(shot) === 'number',
      )
      if (carryShots.length === 0) {
        return undefined
      }
      return guardedWeightedCarryMean(
        carryShots.map(carryValue),
        carryShots.map((shot) => rankWeightForShot(shot)),
        confidenceConfig.displayCarryOutlierThresholdPct,
        confidenceConfig.displayCarryOutlierThresholdFloorYards,
      )
    }

    const sessionDeltaForMetric = (
      extractor: (shot: Shot) => number | undefined,
      sessionAverageOverride?: (session: SavedSession) => number | undefined,
    ) => {
      const sessionAverage = (session: SavedSession) =>
        sessionAverageOverride
          ? sessionAverageOverride(session)
          : sessionWeightedAverageForMetric(session, extractor)

      const orderedSessions = [...analysisSessions].sort(
        (left, right) => new Date(right.endedAt).getTime() - new Date(left.endedAt).getTime(),
      )
      const latestClubSession = orderedSessions.find((session) => {
        const value = sessionAverage(session)
        return typeof value === 'number' && Number.isFinite(value)
      })
      if (!latestClubSession) {
        return undefined
      }

      const latestSessionAverage = sessionAverage(latestClubSession)
      const priorSessionAverages = orderedSessions
        .filter((session) => session.id !== latestClubSession.id)
        .map((session) => ({
          value: sessionAverage(session),
          weight: sessionHistoricalWeightForClub(
            session,
            selectedDetailClub,
            historicalModelNowMs,
          ),
        }))
        .filter(
          (entry): entry is { value: number; weight: number } =>
            typeof entry.value === 'number' && Number.isFinite(entry.value) && entry.weight > 0,
        )

      const historicalBaselineExcludingLatest = weightedAverageNumbers(
        priorSessionAverages.map((entry) => entry.value),
        priorSessionAverages.map((entry) => entry.weight),
      )

      if (
        typeof latestSessionAverage !== 'number' ||
        typeof historicalBaselineExcludingLatest !== 'number'
      ) {
        return undefined
      }

      return latestSessionAverage - historicalBaselineExcludingLatest
    }

    const deltaText = (delta: number | undefined, unit: string, precision = 1) => {
      if (typeof delta !== 'number') {
        return '—'
      }
      return `${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta).toFixed(precision)}${unit}`
    }

    const valueText = (
      value: number | undefined,
      unit: string,
      precision = 1,
      signed = false,
    ) => {
      if (typeof value !== 'number') {
        return '-'
      }
      const core = value.toFixed(precision)
      if (signed) {
        return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(precision)}${unit}`
      }
      return `${core}${unit}`
    }

    const directionRead = (
      label: string,
      value: number | undefined,
      threshold: number,
      directionHint: { positive: string; negative: string; neutral: string },
    ) => {
      if (typeof value !== 'number') {
        return {
          status: 'Building',
          read: `${label} still needs more tracked shots before the read settles.`,
          trendRead: 'Trend is still forming.',
        }
      }

      if (value >= threshold) {
        return {
          status: directionHint.positive,
          read: `${label} is leaning positive and pushing pattern shape that direction.`,
          trendRead: 'Trend is moving farther from center.',
        }
      }
      if (value <= -threshold) {
        return {
          status: directionHint.negative,
          read: `${label} is leaning negative and shifting misses that way.`,
          trendRead: 'Trend is moving farther from center.',
        }
      }
      return {
        status: directionHint.neutral,
        read: `${label} is living close enough to center to stay workable.`,
        trendRead: 'Trend is hovering near neutral.',
      }
    }

    const carrySeries = seriesFromExtractor(carryValue)
    const totalSeries = seriesFromExtractor(totalValue)
    const hlaSeries = seriesFromExtractor(hlaValue)
    const spinAxisSeries = seriesFromExtractor(spinAxisValue)
    const clubPathSeries = seriesFromExtractor(clubPathValue)
    const faceToPathSeries = seriesFromExtractor(faceToPathValue)
    const faceToTargetSeries = seriesFromExtractor(faceToTargetValue)
    const launchSeries = seriesFromExtractor(launchValue)
    const spinSeries = seriesFromExtractor(spinValue)
    const peakSeries = seriesFromExtractor(peakHeightValue)
    const descentSeries = seriesFromExtractor(descentValue)
    const ballSpeedSeries = seriesFromExtractor(ballSpeedMphValue)
    const clubSpeedSeries = seriesFromExtractor(clubSpeedValue)
    const smashSeries = seriesFromExtractor(smashFactorValue)
    const offlineSeries = seriesFromExtractor(offlineValue)
    const offlineAbsSeries = offlineSeries.map((value) => Math.abs(value))
    const carryAnchor = sessionWeightedMetric(carryValue)
    const distanceWindowSeries = selectedDetailIncludedShots
      .map((shot) => {
        const carry = carryValue(shot)
        if (typeof carry !== 'number' || typeof carryAnchor !== 'number') {
          return undefined
        }
        return Math.abs(carry - carryAnchor)
      })
      .filter((value): value is number => typeof value === 'number')
    const patternStabilitySeries = selectedDetailIncludedShots
      .map((shot, index, rows) => {
        if (index === 0) {
          return undefined
        }
        const current = offlineValue(shot)
        const previous = offlineValue(rows[index - 1])
        if (typeof current !== 'number' || typeof previous !== 'number') {
          return undefined
        }
        return Math.abs(current - previous)
      })
      .filter((value): value is number => typeof value === 'number')

    const componentByKey = new Map(
      selectedClubComponentBreakdown.map((row) => [row.key, row] as const),
    )

    const hlaCurrent = sessionWeightedMetric(hlaValue)
    const hlaRead = directionRead('Start line', hlaCurrent, 1.5, {
      positive: 'Drifting Right',
      negative: 'Drifting Left',
      neutral: 'Centered',
    })
    const spinAxisCurrent = sessionWeightedMetric(spinAxisValue)
    const spinAxisRead = directionRead('Spin axis', spinAxisCurrent, 3, {
      positive: 'Fade Tilt',
      negative: 'Draw Tilt',
      neutral: 'Neutral Tilt',
    })
    const pathCurrent = sessionWeightedMetric(clubPathValue)
    const pathRead = directionRead('Club path', pathCurrent, 1.8, {
      positive: 'Out-to-In',
      negative: 'In-to-Out',
      neutral: 'Neutral Path',
    })
    const facePathCurrent = sessionWeightedMetric(faceToPathValue)
    const facePathRead = directionRead('Face to path', facePathCurrent, 1.5, {
      positive: 'Open Face',
      negative: 'Closed Face',
      neutral: 'Face Match',
    })
    const faceToTargetCurrent = sessionWeightedMetric(faceToTargetValue)
    const faceToTargetRead = directionRead('Face to target', faceToTargetCurrent, 1.5, {
      positive: 'Open to Target',
      negative: 'Closed to Target',
      neutral: 'Target Match',
    })

    const carryCurrent = sessionWeightedCarryMetric()
    const totalCurrent = sessionWeightedMetric(totalValue)
    const ballSpeedCurrent = sessionWeightedMetric(ballSpeedMphValue)
    const clubSpeedCurrent = sessionWeightedMetric(clubSpeedValue)
    const smashCurrent = sessionWeightedMetric(smashFactorValue)
    const launchCurrent = sessionWeightedMetric(launchValue)
    const spinCurrent = sessionWeightedMetric(spinValue)
    const peakCurrent = sessionWeightedMetric(peakHeightValue)
    const descentCurrent = sessionWeightedMetric(descentValue)
    const offlineCurrent = sessionWeightedMetric(offlineValue)
    const patternScore = selectedClubSummary?.componentScores.patternStability
    const distanceScore = selectedClubSummary?.componentScores.distanceWindow

    const hlaDelta = sessionDeltaForMetric(hlaValue)
    const spinAxisDelta = sessionDeltaForMetric(spinAxisValue)
    const clubPathDelta = sessionDeltaForMetric(clubPathValue)
    const faceToPathDelta = sessionDeltaForMetric(faceToPathValue)
    const faceToTargetDelta = sessionDeltaForMetric(faceToTargetValue)
    const carryDelta = sessionDeltaForMetric(carryValue, sessionWeightedCarryForMetric)
    const totalDistanceDelta = sessionDeltaForMetric(totalValue)
    const ballSpeedDelta = sessionDeltaForMetric(ballSpeedMphValue)
    const clubSpeedDelta = sessionDeltaForMetric(clubSpeedValue)
    const smashDelta = sessionDeltaForMetric(smashFactorValue)
    const launchDelta = sessionDeltaForMetric(launchValue)
    const spinDelta = sessionDeltaForMetric(spinValue)
    const peakHeightDelta = sessionDeltaForMetric(peakHeightValue)
    const descentDelta = sessionDeltaForMetric(descentValue)
    const offlineDelta = sessionDeltaForMetric(offlineValue)

    const trendToneForDelta = (delta: number | undefined, tolerance: number) =>
      comparisonTone(delta, tolerance)

    return [
      {
        key: 'hla',
        group: 'direction',
        label: 'HLA',
        valueText: valueText(hlaCurrent, '°', 1, true),
        deltaText: deltaText(hlaDelta, '°', 1),
        trendTone: trendToneForDelta(hlaDelta, 0.7),
        status: hlaRead.status,
        read: hlaRead.read,
        trendRead: hlaRead.trendRead,
        chartType: 'trend',
        series: hlaSeries,
      },
      {
        key: 'spinAxis',
        group: 'direction',
        label: 'Spin Axis',
        valueText: valueText(spinAxisCurrent, '°', 1, true),
        deltaText: deltaText(spinAxisDelta, '°', 1),
        trendTone: trendToneForDelta(spinAxisDelta, 1),
        status: spinAxisRead.status,
        read: spinAxisRead.read,
        trendRead: spinAxisRead.trendRead,
        chartType: 'trend',
        series: spinAxisSeries,
      },
      {
        key: 'carry',
        group: 'distance',
        label: 'Carry',
        valueText: valueText(carryCurrent, ' yd', 1),
        deltaText: deltaText(carryDelta, ' yd', 1),
        trendTone: trendToneForDelta(carryDelta, 1.5),
        status: typeof carryCurrent === 'number' ? 'Core Yardage' : 'Building',
        read:
          typeof carryCurrent === 'number'
            ? 'Carry is the main distance signal for this club right now.'
            : 'Carry read needs more swings.',
        trendRead:
          carrySeries.length > 2
            ? 'Recent carry trend is active and worth tracking.'
            : 'Trend will sharpen as the sample grows.',
        chartType: 'trend',
        series: carrySeries,
      },
      {
        key: 'totalDistance',
        group: 'distance',
        label: 'Total Distance',
        valueText: valueText(totalCurrent, ' yd', 1),
        deltaText: deltaText(totalDistanceDelta, ' yd', 1),
        trendTone: trendToneForDelta(totalDistanceDelta, 2),
        status: typeof totalCurrent === 'number' ? 'Total Window' : 'Building',
        read:
          typeof totalCurrent === 'number'
            ? 'Total distance is playable but should be read with rollout in mind.'
            : 'Not enough total-distance points yet.',
        trendRead:
          totalSeries.length > 2
            ? 'Total-distance trend is moving with current strike quality.'
            : 'Trend is still building.',
        chartType: 'trend',
        series: totalSeries,
      },
      {
        key: 'ballSpeed',
        group: 'distance',
        label: 'Ball Speed',
        valueText: valueText(ballSpeedCurrent, ' mph', 1),
        deltaText: deltaText(ballSpeedDelta, ' mph', 1),
        trendTone: trendToneForDelta(ballSpeedDelta, 1),
        status: typeof ballSpeedCurrent === 'number' ? 'Speed Base' : 'Building',
        read:
          typeof ballSpeedCurrent === 'number'
            ? 'Ball speed is showing what this club can produce when contact lands.'
            : 'Ball-speed support is still light.',
        trendRead:
          ballSpeedSeries.length > 2
            ? 'Speed trend is tracking strike quality shifts.'
            : 'Trend is still building.',
        chartType: 'trend',
        series: ballSpeedSeries,
      },
      {
        key: 'clubSpeed',
        group: 'distance',
        label: 'Club Speed',
        valueText: valueText(clubSpeedCurrent, ' mph', 1),
        deltaText: deltaText(clubSpeedDelta, ' mph', 1),
        trendTone: trendToneForDelta(clubSpeedDelta, 0.8),
        status: typeof clubSpeedCurrent === 'number' ? 'Speed Tempo' : 'Building',
        read:
          typeof clubSpeedCurrent === 'number'
            ? 'Club speed tracks the engine driving current distance output.'
            : 'Club-speed support is still light.',
        trendRead:
          clubSpeedSeries.length > 2
            ? 'Club-speed trend is showing pace changes session to session.'
            : 'Trend is still building.',
        chartType: 'trend',
        series: clubSpeedSeries,
      },
      {
        key: 'smashFactor',
        group: 'distance',
        label: 'Smash Factor',
        valueText: valueText(smashCurrent, '', 2),
        deltaText: deltaText(smashDelta, '', 2),
        trendTone: trendToneForDelta(smashDelta, 0.03),
        status: typeof smashCurrent === 'number' ? 'Contact Quality' : 'Building',
        read:
          typeof smashCurrent === 'number'
            ? 'Smash is your clean contact signal and supports distance trust.'
            : 'Smash read still needs more tracked strikes.',
        trendRead:
          smashSeries.length > 2
            ? 'Smash trend reflects how often centered contact is showing up.'
            : 'Trend is still forming.',
        chartType: 'trend',
        series: smashSeries,
      },
      {
        key: 'offline',
        group: 'direction',
        label: 'Offline',
        valueText: valueText(offlineCurrent, ' yd', 1, true),
        deltaText: deltaText(offlineDelta, ' yd', 1),
        trendTone: trendToneForDelta(offlineDelta, 1.2),
        status: directionRead('Offline miss', offlineCurrent, 2, {
          positive: 'Right Bias',
          negative: 'Left Bias',
          neutral: 'Centered',
        }).status,
        read: directionRead('Offline miss', offlineCurrent, 2, {
          positive: 'Right Bias',
          negative: 'Left Bias',
          neutral: 'Centered',
        }).read,
        trendRead: directionRead('Offline miss', offlineCurrent, 2, {
          positive: 'Right Bias',
          negative: 'Left Bias',
          neutral: 'Centered',
        }).trendRead,
        chartType: 'distribution',
        series: offlineAbsSeries,
      },
      {
        key: 'launch',
        group: 'flight',
        label: 'Launch (VLA)',
        valueText: valueText(launchCurrent, '°', 1),
        deltaText: deltaText(launchDelta, '°', 1),
        trendTone: trendToneForDelta(launchDelta, 0.8),
        status:
          typeof launchCurrent === 'number'
            ? launchCurrent < 11
              ? 'Launching Low'
              : launchCurrent > 18
                ? 'Launching High'
                : 'Launch in Range'
            : 'Building',
        read:
          typeof launchCurrent === 'number'
            ? 'Launch is defining flight window and carry shape right now.'
            : 'Launch read still needs more shots.',
        trendRead:
          launchSeries.length > 2
            ? 'Launch trend is moving with pattern changes.'
            : 'Trend is still building.',
        chartType: 'trend',
        series: launchSeries,
      },
      {
        key: 'spin',
        group: 'flight',
        label: 'Spin',
        valueText: valueText(spinCurrent, ' rpm', 0),
        deltaText: deltaText(spinDelta, ' rpm', 0),
        trendTone: trendToneForDelta(spinDelta, 120),
        status: typeof spinCurrent === 'number' ? 'Spin Window' : 'Building',
        read:
          typeof spinCurrent === 'number'
            ? 'Spin is shaping flight hold and green-side behavior.'
            : 'Spin support is still limited.',
        trendRead:
          spinSeries.length > 2
            ? 'Spin trend is showing a real directional move.'
            : 'Trend is still forming.',
        chartType: 'trend',
        series: spinSeries,
      },
      {
        key: 'peakHeight',
        group: 'flight',
        label: 'Peak Height',
        valueText: valueText(peakCurrent, ' yd', 1),
        deltaText: deltaText(peakHeightDelta, ' yd', 1),
        trendTone: trendToneForDelta(peakHeightDelta, 1.2),
        status: typeof peakCurrent === 'number' ? 'Height Window' : 'Building',
        read:
          typeof peakCurrent === 'number'
            ? 'Peak height supports how this ball flight carries and lands.'
            : 'Peak-height read is still light.',
        trendRead:
          peakSeries.length > 2
            ? 'Height trend is tracking current strike shape.'
            : 'Trend is still building.',
        chartType: 'trend',
        series: peakSeries,
      },
      {
        key: 'descent',
        group: 'flight',
        label: 'Descent Angle',
        valueText: valueText(descentCurrent, '°', 1),
        deltaText: deltaText(descentDelta, '°', 1),
        trendTone: trendToneForDelta(descentDelta, 0.8),
        status: typeof descentCurrent === 'number' ? 'Landing Window' : 'Building',
        read:
          typeof descentCurrent === 'number'
            ? 'Descent angle frames how softly this club can land.'
            : 'Descent read needs more support.',
        trendRead:
          descentSeries.length > 2
            ? 'Descent trend is moving with launch and spin changes.'
            : 'Trend is still forming.',
        chartType: 'trend',
        series: descentSeries,
      },
      {
        key: 'clubPath',
        group: 'path',
        label: 'Club Path',
        valueText: valueText(pathCurrent, '°', 1, true),
        deltaText: deltaText(clubPathDelta, '°', 1),
        trendTone: trendToneForDelta(clubPathDelta, 0.8),
        status: pathRead.status,
        read: pathRead.read,
        trendRead: pathRead.trendRead,
        chartType: 'trend',
        series: clubPathSeries,
      },
      {
        key: 'faceToPath',
        group: 'path',
        label: 'Face to Path',
        valueText: valueText(facePathCurrent, '°', 1, true),
        deltaText: deltaText(faceToPathDelta, '°', 1),
        trendTone: trendToneForDelta(faceToPathDelta, 0.8),
        status: facePathRead.status,
        read: facePathRead.read,
        trendRead: facePathRead.trendRead,
        chartType: 'trend',
        series: faceToPathSeries,
      },
      {
        key: 'faceToTarget',
        group: 'path',
        label: 'Face to Target',
        valueText: valueText(faceToTargetCurrent, '°', 1, true),
        deltaText: deltaText(faceToTargetDelta, '°', 1),
        trendTone: trendToneForDelta(faceToTargetDelta, 0.8),
        status: faceToTargetRead.status,
        read: faceToTargetRead.read,
        trendRead: faceToTargetRead.trendRead,
        chartType: 'trend',
        series: faceToTargetSeries,
      },
      {
        key: 'patternStability',
        group: 'performanceDrivers',
        label: componentLabel('patternStability'),
        valueText:
          typeof patternScore === 'number' ? `${formatScore(patternScore)}` : '-',
        deltaText:
          typeof componentByKey.get('patternStability')?.delta === 'number'
            ? `${componentByKey.get('patternStability')?.direction === 'up' ? '↑' : '↓'} ${Math.abs(componentByKey.get('patternStability')?.delta ?? 0).toFixed(0)}`
            : '—',
        trendTone: componentByKey.get('patternStability')?.tone ?? 'neutral',
        status:
          typeof patternScore === 'number'
            ? patternScore >= 70
              ? 'Settled Pattern'
              : patternScore >= 50
                ? 'Playable Pattern'
                : 'Unsettled Pattern'
            : 'Building',
        read: 'Whether your shot pattern is staying consistent or starting to shift.',
        trendRead:
          patternStabilitySeries.length > 1
            ? 'Distribution shows whether misses are repeating or mixed.'
            : 'Trend is still building.',
        chartType: 'distribution',
        series: patternStabilitySeries,
      },
      {
        key: 'distanceWindow',
        group: 'performanceDrivers',
        label: componentLabel('distanceWindow'),
        valueText:
          typeof distanceScore === 'number' ? `${formatScore(distanceScore)}` : '-',
        deltaText:
          typeof componentByKey.get('distanceWindow')?.delta === 'number'
            ? `${componentByKey.get('distanceWindow')?.direction === 'up' ? '↑' : '↓'} ${Math.abs(componentByKey.get('distanceWindow')?.delta ?? 0).toFixed(0)}`
            : '—',
        trendTone: componentByKey.get('distanceWindow')?.tone ?? 'neutral',
        status:
          typeof distanceScore === 'number'
            ? distanceScore >= 70
              ? 'Tight Carry Window'
              : distanceScore >= 50
                ? 'Playable Carry Window'
                : 'Loose Carry Window'
            : 'Building',
        read: 'How predictable your distance is from shot to shot.',
        trendRead:
          distanceWindowSeries.length > 1
            ? 'Distribution shows carry spread from the anchor.'
            : 'Trend is still building.',
        chartType: 'distribution',
        series: distanceWindowSeries,
      },
      {
        key: 'directionWindow',
        group: 'performanceDrivers',
        label: componentLabel('directionWindow'),
        valueText:
          typeof componentByKey.get('directionWindow')?.value === 'number'
            ? `${formatScore(componentByKey.get('directionWindow')?.value)}`
            : '-',
        deltaText:
          typeof componentByKey.get('directionWindow')?.delta === 'number'
            ? `${componentByKey.get('directionWindow')?.direction === 'up' ? '↑' : '↓'} ${Math.abs(componentByKey.get('directionWindow')?.delta ?? 0).toFixed(0)}`
            : '—',
        trendTone: componentByKey.get('directionWindow')?.tone ?? 'neutral',
        status:
          typeof componentByKey.get('directionWindow')?.value === 'number'
            ? componentByKey.get('directionWindow')!.value! >= 70
              ? 'On Line'
              : componentByKey.get('directionWindow')!.value! >= 50
                ? 'Playable Line'
                : 'Off Line'
            : 'Building',
        read: 'How reliably you keep the ball on your intended line.',
        trendRead:
          hlaSeries.length > 2
            ? 'Direction trend is tracking line control changes.'
            : 'Trend is still building.',
        chartType: 'trend',
        series: hlaSeries,
      },
      {
        key: 'flightQuality',
        group: 'performanceDrivers',
        label: componentLabel('flightQuality'),
        valueText:
          typeof componentByKey.get('flightQuality')?.value === 'number'
            ? `${formatScore(componentByKey.get('flightQuality')?.value)}`
            : '-',
        deltaText:
          typeof componentByKey.get('flightQuality')?.delta === 'number'
            ? `${componentByKey.get('flightQuality')?.direction === 'up' ? '↑' : '↓'} ${Math.abs(componentByKey.get('flightQuality')?.delta ?? 0).toFixed(0)}`
            : '—',
        trendTone: componentByKey.get('flightQuality')?.tone ?? 'neutral',
        status:
          typeof componentByKey.get('flightQuality')?.value === 'number'
            ? componentByKey.get('flightQuality')!.value! >= 70
              ? 'Clean Flight'
              : componentByKey.get('flightQuality')!.value! >= 50
                ? 'Playable Flight'
                : 'Erratic Flight'
            : 'Building',
        read: 'How consistently the ball flies and reacts when it lands.',
        trendRead:
          launchSeries.length > 2
            ? 'Flight trend is moving with launch and spin shifts.'
            : 'Trend is still building.',
        chartType: 'trend',
        series: launchSeries,
      },
      {
        key: 'dataConfidence',
        group: 'performanceDrivers',
        label: componentLabel('dataConfidence'),
        valueText:
          typeof componentByKey.get('dataConfidence')?.value === 'number'
            ? `${formatScore(componentByKey.get('dataConfidence')?.value)}`
            : '-',
        deltaText:
          typeof componentByKey.get('dataConfidence')?.delta === 'number'
            ? `${componentByKey.get('dataConfidence')?.direction === 'up' ? '↑' : '↓'} ${Math.abs(componentByKey.get('dataConfidence')?.delta ?? 0).toFixed(0)}`
            : '—',
        trendTone: componentByKey.get('dataConfidence')?.tone ?? 'neutral',
        status:
          typeof componentByKey.get('dataConfidence')?.value === 'number'
            ? componentByKey.get('dataConfidence')!.value! >= 70
              ? 'High Confidence'
              : componentByKey.get('dataConfidence')!.value! >= 50
                ? 'Developing'
                : 'Low Confidence'
            : 'Building',
        read: 'How much recent data is backing this score.',
        trendRead:
          carrySeries.length > 2
            ? 'Confidence trend rises as evidence quality improves.'
            : 'Trend is still building.',
        chartType: 'trend',
        series: carrySeries,
      },
    ]
  }, [
    analysisSessions,
    historicalModelNowMs,
    selectedClubComponentBreakdown,
    selectedClubSummary,
    selectedDetailClub,
    selectedDetailIncludedShots,
  ])

  const clubDetailHeatmapMetricsV2 = useMemo(() => {
    const byKey = new Map(selectedClubMetricModels.map((metric) => [metric.key, metric]))
    const pick = (key: ClubDetailMetricKey) => byKey.get(key)
    const rows = [
      { key: 'carry', label: 'Carry', source: pick('carry') },
      { key: 'total', label: 'Total Distance', source: pick('totalDistance') },
      { key: 'offline', label: 'Offline', source: pick('offline') },
      { key: 'bias', label: 'Bias', source: pick('spinAxis') ?? pick('hla') },
      { key: 'hla', label: 'HLA', source: pick('hla') },
      { key: 'vla', label: 'VLA', source: pick('launch') },
      { key: 'spin', label: 'Spin', source: pick('spin') },
    ]

    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: row.source?.valueText ?? '-',
      trend: row.source?.deltaText ?? '—',
      tone: row.source?.trendTone ?? 'neutral',
    }))
  }, [selectedClubMetricModels])

  const clubDetailMetricSessionSeriesV2 = useMemo(() => {
    const orderedSessions = [...analysisSessions].sort(
      (left, right) =>
        new Date(left.endedAt).getTime() - new Date(right.endedAt).getTime(),
    )
    const series: Partial<Record<ClubDetailMetricKey, Array<{ label: string; value: number }>>> =
      {}

    const pushPoint = (key: ClubDetailMetricKey, label: string, value: number | undefined) => {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return
      }
      series[key] = [...(series[key] ?? []), { label, value }]
    }

    orderedSessions.forEach((session) => {
      const label = new Date(session.endedAt).toLocaleDateString('en-US', {
        month: 'numeric',
        day: 'numeric',
      })
      const clubShots = session.shots.filter(
        (shot) => shot.club === selectedDetailClub && shot.included,
      )
      if (clubShots.length === 0) {
        return
      }

      const averageFor = (extractor: (shot: Shot) => number | undefined) =>
        averageNumbers(clubShots.map(extractor))

      const summary = summarizeReviewClub(
        selectedDetailClub,
        session.shots,
        analysisSessions.filter((savedSession) => savedSession.id !== session.id),
        session.id,
      )

      pushPoint('hla', label, averageFor(hlaValue))
      pushPoint('spinAxis', label, averageFor(spinAxisValue))
      pushPoint('clubPath', label, averageFor(clubPathValue))
      pushPoint('faceToPath', label, averageFor(faceToPathValue))
      pushPoint('faceToTarget', label, averageFor(faceToTargetValue))
      pushPoint('carry', label, averageFor(carryValue))
      pushPoint('totalDistance', label, averageFor(totalValue))
      pushPoint('ballSpeed', label, averageFor(ballSpeedMphValue))
      pushPoint('clubSpeed', label, averageFor(clubSpeedValue))
      pushPoint('smashFactor', label, averageFor(smashFactorValue))
      pushPoint('launch', label, averageFor(launchValue))
      pushPoint('spin', label, averageFor(spinValue))
      pushPoint('peakHeight', label, averageFor(peakHeightValue))
      pushPoint('descent', label, averageFor(descentValue))
      pushPoint('offline', label, averageFor(offlineValue))
      pushPoint(
        'directionWindow',
        label,
        summary?.componentScores.directionWindow,
      )
      pushPoint(
        'flightQuality',
        label,
        typeof summary?.componentScores.flightQuality === 'number'
          ? summary.componentScores.flightQuality
          : undefined,
      )
      pushPoint(
        'patternStability',
        label,
        typeof summary?.componentScores.patternStability === 'number'
          ? summary.componentScores.patternStability
          : undefined,
      )
      pushPoint('distanceWindow', label, summary?.componentScores.distanceWindow)
      pushPoint('dataConfidence', label, summary?.componentScores.dataConfidence)
    })

    return series
  }, [analysisSessions, selectedDetailClub])

  const clubDetailPatternInsightV2 = useMemo(() => {
    const byKey = new Map(selectedClubMetricModels.map((metric) => [metric.key, metric]))
    const hla = byKey.get('hla')
    const spinAxis = byKey.get('spinAxis')
    const offline = byKey.get('offline')
    const directionWindow = byKey.get('directionWindow')

    const biasLine = (() => {
      const source = spinAxis ?? hla
      const value = source?.valueText ?? ''
      if (value.startsWith('+')) {
        return 'Miss bias is favoring the right side.'
      }
      if (value.startsWith('-')) {
        return 'Miss bias is favoring the left side.'
      }
      return 'Pattern is sitting close to center.'
    })()

    const widthLine = (() => {
      const status = offline?.status ?? ''
      if (status.includes('Tight')) {
        return 'Window is compact and generally playable.'
      }
      if (status.includes('Wide')) {
        return 'Window is wide enough to demand target discipline.'
      }
      return 'Window is playable, but it still moves around.'
    })()

    const riskLine = (() => {
      const biasStatus = spinAxis?.status ?? hla?.status ?? ''
      const distanceStatus = directionWindow?.status ?? ''
      if (biasStatus.includes('Drifting') && !distanceStatus.includes('Tight')) {
        return 'Primary risk is the miss leaking one-way under pressure.'
      }
      return 'Primary risk is a mixed miss pattern when timing slips.'
    })()

    return {
      title: 'Miss Pattern',
      lines: [biasLine, widthLine, riskLine],
    }
  }, [selectedClubMetricModels])

  const clubDetailDefaultMetricV2 = useMemo<ClubDetailMetricKey>(() => {
    const preferredDriver = [...selectedClubPerformanceDrivers]
      .sort((left, right) => {
        const leftValue = typeof left.value === 'number' ? left.value : 101
        const rightValue = typeof right.value === 'number' ? right.value : 101
        return leftValue - rightValue
      })
      .find((driver) => typeof driver.value === 'number')

    const map: Record<ClubDriverKey, ClubDetailMetricKey> = {
      distanceWindow: 'distanceWindow',
      directionWindow: 'directionWindow',
      flightQuality: 'flightQuality',
      patternStability: 'patternStability',
      dataConfidence: 'carry',
    }

    const mapped = preferredDriver ? map[preferredDriver.key] : null
    const available = new Set<ClubDetailMetricKey>(
      selectedClubMetricModels.map((model) => model.key),
    )

    if (mapped && available.has(mapped)) {
      return mapped
    }
    if (available.has('hla')) {
      return 'hla'
    }
    if (available.has('carry')) {
      return 'carry'
    }
    return selectedClubMetricModels[0]?.key ?? 'carry'
  }, [selectedClubMetricModels, selectedClubPerformanceDrivers])

  // Temporary Club Detail skeleton mode: richer sections are intentionally
  // not rendered yet, but these values stay wired for the next layer.
  void baselineComparison
  void selectedClubInsights
  void selectedClubNarrative

  const comparisonClassName = (tone: ComparisonTone) =>
    tone === 'up'
      ? 'comparison-indicator comparison-up'
      : tone === 'down'
        ? 'comparison-indicator comparison-down'
        : 'comparison-indicator comparison-neutral'

  const comparisonSymbol = (direction: ComparisonDirection) =>
    direction === 'up' ? '↑' : '↓'

  const comparisonMagnitude = (delta: number | undefined) =>
    formatScore(Math.abs(delta ?? 0))

  const startSession = () => {
    const startedAt = new Date().toISOString()
    const nextLiveSessionId = crypto.randomUUID()
    const draft: ActiveSessionDraft = {
      id: nextLiveSessionId,
      startedAt,
      shots: [],
      metadata: currentSessionMetadata(selectedFeedMode),
    }
    saveActiveSessionDraft(draft)
    const params = new URLSearchParams({
      feed: selectedFeedMode,
      club: selectedClub,
    })
    navigateWithinApp(`/session-intelligence?${params.toString()}`)
  }

  const endSession = () => {
    const endedAt = new Date().toISOString()
    const savedSession: SavedSession = {
      id: liveSessionId ?? crypto.randomUUID(),
      startedAt: sessionStartedAt ?? endedAt,
      endedAt,
      shots,
      metadata: currentSessionMetadata(selectedFeedMode),
    }

    const nextSessions = [savedSession, ...savedSessions]
    setSavedSessions(nextSessions)
    saveSessionHistory(nextSessions)
    clearActiveSessionDraft()
    navigateWithinApp('/session-summary')
  }

  const toggleMockFeed = () => {
    if (feedMode !== 'mock') {
      return
    }

    if (connectionStatus === 'paused') {
      connectionRef.current?.resume?.()
    } else {
      connectionRef.current?.pause?.()
    }
  }

  const toggleShot = (shotId: string) => {
    setShots((currentShots) =>
      currentShots.map((shot) =>
        shot.id === shotId ? { ...shot, included: !shot.included } : shot,
      ),
    )
  }

  const undoLastShot = () => {
    setShots((currentShots) => currentShots.slice(1))
  }

  const openSavedSession = (sessionId: string) => {
    const session = savedSessions.find((savedSession) => savedSession.id === sessionId)
    if (!session) {
      return
    }

    setShots(session.shots)
    setActiveSessionId(session.id)
    setReviewView('dashboard')
    setSessionState('review')
  }

  const latestShot = shots[0] ?? null
  const latestShotShape = latestShot?.shotName ? String(latestShot.shotName).toUpperCase() : 'WAITING FOR SHOT'
  const latestShotScoreTag = shotRankScoreTone(latestShot?.shotRanking)
  const latestShotRankPill = formatRank(latestShot?.shotRanking)

  const latestShotReaction = (() => {
    if (!latestShot) {
      return "Take a swing and I'll give you the read."
    }
    const offline = offlineValue(latestShot)
    const carry = carryValue(latestShot)
    if (typeof offline === 'number' && Math.abs(offline) >= 12) {
      return offline > 0
        ? 'Started right and stayed out there.'
        : 'Pulled left and never held the line.'
    }
    if (typeof offline === 'number' && Math.abs(offline) <= 4) {
      return 'Start line held up well on that one.'
    }
    if (typeof carry === 'number' && carry < 110) {
      return 'Came out fine, just a touch short of full number.'
    }
    return 'Playable strike, but still wants a little management.'
  })()

  const latestShotWhy = (() => {
    if (!latestShot) {
      return null
    }
    const faceToPath = faceToPathValue(latestShot)
    const faceToTarget = faceToTargetValue(latestShot)
    const path = clubPathValue(latestShot)
    const formatSigned = (value: number) =>
      `${value > 0 ? '+' : ''}${value.toFixed(1)}°`

    if (typeof faceToPath === 'number' && Math.abs(faceToPath) > 2) {
      return `Face to path ${formatSigned(faceToPath)}`
    }
    if (typeof faceToTarget === 'number' && Math.abs(faceToTarget) > 2) {
      return `Face to target ${formatSigned(faceToTarget)}`
    }
    if (typeof path === 'number' && Math.abs(path) > 2) {
      return `Club path ${formatSigned(path)}`
    }
    return null
  })()

  const formatYards = (value: number | undefined) =>
    typeof value === 'number' ? `${value.toFixed(1)} yd` : '-'
  const formatDegrees = (value: number | undefined) =>
    typeof value === 'number' ? `${value.toFixed(1)}°` : '-'
  const formatSpin = (value: number | undefined) =>
    typeof value === 'number' ? `${Math.round(value)} rpm` : '-'
  const formatSpeed = (value: number | undefined) =>
    typeof value === 'number' ? value.toFixed(1) : '-'
  const formatSmash = (value: number | undefined) =>
    typeof value === 'number' ? value.toFixed(2) : '-'
  const formatOffline = (value: number | undefined) => {
    if (typeof value !== 'number') {
      return '-'
    }
    if (value === 0) {
      return '0.0 yd'
    }
    return `${Math.abs(value).toFixed(1)} yd ${value < 0 ? 'L' : 'R'}`
  }

  const shotDnaComparisonRows = [
    { metric: 'Carry', last: formatYards(latestShot ? carryValue(latestShot) : undefined) },
    { metric: 'Total Distance', last: formatYards(latestShot ? totalValue(latestShot) : undefined) },
    { metric: 'Offline', last: formatOffline(latestShot ? offlineValue(latestShot) : undefined) },
    { metric: 'Launch (VLA)', last: formatDegrees(latestShot ? launchValue(latestShot) : undefined) },
    {
      metric: 'Start Line (HLA)',
      last:
        typeof latestShot?.horizontalLaunchAngleDegrees === 'number'
          ? `${latestShot.horizontalLaunchAngleDegrees.toFixed(1)}°`
          : '-',
    },
    { metric: 'Spin', last: formatSpin(latestShot ? spinValue(latestShot) : undefined) },
    { metric: 'Spin Axis', last: formatDegrees(latestShot ? spinAxisValue(latestShot) : undefined) },
    { metric: 'Smash Factor', last: formatSmash(latestShot ? smashFactorValue(latestShot) : undefined) },
    { metric: 'Ball Speed', last: formatSpeed(latestShot ? ballSpeedMphValue(latestShot) : undefined) },
    { metric: 'Club Speed', last: formatSpeed(latestShot ? clubSpeedValue(latestShot) : undefined) },
    { metric: 'Peak Height', last: formatYards(latestShot ? peakHeightValue(latestShot) : undefined) },
    { metric: 'Descent Angle', last: formatDegrees(latestShot ? descentValue(latestShot) : undefined) },
    { metric: 'Club Path', last: formatDegrees(latestShot ? clubPathValue(latestShot) : undefined) },
    { metric: 'Face to Path', last: formatDegrees(latestShot ? faceToPathValue(latestShot) : undefined) },
    { metric: 'Face to Target', last: formatDegrees(latestShot ? faceToTargetValue(latestShot) : undefined) },
  ]

  const formatOfflineValue = (value: number | undefined) => {
    if (typeof value !== 'number') {
      return '-'
    }
    if (value === 0) {
      return '0.0'
    }
    return `${value > 0 ? '+' : '-'}${Math.abs(value).toFixed(1)}`
  }

  const offlineLabel = (value: number | undefined) => {
    if (typeof value !== 'number' || value === 0) {
      return 'Offline (yd L / yd R)'
    }
    return value > 0 ? 'Offline (yd R)' : 'Offline (yd L)'
  }

  const sessionIntelligencePoints = useMemo(
    () =>
      shots
        .filter((shot) => shot.club === selectedClub && shot.included)
        .flatMap((shot) => {
          const carry = carryValue(shot)
          const offline = offlineValue(shot)
          if (typeof carry !== 'number' || typeof offline !== 'number') {
            return []
          }
          return [{ id: shot.id, carry, offline, included: shot.included }]
        }),
    [selectedClub, shots],
  )

  const selectedClubIncludedShots = useMemo(
    () => shots.filter((shot) => shot.club === selectedClub && shot.included),
    [selectedClub, shots],
  )

  const sessionShotWindow = useMemo(() => {
    const carry = selectedClubIncludedShots
      .map(carryValue)
      .filter((value): value is number => typeof value === 'number')
    const offline = selectedClubIncludedShots
      .map(offlineValue)
      .filter((value): value is number => typeof value === 'number')

    const carryRange =
      carry.length >= 2
        ? `${Math.min(...carry).toFixed(1)} to ${Math.max(...carry).toFixed(1)} yd`
        : carry.length === 1
          ? `${carry[0].toFixed(1)} yd`
          : 'Building...'

    const offlineRange = (() => {
      if (offline.length < 2) {
        return offline.length === 1 ? `${formatOfflineValue(offline[0])} yd` : 'Building...'
      }
      const min = Math.min(...offline)
      const max = Math.max(...offline)
      const left = `${Math.abs(min).toFixed(1)}L`
      const right = `${Math.abs(max).toFixed(1)}R`
      return `${left} to ${right}`
    })()

    const rightCount = offline.filter((value) => value > 1).length
    const leftCount = offline.filter((value) => value < -1).length
    const considered = rightCount + leftCount
    const bias =
      considered < 4
        ? 'Neutral'
        : rightCount >= leftCount + 2
          ? 'Right'
          : leftCount >= rightCount + 2
            ? 'Left'
            : 'Neutral'

    return {
      carryRange,
      offlineRange,
      bias,
      sampleReady: selectedClubIncludedShots.length >= 4,
    }
  }, [selectedClubIncludedShots])

  const sessionMissPattern = useMemo(() => {
    const recent = selectedClubIncludedShots.slice(0, Math.min(9, selectedClubIncludedShots.length))
    const offline = recent
      .map(offlineValue)
      .filter((value): value is number => typeof value === 'number')

    const rightCount = offline.filter((value) => value > 1).length
    const leftCount = offline.filter((value) => value < -1).length
    const considered = rightCount + leftCount
    const dominantSide = rightCount >= leftCount ? 'right' : 'left'
    const dominantCount = dominantSide === 'right' ? rightCount : leftCount
    const dominanceRatio = considered > 0 ? dominantCount / considered : 0
    const strongPattern = considered >= 6 && dominanceRatio >= 0.67

    const countLine =
      considered >= 4
        ? `${dominantCount} of last ${considered} ${dominantSide} of target`
        : 'Not enough miss signal yet'

    const repeatLine =
      considered < 4
        ? 'Need more included shots.'
        : strongPattern
          ? 'Repeating miss pattern.'
          : 'Miss is more mixed than repeating.'

    const causeLine = (() => {
      if (!strongPattern) {
        return null
      }

      const recentFaceTarget = averageNumbers(recent.map(faceToTargetValue))
      const recentHla = averageNumbers(
        recent.map((shot) => shot.horizontalLaunchAngleDegrees),
      )
      const recentFacePath = averageNumbers(recent.map(faceToPathValue))

      if (
        (typeof recentFaceTarget === 'number' && Math.abs(recentFaceTarget) >= 2) ||
        (typeof recentHla === 'number' && Math.abs(recentHla) >= 2)
      ) {
        return 'Start line driving it.'
      }
      if (typeof recentFacePath === 'number' && Math.abs(recentFacePath) >= 2) {
        return 'Face-to-path tilt is contributing.'
      }
      return null
    })()

    return {
      countLine,
      repeatLine,
      causeLine,
    }
  }, [selectedClubIncludedShots])

  const sessionShotGroups = useMemo(() => {
    const byClub = new Map<Club, Shot[]>()
    shots.forEach((shot) => {
      byClub.set(shot.club, [...(byClub.get(shot.club) ?? []), shot])
    })

    return activeBagClubIds
      .filter((club) => byClub.has(club))
      .map((club) => {
        const clubShots = byClub.get(club) ?? []
        const included = clubShots.filter((shot) => shot.included)
        const rankCounts = new Map<string, number>()
        included.forEach((shot) => {
          if (typeof shot.shotRanking === 'undefined') {
            return
          }
          const rank = normalizeShotRank(shot.shotRanking) ?? String(shot.shotRanking)
          rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1)
        })
        const includedRankSummary =
          rankCounts.size > 0
            ? [...rankCounts.entries()].sort((left, right) => right[1] - left[1])[0][0]
            : '-'
        return {
          club,
          shots: clubShots,
          includedRankSummary,
          averages: {
            carry: averageNumbers(included.map(carryValue)),
            total: averageNumbers(included.map(totalValue)),
            offline: averageNumbers(included.map(offlineValue)),
            spin: averageNumbers(included.map(spinValue)),
            launch: averageNumbers(included.map(launchValue)),
            hla: averageNumbers(included.map((shot) => shot.horizontalLaunchAngleDegrees)),
            spinAxis: averageNumbers(included.map((shot) => shot.spinAxisDegrees)),
            smash: averageNumbers(included.map(smashFactorValue)),
            path: averageNumbers(included.map(clubPathValue)),
            facePath: averageNumbers(included.map(faceToPathValue)),
            faceTarget: averageNumbers(included.map(faceToTargetValue)),
            clubSpeed: averageNumbers(included.map(clubSpeedValue)),
            ballSpeed: averageNumbers(included.map(ballSpeedMphValue)),
            peak: averageNumbers(included.map(peakHeightValue)),
            descent: averageNumbers(included.map(descentValue)),
          },
        }
      })
  }, [shots])

  const excludeLastShot = () => {
    setShots((currentShots) => currentShots.slice(1))
  }

  if (forceSessionIntelligenceRoute) {
    return (
      <main className="session-intelligence-shell">
        <header className="session-intelligence-topbar">
          <div className="session-intelligence-brand">Every Club Holds a Truth</div>
          <div className="session-intelligence-actions">
            <button className="session-intelligence-end" onClick={endSession} type="button">
              End Session
            </button>
          </div>
        </header>

        <section className="session-intelligence-looper" aria-label="Looper reaction">
          <div className="session-intelligence-tags">
            <span className="session-tag">{latestShotShape}</span>
            <span className={`session-tag score-${latestShotScoreTag.tone}`}>
              {latestShotScoreTag.label}
            </span>
            <span className="session-tag session-tag-rank">{latestShotRankPill}</span>
          </div>
          <p className="session-intelligence-reaction">{latestShotReaction}</p>
        </section>

        <section className="session-last-shot-strip" aria-label="Most recent shot">
          <button
            className="session-strip-exclude"
            disabled={!latestShot}
            onClick={excludeLastShot}
            type="button"
          >
            ✖ Exclude
          </button>
          <div className="session-shot-hero-metrics">
            <div className="session-shot-hero-metric">
              <div className="session-shot-hero-club-control">
                <select
                  className="session-shot-hero-club-select session-shot-hero-value"
                  onChange={(event) => setSelectedClub(event.target.value as Club)}
                  value={selectedClub}
                >
                  {activeBagClubIds.map((club) => (
                    <option key={`session-intelligence-club-${club}`} value={club}>
                      {getClubLabel(club)}
                    </option>
                  ))}
                </select>
              </div>
              <span className="session-shot-hero-label">Club</span>
            </div>
            <div className="session-shot-hero-metric">
              <span className="session-shot-hero-value">
                {formatDecimal(latestShot ? carryValue(latestShot) : undefined)}
              </span>
              <span
                className="session-shot-hero-label"
                style={{
                  fontSize: '12px',
                  fontWeight: 400,
                  color: '#8fa08f',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  lineHeight: 1,
                  opacity: 0.72,
                }}
              >
                Carry (yd)
              </span>
            </div>
            <div className="session-shot-hero-metric">
              <span className="session-shot-hero-value">
                {(() => {
                  const value = latestShot ? offlineValue(latestShot) : undefined
                  if (typeof value !== 'number') {
                    return '-'
                  }
                  const direction = value > 0 ? 'R' : value < 0 ? 'L' : ''
                  const amount = value.toFixed(1)
                  return direction ? `${amount} ${direction}` : amount
                })()}
              </span>
              <span
                className="session-shot-hero-label"
                style={{
                  fontSize: '12px',
                  fontWeight: 400,
                  color: '#8fa08f',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  lineHeight: 1,
                  opacity: 0.72,
                }}
              >
                Offline (yd)
              </span>
            </div>
            <div className="session-shot-hero-metric">
              <span className="session-shot-hero-value">
                {formatWhole(latestShot ? spinValue(latestShot) : undefined)}
              </span>
              <span
                className="session-shot-hero-label"
                style={{
                  fontSize: '12px',
                  fontWeight: 400,
                  color: '#8fa08f',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  lineHeight: 1,
                  opacity: 0.72,
                }}
              >
                Spin (rpm)
              </span>
            </div>
            <div className="session-shot-hero-metric">
              <span className="session-shot-hero-value">
                {formatDecimal(latestShot ? launchValue(latestShot) : undefined)}
              </span>
              <span
                className="session-shot-hero-label"
                style={{
                  fontSize: '12px',
                  fontWeight: 400,
                  color: '#8fa08f',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  lineHeight: 1,
                  opacity: 0.72,
                }}
              >
                Launch
              </span>
            </div>
            <div className="session-shot-hero-metric">
              <span className="session-shot-hero-value">
                {typeof (latestShot ? smashFactorValue(latestShot) : undefined) === 'number'
                  ? (latestShot ? smashFactorValue(latestShot) : undefined)!.toFixed(2)
                  : '-'}
              </span>
              <span
                className="session-shot-hero-label"
                style={{
                  fontSize: '12px',
                  fontWeight: 400,
                  color: '#8fa08f',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  lineHeight: 1,
                  opacity: 0.72,
                }}
              >
                Smash
              </span>
            </div>
          </div>
        </section>

        <section className="session-intelligence-heatmap-row" aria-label="Heatmap and comparison">
          <article className="session-intelligence-heatmap" aria-label="Active club heatmap">
            {sessionIntelligencePoints.length === 0 ? (
              <p className="support-card-copy">No included shots for this club yet.</p>
            ) : (
              <ClubDispersionPlot lastShotId={latestShot?.id} points={sessionIntelligencePoints} />
            )}
          </article>
          <article className="session-intelligence-comparison" aria-label="Shot DNA comparison">
            <h3 className="session-intelligence-section-title">Shot DNA Comparison</h3>
            <div className="session-intelligence-comparison-table" role="table">
              <div className="session-intelligence-comparison-row session-intelligence-comparison-head" role="row">
                <span role="columnheader" aria-hidden="true"></span>
                <span role="columnheader">Last</span>
                <span role="columnheader">Pure</span>
                <span role="columnheader">Δ</span>
              </div>
              {shotDnaComparisonRows.map((row) => (
                <div className="session-intelligence-comparison-row" key={row.metric} role="row">
                  <span className="session-intelligence-comparison-metric" role="cell">
                    {row.metric}
                  </span>
                  <span role="cell">{row.last}</span>
                  <span role="cell">-</span>
                  <span className="session-intelligence-comparison-delta" role="cell">
                    -
                  </span>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="session-intelligence-signal" aria-label="Session signal">
          <div className="session-intelligence-intel-grid">
            <article className="session-intelligence-intel-col">
              <h3>Shot Window</h3>
              {sessionShotWindow.sampleReady ? (
                <div className="session-intelligence-intel-list">
                  <div className="component-row">
                    <span>Carry range</span>
                    <span>{sessionShotWindow.carryRange}</span>
                  </div>
                  <div className="component-row">
                    <span>Offline range</span>
                    <span>{sessionShotWindow.offlineRange}</span>
                  </div>
                  <div className="component-row">
                    <span>Miss bias</span>
                    <span>{sessionShotWindow.bias}</span>
                  </div>
                </div>
              ) : (
                <p className="support-card-copy">Getting a read on this club...</p>
              )}
            </article>

            <article className="session-intelligence-intel-col">
              <h3>Miss Pattern</h3>
              <div className="session-intelligence-intel-list">
                <p>{sessionMissPattern.countLine}</p>
                <p>{sessionMissPattern.repeatLine}</p>
                {sessionMissPattern.causeLine && <p>{sessionMissPattern.causeLine}</p>}
              </div>
            </article>
          </div>
        </section>

        <details className="session-shot-data">
          <summary>View Shot Data</summary>
          <div className="session-shot-data-table-wrap">
            <table className="session-shot-data-table">
              <thead>
                <tr>
                  <th>Exclude</th>
                  <th>In</th>
                  <th>Time</th>
                  <th>Club</th>
                  <th>Carry</th>
                  <th>Total</th>
                  <th>Offline</th>
                  <th>Spin</th>
                  <th>Launch</th>
                  <th>HLA</th>
                  <th>Spin Axis</th>
                  <th>Smash</th>
                  <th>Rank</th>
                  <th>Path</th>
                  <th>Face/Path</th>
                  <th>Face/Target</th>
                  <th>Club Speed</th>
                  <th>Ball Speed</th>
                  <th>Peak</th>
                  <th>Descent</th>
                  <th>Shot Shape</th>
                </tr>
              </thead>
              <tbody>
                {sessionShotGroups.flatMap((group) => [
                  <tr className="session-table-club-header" key={`header-${group.club}`}>
                    <td colSpan={21}>{getClubLabel(group.club)}</td>
                  </tr>,
                  <tr className="session-table-club-average" key={`avg-${group.club}`}>
                    <td />
                    <td>AVG</td>
                    <td>Included</td>
                    <td>{getClubLabel(group.club)}</td>
                    <td>{formatDecimal(group.averages.carry, ' yd')}</td>
                    <td>{formatDecimal(group.averages.total, ' yd')}</td>
                    <td>{formatDecimal(group.averages.offline, ' yd')}</td>
                    <td>{formatWhole(group.averages.spin)}</td>
                    <td>{formatDecimal(group.averages.launch, '°')}</td>
                    <td>{formatDecimal(group.averages.hla, '°')}</td>
                    <td>{formatDecimal(group.averages.spinAxis, '°')}</td>
                    <td>
                      {typeof group.averages.smash === 'number'
                        ? group.averages.smash.toFixed(2)
                        : '-'}
                    </td>
                    <td>{group.includedRankSummary}</td>
                    <td>{formatDecimal(group.averages.path, '°')}</td>
                    <td>{formatDecimal(group.averages.facePath, '°')}</td>
                    <td>{formatDecimal(group.averages.faceTarget, '°')}</td>
                    <td>{formatDecimal(group.averages.clubSpeed, ' mph')}</td>
                    <td>{formatDecimal(group.averages.ballSpeed, ' mph')}</td>
                    <td>{formatDecimal(group.averages.peak, ' yd')}</td>
                    <td>{formatDecimal(group.averages.descent, '°')}</td>
                    <td>-</td>
                  </tr>,
                  ...group.shots.map((shot) => (
                    <tr key={shot.id}>
                      <td>
                        <button
                          className="session-table-exclude"
                          onClick={() => toggleShot(shot.id)}
                          type="button"
                        >
                          {shot.included ? 'Exclude' : 'Include'}
                        </button>
                      </td>
                      <td>{shot.included ? 'Y' : 'N'}</td>
                      <td>{new Date(shot.capturedAt).toLocaleTimeString()}</td>
                      <td>{getClubLabel(shot.club)}</td>
                      <td>{formatDecimal(carryValue(shot), ' yd')}</td>
                      <td>{formatDecimal(totalValue(shot), ' yd')}</td>
                      <td>{formatDecimal(offlineValue(shot), ' yd')}</td>
                      <td>{formatWhole(spinValue(shot))}</td>
                      <td>{formatDecimal(launchValue(shot), '°')}</td>
                      <td>{formatDecimal(shot.horizontalLaunchAngleDegrees, '°')}</td>
                      <td>{formatDecimal(shot.spinAxisDegrees, '°')}</td>
                      <td>
                        {typeof smashFactorValue(shot) === 'number'
                          ? smashFactorValue(shot)!.toFixed(2)
                          : '-'}
                      </td>
                      <td>{formatRank(shot.shotRanking)}</td>
                      <td>{formatDecimal(clubPathValue(shot), '°')}</td>
                      <td>{formatDecimal(faceToPathValue(shot), '°')}</td>
                      <td>{formatDecimal(faceToTargetValue(shot), '°')}</td>
                      <td>{formatDecimal(clubSpeedValue(shot), ' mph')}</td>
                      <td>{formatDecimal(ballSpeedMphValue(shot), ' mph')}</td>
                      <td>{formatDecimal(peakHeightValue(shot), ' yd')}</td>
                      <td>{formatDecimal(descentValue(shot), '°')}</td>
                      <td>{shot.shotName ?? '-'}</td>
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        </details>
      </main>
    )
  }

  const appMain = (
    <main className={`app-shell ${sessionState === 'review' ? 'dashboard-shell' : ''}`}>
      {sessionState !== 'review' && <h1>Nova Stock Range Validation</h1>}
      {/* Validation/debug UI removed; OpenGolfCoach enrichment + persistence remain active. */}

      {sessionState !== 'review' && (
        <section className="panel">
        <div className="toolbar">
          <div>
            <h2>Session History</h2>
            <p>{savedSessions.length} saved sessions.</p>
          </div>
        </div>
        {savedSessions.length === 0 ? (
          <p>No saved sessions yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Ended</th>
                <th>Shots</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {savedSessions.map((session) => (
                <tr key={session.id}>
                  <td>{new Date(session.startedAt).toLocaleString()}</td>
                  <td>{new Date(session.endedAt).toLocaleString()}</td>
                  <td>{session.shots.length}</td>
                  <td>
                    <button onClick={() => openSavedSession(session.id)}>
                      {activeSessionId === session.id ? 'Open' : 'Open Session'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        </section>
      )}

      {sessionState === 'setup' && (
        <section className="panel">
          <p className="data-management-entry-link">
            <a href="/data-management">Open Data Management</a>
          </p>
          <h2>Start Session</h2>
          <p>Start a Stock Range Session, choose the first club, and listen for Nova shots.</p>

          <label>
            Feed mode
            <select
              value={selectedFeedMode}
              onChange={(event) => setSelectedFeedMode(event.target.value as SessionFeedMode)}
            >
              <option value="mock">Mock</option>
              <option value="real">Live Nova</option>
            </select>
          </label>

          {liveNovaUnavailable && (
            <p className="warning-text">
              Live Nova selected, but no reachable Nova endpoint is configured yet.
            </p>
          )}

          <label>
            Club
            <select
              value={selectedClub}
              onChange={(event) => setSelectedClub(event.target.value as Club)}
            >
              {activeBagClubIds.map((club) => (
                <option key={club} value={club}>
                  {getClubLabel(club)}
                </option>
              ))}
            </select>
          </label>

          <button disabled={liveNovaUnavailable} onClick={startSession}>
            Start Stock Range Session
          </button>
        </section>
      )}

      {sessionState === 'live' && (
        <section className="panel">
          <div className="toolbar">
            <div>
              <h2>
                Live Session
                {feedMode === 'mock' && <span className="badge">Mock Nova Feed</span>}
              </h2>
              <p>
                Started {sessionStartedAt ? new Date(sessionStartedAt).toLocaleString() : '-'}.
              </p>
            </div>
            <div className="button-row">
              <button disabled={shots.length === 0} onClick={undoLastShot}>
                Undo Last Shot
              </button>
              {feedMode === 'mock' && (
                <button onClick={toggleMockFeed}>
                  {connectionStatus === 'paused'
                    ? 'Resume Mock Feed'
                    : 'Pause Mock Feed'}
                </button>
              )}
              <button onClick={endSession}>End Session</button>
            </div>
          </div>

          <div className="status-area" aria-label="Live feed status">
            <div>
              <strong>Feed</strong>
              <span>
                {feedMode === null
                  ? 'Connecting'
                  : feedMode === 'mock'
                    ? 'Mock Nova Feed'
                    : 'Real Nova Feed'}
              </span>
            </div>
            <div>
              <strong>Mode</strong>
              <span>{feedMode ?? 'connecting'}</span>
            </div>
            <div>
              <strong>Status</strong>
              <span className={`status-indicator status-${connectionStatus}`}>
                {connectionStatus}
              </span>
            </div>
            <div>
              <strong>Shots received</strong>
              <span>{shots.length}</span>
            </div>
            <div>
              <strong>Helper configured</strong>
              <span>{isOpenGolfCoachConfigured ? 'yes' : 'no'}</span>
            </div>
            <div>
              <strong>Helper reachable</strong>
              <span>{helperReachable === null ? 'unknown' : helperReachable ? 'yes' : 'no'}</span>
            </div>
            <div>
              <strong>Last enrichment</strong>
              <span>{lastEnrichmentStatus}</span>
            </div>
          </div>

          <label>
            Current club
            <select
              value={selectedClub}
              onChange={(event) => setSelectedClub(event.target.value as Club)}
            >
              {activeBagClubIds.map((club) => (
                <option key={club} value={club}>
                  {getClubLabel(club)}
                </option>
              ))}
            </select>
          </label>

          <ShotTable shots={shots} onToggleShot={toggleShot} />
        </section>
      )}

      {sessionState === 'review' && (
        <section className="dashboard-layout">
          <aside className="dashboard-rail">
            <div className="dashboard-rail-brand">
              <a aria-label="Go to Looper Landing" href="/looper">
                <img alt="The Looper" className="dashboard-rail-logo" src={looperLogoWhite} />
              </a>
            </div>

            <nav className="dashboard-rail-nav" aria-label="Dashboard navigation">
              <button
                className={
                  reviewView === 'dashboard' && dashboardNavTarget === 'dashboard'
                    ? 'is-active'
                    : undefined
                }
                onClick={() =>
                  navigateDashboardSection('dashboard-overview', 'dashboard')
                }
              >
                Dashboard
              </button>
              <button
                className={
                  reviewView === 'dashboard' && dashboardNavTarget === 'bag'
                    ? 'is-active'
                    : undefined
                }
                onClick={() => navigateDashboardSection('dashboard-bag', 'bag')}
              >
                Bag
              </button>
              <button
                className={
                  reviewView === 'dashboard' && dashboardNavTarget === 'lastSession'
                    ? 'is-active'
                    : undefined
                }
                onClick={() =>
                  navigateDashboardSection('dashboard-review', 'lastSession', true)
                }
              >
                Last Session
              </button>
            </nav>

            <div className="dashboard-rail-clubs">
              <div className="dashboard-rail-label">Club List</div>
              <div className="dashboard-rail-club-list">
                {dashboardClubCards.map((card) => (
                  <a
                    className={
                      reviewView === 'clubDetail' && card.club === selectedDetailClub
                        ? 'is-selected'
                        : undefined
                    }
                    href={reviewView === 'clubDetail' ? '#club-detail-overview' : '#'}
                    key={card.club}
                    onClick={() => {
                      setSelectedDetailClub(card.club)
                      setReviewView('clubDetail')
                    }}
                  >
                    <span>{getClubLabel(card.club)}</span>
                    <span>{card.summary ? formatScore(card.summary.caddieScore) : '-'}</span>
                  </a>
                ))}
              </div>
            </div>

          </aside>

          <div className="dashboard-screen">
            {dashboardSummaryLead ? (
              <>
                {reviewView === 'dashboard' && (
                  <>
                <section
                  aria-labelledby="dashboard-game-status-title"
                  className="dashboard-hero-card"
                  id="dashboard-overview"
                >
                  <div className="looper-read-visual" aria-hidden="true">
                    <img alt="" src={looperman} />
                  </div>
                  <div className="dashboard-hero-content">
                    <h3 className="dashboard-hero-title" id="dashboard-game-status-title">
                      The Looper's Read
                    </h3>
                    <p className="dashboard-hero-narrative">{dashboardGameStatusNarrative}</p>
                    <div className="dashboard-hero-callouts">
                      <div className="dashboard-hero-chip">
                        Best club: {bestClubSummary ? getClubLabel(bestClubSummary.club) : '-'}
                      </div>
                      {weakestClubSummary && (
                        <div className="dashboard-hero-chip">
                          Pressure point: {getClubLabel(weakestClubSummary.club)}
                        </div>
                      )}
                      {biggestMover && (
                        <div className="dashboard-hero-chip">
                          Biggest mover: {getClubLabel(biggestMover.club)}{' '}
                          {biggestMover.delta >= 0 ? '+' : ''}
                          {formatScore(biggestMover.delta)}
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                {featuredDriverCard && featuredDriverSummary && featuredDriverRead && (
                  <section className="driver-feature-card" id={clubAnchorId(featuredDriverCard.club)}>
                    <div className="driver-feature-header">
                      <div className="section-kicker driver-feature-kicker">Featured Club</div>
                      <div className="driver-feature-intro">
                        <h3 className="driver-feature-title">{getClubLabel(featuredDriverCard.club)}</h3>
                        <p className="driver-feature-copy">
                          {featuredDriverRead.mainRead}
                        </p>
                      </div>
                      <div className="driver-feature-score-block">
                        <div className="driver-feature-score">
                          {formatScore(featuredDriverSummary.caddieScore)}
                        </div>
                        <span className={caddieCallClassName(featuredDriverSummary.caddieCall)}>
                          {featuredDriverSummary.caddieCall}
                        </span>
                      </div>
                    </div>
                    <div className="driver-feature-body">
                      <div className="driver-feature-insights">
                        {featuredDriverRead.insightRows.map((insight) => (
                          <div
                            className={`insight-row ${caddieToneClassName(
                              featuredDriverSummary.caddieCall,
                            )}`}
                            key={insight}
                          >
                            {insight}
                          </div>
                        ))}
                      </div>
                      <div className="driver-feature-meta">
                        <div className="driver-feature-meta-row">
                          <span>Included shots</span>
                          <span>{formatWhole(featuredDriverSummary.includedShots)}</span>
                        </div>
                        <div className="driver-feature-meta-row">
                          <span>Carry avg</span>
                          <span>
                            {featuredDriverSummary.carryAverageYards === null
                              ? '-'
                              : formatDecimal(featuredDriverSummary.carryAverageYards, ' yd')}
                          </span>
                        </div>
                        <div className="driver-feature-meta-row">
                          <span>Offline avg</span>
                          <span>
                            {featuredDriverSummary.offlineAverageYards === null
                              ? '-'
                              : formatDecimal(featuredDriverSummary.offlineAverageYards, ' yd')}
                          </span>
                        </div>
                        <div className="driver-feature-meta-row">
                          <span>Miss outcome</span>
                          <span className="driver-feature-meta-value-nowrap">
                            {featuredDriverRead.meta.missOutcome}
                          </span>
                        </div>
                        <div className="driver-feature-meta-row">
                          <span>Biggest drag</span>
                          <span>{featuredDriverRead.meta.biggestDrag}</span>
                        </div>
                        {featuredDriverCard.club === 'Driver' && (
                          <div className="driver-feature-meta-row">
                            <span>Smash avg</span>
                            <span>
                              {typeof featuredDriverRead.meta.smashAverage === 'number'
                                ? featuredDriverRead.meta.smashAverage.toFixed(2)
                                : '-'}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </section>
                )}

                <section className="dashboard-grid-section" id="dashboard-bag">
                  <div className="section-kicker">Bag Overview</div>
                  <div className="club-card-grid">
                    {dashboardGridCards.map((card) => (
                      <article
                        className={`dashboard-card club-card ${
                          card.summary ? caddieToneClassName(card.summary.caddieCall) : ''
                        }`}
                        id={clubAnchorId(card.club)}
                        key={card.club}
                        onClick={() => {
                          setSelectedDetailClub(card.club)
                          setReviewView('clubDetail')
                        }}
                      >
                        <div className="club-card-header">
                          <span className="club-card-name">{getClubLabel(card.club)}</span>
                          {card.summary ? (
                            <span className={caddieCallClassName(card.summary.caddieCall)}>
                              {card.summary.caddieCall}
                            </span>
                          ) : (
                            <span className={caddieCallClassName('Insufficient Data')}>
                              Insufficient Data
                            </span>
                          )}
                        </div>
                        <div className="club-card-score">
                          {card.summary ? formatScore(card.summary.caddieScore) : '-'}
                        </div>
                        <div className="club-card-trend">
                          {card.summary ? `${formatWhole(card.summary.includedShots)} swings` : '0 swings'}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>

                <section className="dashboard-spotlights" id="dashboard-spotlights">
                  {spotlightCards.map((card) => (
                    <article className="dashboard-card spotlight-card" key={card.key}>
                      <div className="spotlight-accent-row">
                        <span className={`spotlight-accent ${caddieToneClassName(card.accent)}`} />
                        <span className={caddieCallClassName(card.accent)}>{card.accent}</span>
                      </div>
                      <h3 className="spotlight-title">{card.title}</h3>
                      <p className="spotlight-summary">{card.summary}</p>
                      <div className="spotlight-list">
                        {card.bullets.map((bullet) => (
                          <p key={bullet}>{bullet}</p>
                        ))}
                      </div>
                    </article>
                  ))}
                </section>

                <section className="dashboard-support-grid" id="dashboard-trends">
                  <article className="dashboard-card support-card">
                    <div className="section-kicker">Bag Shape</div>
                    <h3 className="support-card-title">
                      {groupInsights.strongest
                        ? `${groupInsights.strongest.group} are leading the bag`
                        : 'Bag shape needs more data'}
                    </h3>
                    <p className="support-card-copy">
                      {groupInsights.strongest && groupInsights.weakest
                        ? `${groupInsights.strongest.group} are averaging ${formatScore(groupInsights.strongest.averageScore)}. ${groupInsights.weakest.group} are trailing at ${formatScore(groupInsights.weakest.averageScore)}.`
                        : 'Complete another session to separate the stable groups from the volatile ones.'}
                    </p>
                  </article>
                  <article className="dashboard-card support-card">
                    <div className="section-kicker">Trend Watch</div>
                    <h3 className="support-card-title">
                      {scoreSpread !== null
                        ? `${formatScore(scoreSpread)} points separate your best and worst clubs`
                        : 'Trend watch is still building'}
                    </h3>
                    <p className="support-card-copy">
                      {biggestMover
                        ? `${getClubLabel(biggestMover.club)} is the biggest mover against the prior session. ${biggestMover.delta >= 0 ? 'That club is earning more trust.' : 'That club is losing trust and needs attention.'}`
                        : 'Once you have prior-session support, trend movement will show up here.'}
                    </p>
                  </article>
                </section>
                  </>
                )}

                {reviewView === 'clubDetail' && useClubDetailV2 && (
                  <ClubDetailV2
                    call={selectedClubSummary?.caddieCall ?? 'Insufficient Data'}
                    callClassName={caddieCallClassName(
                      selectedClubSummary?.caddieCall ?? 'Insufficient Data',
                    )}
                    clubLabel={getClubLabel(selectedDetailClub)}
                    componentBreakdown={selectedClubComponentBreakdown}
                    defaultMetric={clubDetailDefaultMetricV2}
                    swingsIncludedCount={clubDetailSwingsIncludedCount}
                    dispersionChart={
                      selectedClubDispersionPoints.length === 0 ? (
                        <p className="support-card-copy">No shot data available for this club yet</p>
                      ) : (
                        <ClubDispersionPlot fillContainer points={selectedClubDispersionPoints} />
                      )
                    }
                    heatmapMetrics={clubDetailHeatmapMetricsV2}
                    patternInsight={clubDetailPatternInsightV2}
                    looperRead={looperRead}
                    metricModels={selectedClubMetricModels}
                    metricSessionSeries={clubDetailMetricSessionSeriesV2}
                    performanceDrivers={selectedClubPerformanceDrivers}
                    score={selectedClubSummary ? formatScore(selectedClubSummary.caddieScore) : '-'}
                    shotProfiles={selectedClubShotProfiles}
                  />
                )}

                {reviewView === 'clubDetail' && !useClubDetailV2 && (
                  <section className="club-detail-overview" id="club-detail-overview">
                    <article className="dashboard-card club-detail-looper-read">
                      <div className="club-detail-score-col">
                        <div className="club-detail-score-anchor">
                          <span className="club-detail-score-label">Score</span>
                          <span className="club-detail-score-value looper-read-score">
                            {selectedClubSummary ? formatScore(selectedClubSummary.caddieScore) : '-'}
                          </span>
                          <div
                            className={caddieCallClassName(
                              selectedClubSummary?.caddieCall ?? 'Insufficient Data',
                            )}
                          >
                            {selectedClubSummary?.caddieCall ?? 'Insufficient Data'}
                          </div>
                        </div>
                      </div>

                      <div className="club-detail-read-col">
                        <h3 className="club-detail-read-title">
                          {getClubLabel(selectedDetailClub)} · THE LOOPER&apos;S READ
                        </h3>
                        <p className="club-detail-read-line">{looperRead.primary}</p>
                        <p className="club-detail-read-line secondary">{looperRead.explanation}</p>
                        <p className="club-detail-read-line secondary">{looperRead.implication}</p>
                      </div>

                      <div className="club-detail-drivers-col">
                        <div className="club-detail-component-strip">
                          {selectedClubComponentBreakdown.map((component) => (
                            <div className="club-detail-component-row" key={component.key}>
                              <span>{component.label}</span>
                              <span className="comparison-cell">
                                <span className="comparison-value">
                                  {typeof component.value === 'number' ? formatScore(component.value) : '-'}
                                </span>
                                {typeof component.delta === 'number' ? (
                                  <span className={comparisonClassName(component.tone)}>
                                    <span>{comparisonSymbol(component.direction)}</span>
                                    <span>{comparisonMagnitude(component.delta)}</span>
                                  </span>
                                ) : (
                                  <span className="comparison-indicator comparison-neutral">-</span>
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </article>

                    <section className="club-detail-dispersion-grid" aria-label="Dispersion and Shot Profile">
                      <article className="dashboard-card club-detail-plot-card">
                        <div aria-hidden="true" className="club-detail-plot-spacer" />
                        {selectedClubDispersionPoints.length === 0 ? (
                          <p className="support-card-copy">No shot data available for this club yet</p>
                        ) : (
                          <ClubDispersionPlot points={selectedClubDispersionPoints} />
                        )}
                      </article>

                      <article className="dashboard-card club-detail-shot-profile">
                        <div className="section-kicker">SHOT PROFILE</div>

                        <div className="club-detail-shot-profile-block">
                          <div className="club-detail-shot-profile-title">Shot Profile Summary</div>
                          <div className="club-detail-shot-profile-compact-grid">
                            <div className="club-detail-shot-profile-compact">
                              <div className="club-detail-shot-profile-compact-label">Most Likely Shot</div>
                              <div className="club-detail-shot-profile-compact-main">
                                <div className="component-row">
                                  <span>Carry</span>
                                  <span>{formatDecimal(selectedClubShotProfiles.mostLikely?.carry, ' yd')}</span>
                                </div>
                                <div className="component-row">
                                  <span>Dispersion</span>
                                  <span>{formatDecimal(selectedClubShotProfiles.mostLikely?.dispersion, ' yd')}</span>
                                </div>
                              </div>
                              <div className="club-detail-shot-profile-compact-sub">
                                <span>Total {formatDecimal(selectedClubShotProfiles.mostLikely?.total, ' yd')}</span>
                                <span>Var {formatDecimal(selectedClubShotProfiles.mostLikely?.dispersionVariability, ' yd')}</span>
                                <span>Spin {formatWhole(selectedClubShotProfiles.mostLikely?.spin, ' rpm')}</span>
                              </div>
                            </div>

                            <div className="club-detail-shot-profile-compact">
                              <div className="club-detail-shot-profile-compact-label">Best Available Shot</div>
                              <div className="club-detail-shot-profile-compact-main">
                                <div className="component-row">
                                  <span>Carry</span>
                                  <span>{formatDecimal(selectedClubShotProfiles.bestAvailable?.carry, ' yd')}</span>
                                </div>
                                <div className="component-row">
                                  <span>Dispersion</span>
                                  <span>{formatDecimal(selectedClubShotProfiles.bestAvailable?.dispersion, ' yd')}</span>
                                </div>
                              </div>
                              <div className="club-detail-shot-profile-compact-sub">
                                <span>Total {formatDecimal(selectedClubShotProfiles.bestAvailable?.total, ' yd')}</span>
                                <span>Var {formatDecimal(selectedClubShotProfiles.bestAvailable?.dispersionVariability, ' yd')}</span>
                                <span>Spin {formatWhole(selectedClubShotProfiles.bestAvailable?.spin, ' rpm')}</span>
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="club-detail-shot-profile-block">
                          <div className="club-detail-shot-profile-title">Execution Gap</div>
                          <div className="club-detail-shot-list">
                            {selectedClubShotProfiles.executionGapRows.length === 0 ? (
                              <p className="club-detail-shot-gap">Execution gap is still building.</p>
                            ) : (
                              selectedClubShotProfiles.executionGapRows.map((row) => (
                                <div className="component-row" key={row.label}>
                                  <span>{row.label}</span>
                                  <span>{row.value}</span>
                                </div>
                              ))
                            )}
                          </div>
                        </div>

                        <div className="club-detail-shot-profile-block">
                          <div className="club-detail-shot-profile-title">Takeaway</div>
                          <p className="club-detail-shot-gap">{selectedClubShotProfiles.takeaway}</p>
                        </div>
                      </article>
                    </section>

                    <section className="club-detail-why-section" aria-label="What’s Driving This">
                      <div className="section-kicker">What&apos;s Driving This</div>
                      <div className="club-detail-why-grid">
                        <article className="dashboard-card club-detail-drivers-card">
                          <h3 className="support-card-title">Performance Drivers</h3>
                          <div className="club-driver-list">
                            {selectedClubPerformanceDrivers.map((driver) => (
                              <button
                                className={`club-driver-row ${
                                  openClubDriver === driver.key ? 'is-open' : ''
                                }`}
                                key={driver.key}
                                onClick={() =>
                                  setOpenClubDriver((current) =>
                                    current === driver.key ? null : driver.key,
                                  )
                                }
                                type="button"
                              >
                                <div className="club-driver-row-head">
                                  <span>{driver.label}</span>
                                  <span className="comparison-cell">
                                    <span className="comparison-value">
                                      {typeof driver.value === 'number' ? formatScore(driver.value) : '-'}
                                    </span>
                                    {typeof driver.delta === 'number' ? (
                                      <span className={comparisonClassName(driver.tone)}>
                                        <span>{comparisonSymbol(driver.direction)}</span>
                                        <span>{comparisonMagnitude(driver.delta)}</span>
                                      </span>
                                    ) : (
                                      <span className="comparison-indicator comparison-neutral">-</span>
                                    )}
                                  </span>
                                </div>
                                {openClubDriver === driver.key && (
                                  <div className="club-driver-row-body">
                                    <div className="club-driver-detail-title">Why</div>
                                    <p>{driver.why}</p>
                                    <div className="club-driver-detail-title">What it means</div>
                                    <p>{driver.meaning}</p>
                                  </div>
                                )}
                              </button>
                            ))}
                          </div>
                        </article>

                        <article className="dashboard-card club-detail-flight-card">
                          <h3 className="support-card-title">Ball Flight vs Ideal</h3>
                          <div className="club-flight-list">
                            {selectedClubBallFlightRows.map((row) => (
                              <div className="club-flight-row" key={row.key}>
                                <div className="club-flight-main">
                                  <span>{row.label}</span>
                                  <span>{row.value}</span>
                                </div>
                                <p>{row.interpretation}</p>
                              </div>
                            ))}
                          </div>
                        </article>
                      </div>
                    </section>

                    <section className="club-detail-delivery-section" aria-label="Delivery Patterns">
                      <div className="section-kicker">Delivery Patterns</div>
                      <article className="dashboard-card club-detail-delivery-card">
                        <div className="club-delivery-grid">
                          {selectedClubDeliveryRows.map((row) => (
                            <div className="club-delivery-row" key={row.key}>
                              <div className="club-delivery-main">
                                <span>{row.label}</span>
                                <span>{row.value}</span>
                              </div>
                              <p>{row.interpretation}</p>
                            </div>
                          ))}
                        </div>
                      </article>
                    </section>

                    <section className="club-detail-trends-section" aria-label="Trends">
                      <div className="section-kicker">Trends</div>
                      <div className="club-detail-trends">
                        {trendCards.map((card) => (
                          <article className="dashboard-card support-card club-detail-trend-card" key={card.key}>
                            <div className="section-kicker">{card.label}</div>
                            <h3 className="support-card-title">{card.value}</h3>
                            {card.series.length > 1 ? (
                              <TrendSparkline values={card.series} />
                            ) : (
                              <div className="trend-sparkline-empty">Not enough trend points yet.</div>
                            )}
                            <p className="support-card-copy">{card.detail}</p>
                          </article>
                        ))}
                      </div>
                    </section>

                  </section>
                )}

                {reviewView === 'dashboard' && (
                  <section className="review-details-card" id="dashboard-review">
                    <div className="section-kicker">Last Session Review</div>
                    <details
                      className="supporting-details last-session-review"
                      onToggle={(event) =>
                        setIsLastSessionOpen((event.currentTarget as HTMLDetailsElement).open)
                      }
                      open={isLastSessionOpen}
                    >
                      <summary>Click to Open Detailed Comparison</summary>

                      <section className="review-card last-session-insights">
                        <div className="section-kicker">Looper's Insights</div>
                        <p>{lastSessionInsights}</p>
                      </section>

                      <section className="review-card last-session-table-block">
                        <div className="section-kicker">Session vs History by Club</div>
                        <div className="review-table-wrap">
                          <table className="review-table last-session-table">
                            <thead>
                              <tr>
                                <th>Club</th>
                                <th>Shots</th>
                                <th>Score</th>
                                <th>{componentLabel('distanceWindow')}</th>
                                <th>{componentLabel('directionWindow')}</th>
                                <th>{componentLabel('flightQuality')}</th>
                                <th>{componentLabel('patternStability')}</th>
                                <th>{componentLabel('dataConfidence')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {lastSessionComparisonRows.map((row) => {
                                const distance = row.componentComparisons[0]
                                const direction = row.componentComparisons[1]
                                const flight = row.componentComparisons[2]
                                const pattern = row.componentComparisons[3]
                                const confidence = row.componentComparisons[4]

                                return (
                                  <tr key={row.club}>
                                    <td>{getClubLabel(row.club)}</td>
                                    <td className="review-center-cell">{formatWhole(row.shots)}</td>
                                    <td className="review-score-cell">
                                      <div className="comparison-cell">
                                        <span className="comparison-value">
                                          {formatScore(row.summary.caddieScore)}
                                        </span>
                                        <span className={comparisonClassName(row.scoreTone)}>
                                          <span>{comparisonSymbol(row.scoreDirection)}</span>
                                          <span>{comparisonMagnitude(row.scoreDelta)}</span>
                                        </span>
                                      </div>
                                      <div className={caddieCallClassName(row.summary.caddieCall)}>
                                        {row.summary.caddieCall}
                                      </div>
                                    </td>
                                    {[distance, direction, flight, pattern, confidence].map(
                                      (component) => (
                                        <td key={component.key}>
                                          <div className="comparison-cell">
                                            <span className="comparison-value">
                                              {formatScore(component.value)}
                                            </span>
                                            <span className={comparisonClassName(component.tone)}>
                                              <span>{comparisonSymbol(component.direction)}</span>
                                              <span>{comparisonMagnitude(component.delta)}</span>
                                            </span>
                                          </div>
                                        </td>
                                      ),
                                    )}
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    </details>
                  </section>
                )}
              </>
            ) : (
              <div className="dashboard-card">
                <p>No shots captured.</p>
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  )

  return sessionState === 'review' ? (
    <div className={`dashboard-page ${reviewView === 'clubDetail' ? 'club-detail-page' : ''}`}>
      {appMain}
    </div>
  ) : (
    appMain
  )
}

type DispersionPoint = {
  id: string
  carry: number
  offline: number
  included: boolean
}

type ClubDispersionPlotProps = {
  points: DispersionPoint[]
  lastShotId?: string
  fillContainer?: boolean
}

function ClubDispersionPlot({ points, lastShotId, fillContainer = false }: ClubDispersionPlotProps) {
  const width = 820
  const padding = { top: 22, right: 32, bottom: 48, left: 62 }

  const offlineMax = Math.max(...points.map((point) => Math.abs(point.offline)), 5)
  const carryMin = Math.min(...points.map((point) => point.carry))
  const carryMax = Math.max(...points.map((point) => point.carry))
  const carryRange = Math.max(carryMax - carryMin, 1)
  const carryPadding = carryRange * 0.1
  const carryDomainMin = Math.floor((carryMin - carryPadding) / 5) * 5
  const carryDomainMax = Math.ceil((carryMax + carryPadding) / 5) * 5
  const yRange = Math.max(carryDomainMax - carryDomainMin, 1)
  const offlineDomainMax = Math.max(5, Math.ceil(offlineMax / 5) * 5)
  const xRange = offlineDomainMax * 2
  const chartWidth = width - padding.left - padding.right

  // Keep unit-based scaling proportional so X/Y distances render honestly.
  // Allow mild horizontal bias for layout fit, but never vertical stretch.
  const unitPixelsFromX = chartWidth / Math.max(xRange, 1)
  const idealChartHeight = yRange * unitPixelsFromX
  const maxChartHeight = chartWidth / 1.3
  const chartHeight = Math.min(idealChartHeight, maxChartHeight)
  const height = padding.top + chartHeight + padding.bottom

  const pickTickStep = (span: number) => {
    const roughStep = span / 6
    const steps = [2, 5, 10, 15, 20, 25, 50]
    return steps.find((step) => roughStep <= step) ?? 50
  }

  const xTickStep = pickTickStep(offlineDomainMax * 2)
  const yTickStep = pickTickStep(yRange)
  const xTicks = Array.from(
    {
      length: Math.floor((offlineDomainMax * 2) / xTickStep) + 1,
    },
    (_, index) => -offlineDomainMax + index * xTickStep,
  )
  const yTicks = Array.from(
    {
      length: Math.floor(yRange / yTickStep) + 1,
    },
    (_, index) => carryDomainMin + index * yTickStep,
  )

  const xScale = (offline: number) =>
    padding.left +
    ((offline + offlineDomainMax) / (offlineDomainMax * 2)) * chartWidth
  const yScale = (carry: number) =>
    padding.top + ((carryDomainMax - carry) / yRange) * chartHeight

  const targetLineX = xScale(0)

  return (
    <svg
      aria-label="Carry versus offline dispersion plot"
      className="club-detail-plot"
      preserveAspectRatio={fillContainer ? 'xMidYMid meet' : undefined}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
    >
      <defs>
        {points.map((point) => (
          <radialGradient id={`heat-${point.id}`} key={`gradient-${point.id}`}>
            <stop offset="0%" stopColor="rgba(255,215,0,0.34)" />
            <stop offset="42%" stopColor="rgba(255,215,0,0.14)" />
            <stop offset="100%" stopColor="rgba(255,215,0,0)" />
          </radialGradient>
        ))}
      </defs>
      <rect
        className="club-detail-plot-surface"
        height={chartHeight}
        rx="10"
        width={chartWidth}
        x={padding.left}
        y={padding.top}
      />
      {xTicks.map((tick) => (
        <g key={`x-${tick}`}>
          <line
            className={tick === 0 ? 'club-detail-grid-line-center' : 'club-detail-grid-line'}
            x1={xScale(tick)}
            x2={xScale(tick)}
            y1={padding.top}
            y2={height - padding.bottom}
          />
          <text className="club-detail-tick-label" x={xScale(tick)} y={height - padding.bottom + 16}>
            {tick}
          </text>
        </g>
      ))}
      {yTicks.map((tick) => (
        <g key={`y-${tick}`}>
          <line
            className="club-detail-grid-line"
            x1={padding.left}
            x2={width - padding.right}
            y1={yScale(tick)}
            y2={yScale(tick)}
          />
          <text className="club-detail-tick-label y-tick" x={padding.left - 8} y={yScale(tick)}>
            {tick}
          </text>
        </g>
      ))}

      <line
        className="club-detail-axis-domain"
        x1={padding.left}
        x2={width - padding.right}
        y1={height - padding.bottom}
        y2={height - padding.bottom}
      />
      <line
        className="club-detail-axis-domain"
        x1={padding.left}
        x2={padding.left}
        y1={padding.top}
        y2={height - padding.bottom}
      />

      <line
        className="club-detail-target-line"
        x1={targetLineX}
        x2={targetLineX}
        y1={padding.top}
        y2={height - padding.bottom}
      />

      <g style={{ mixBlendMode: 'screen' }}>
        {points.map((point) => (
          <circle
            cx={xScale(point.offline)}
            cy={yScale(point.carry)}
            fill={`url(#heat-${point.id})`}
            key={`heat-${point.id}`}
            r={point.included ? 48 : 36}
          />
        ))}
      </g>

      {points.map((point) => (
        <circle
          cx={xScale(point.offline)}
          cy={yScale(point.carry)}
          fill={point.included ? '#eab308' : '#c1b06d'}
          fillOpacity={point.id === lastShotId ? 1 : point.included ? 0.88 : 0.4}
          key={point.id}
          r={point.id === lastShotId ? 5 : point.included ? 4 : 3}
          stroke="#0e1710"
          strokeWidth={point.id === lastShotId ? '1.4' : '1'}
        />
      ))}
      <text className="club-detail-axis-label" x={padding.left + 8} y={height - 10}>
        Left miss
      </text>
      <text className="club-detail-axis-label" x={width - padding.right - 62} y={height - 10}>
        Right miss
      </text>
      <text className="club-detail-axis-title" x={width / 2} y={height - 8}>
        Offline distance (yd)
      </text>
      <text
        className="club-detail-axis-title"
        transform={`translate(16 ${height / 2}) rotate(-90)`}
      >
        Carry distance (yd)
      </text>
      <text className="club-detail-axis-label" x={targetLineX + 6} y={padding.top + 12}>
        Target line
      </text>
    </svg>
  )
}

type TrendSparklineProps = {
  values: number[]
}

function TrendSparkline({ values }: TrendSparklineProps) {
  if (values.length < 2) {
    return null
  }

  const width = 220
  const height = 56
  const padding = 4
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(max - min, 1)
  const step = values.length > 1 ? (width - padding * 2) / (values.length - 1) : 0

  const points = values
    .map((value, index) => {
      const x = padding + index * step
      const y = height - padding - ((value - min) / range) * (height - padding * 2)
      return `${x},${y}`
    })
    .join(' ')

  const first = values[0]
  const last = values[values.length - 1]
  const trendTone =
    Math.abs(last - first) <= 0.01 ? 'neutral' : last > first ? 'up' : 'down'

  return (
    <svg
      aria-label="Trend sparkline"
      className={`trend-sparkline trend-sparkline-${trendTone}`}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline className="trend-sparkline-line" fill="none" points={points} />
      <circle className="trend-sparkline-point start" cx={padding} cy={height - padding - ((first - min) / range) * (height - padding * 2)} r="2.6" />
      <circle className="trend-sparkline-point end" cx={padding + (values.length - 1) * step} cy={height - padding - ((last - min) / range) * (height - padding * 2)} r="3" />
    </svg>
  )
}

type ShotTableProps = {
  shots: Shot[]
  onChangeClub?: (shotId: string, club: Club) => void
  onToggleShot: (shotId: string) => void
}

function ShotTable({ shots, onChangeClub, onToggleShot }: ShotTableProps) {
  if (shots.length === 0) {
    return <p>No shots yet.</p>
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Club</th>
          <th>Carry</th>
          <th>Total</th>
          <th>Offline</th>
          <th>Ball speed</th>
          <th>VLA</th>
          <th>HLA</th>
          <th>Total spin</th>
          <th>Spin axis</th>
          <th>Shot rank</th>
          <th>Enrichment</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {shots.map((shot) => (
          <tr key={shot.id}>
            <td>{new Date(shot.capturedAt).toLocaleTimeString()}</td>
            <td>
              {onChangeClub ? (
                <select
                  value={shot.club}
                  onChange={(event) =>
                    onChangeClub(shot.id, event.target.value as Club)
                  }
                >
                  {activeBagClubIds.map((club) => (
                    <option key={`${shot.id}-${club}`} value={club}>
                      {getClubLabel(club)}
                    </option>
                  ))}
                </select>
              ) : (
                getClubLabel(shot.club)
              )}
            </td>
            <td>{formatDecimal(shot.carryYards, ' yd')}</td>
            <td>{formatDecimal(shot.totalYards, ' yd')}</td>
            <td>{formatDecimal(shot.offlineYards, ' yd')}</td>
            <td>{formatDecimal(shot.ballSpeedMetersPerSecond, ' m/s')}</td>
            <td>{formatDecimal(shot.verticalLaunchAngleDegrees, ' deg')}</td>
            <td>{formatDecimal(shot.horizontalLaunchAngleDegrees, ' deg')}</td>
            <td>{formatWhole(shot.totalSpinRpm, ' rpm')}</td>
            <td>{formatDecimal(shot.spinAxisDegrees, ' deg')}</td>
            <td>
              {formatRank(shot.shotRanking)}
            </td>
            <td>
              {shot.enrichmentStatus === 'raw_only'
                ? 'Raw only'
                : shot.enrichmentStatus === 'enriched'
                  ? 'Enriched'
                  : 'Enrichment failed'}
            </td>
            <td>{shot.included ? 'Included' : 'Excluded'}</td>
            <td>
              <button onClick={() => onToggleShot(shot.id)}>
                {shot.included ? 'Exclude' : 'Include'}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default App
