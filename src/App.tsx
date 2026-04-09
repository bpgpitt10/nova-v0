import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type NovaConnection,
  type NovaConnectionStatus,
  type NovaFeedMode,
} from './adapters/nova'
import { mockNovaAdapter } from './adapters/mockNova'
import { novaWebSocketAdapter } from './adapters/novaWebSocket'
import './App.css'
import {
  activeBagClubIds,
  getClubConfig,
  getClubLabel,
  type Club,
} from './lib/bagConfig'
import { confidenceConfig } from './lib/confidenceConfig'
import {
  buildOpenGolfCoachInput,
  hasOpenGolfCoachInput,
  isOpenGolfCoachConfigured,
  openGolfCoachEnricher,
} from './lib/openGolfCoach'
import {
  buildSessionRecencyWeights,
  weightedAverage,
  weightedStandardDeviation,
} from './lib/recency'
import { summarizeReviewClub } from './lib/scoring'
import {
  clearActiveSessionDraft,
  loadActiveSessionDraft,
  loadSavedSessions,
  saveActiveSessionDraft,
  saveSessionHistory,
} from './lib/sessions'
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

const novaWebSocketUrl = import.meta.env.VITE_NOVA_WS_URL as string | undefined

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

const formatRank = (value: number | string | undefined) => {
  if (typeof value === 'undefined') {
    return '-'
  }

  return `${value}`
}

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

const rankWeightForShot = (shot: Shot) => {
  const key = typeof shot.shotRanking === 'undefined' ? '' : String(shot.shotRanking)
  return confidenceConfig.distanceWindow.rankWeights[key] ?? 1
}

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

const componentLabel = (component: keyof ReviewClubSummary['componentScores']) => {
  switch (component) {
    case 'distanceWindow':
      return 'Distance Window'
    case 'directionWindow':
      return 'Direction Window'
    case 'flightQuality':
      return 'Flight Quality'
    case 'patternStability':
      return 'Pattern Stability'
    case 'dataConfidence':
      return 'Data Confidence'
  }
}

const strongestComponentLabel = (
  componentScores: ReviewClubSummary['componentScores'],
  direction: 'high' | 'low',
) => {
  const rankedComponents = Object.entries(componentScores).sort((left, right) =>
    direction === 'high' ? right[1] - left[1] : left[1] - right[1],
  ) as Array<[keyof ReviewClubSummary['componentScores'], number]>

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
  type DashboardNavTarget = 'dashboard' | 'bag' | 'lastSession'
  type ClubDriverKey = keyof ReviewClubSummary['componentScores']
  const sessionIntelligenceSearch = forceSessionIntelligenceRoute
    ? new URLSearchParams(window.location.search)
    : null
  const routeFeedMode =
    sessionIntelligenceSearch?.get('feed') === 'real' ? 'real' : 'mock'
  const routeClubParam = sessionIntelligenceSearch?.get('club')
  const routeClub = activeBagClubIds.includes(routeClubParam as Club)
    ? (routeClubParam as Club)
    : '7i'
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
    forceSessionIntelligenceRoute ? routeClub : '7i',
  )
  const [selectedDetailClub, setSelectedDetailClub] = useState<Club>('7i')
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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [feedMode, setFeedMode] = useState<NovaFeedMode | null>(null)
  const [connectionStatus, setConnectionStatus] =
    useState<NovaConnectionStatus>('disconnected')
  const [helperReachable, setHelperReachable] = useState<boolean | null>(null)
  const [lastEnrichmentStatus, setLastEnrichmentStatus] = useState<
    'idle' | 'success' | 'failure'
  >('idle')
  const [sessionStartedAt, setSessionStartedAt] = useState<string | null>(() =>
    forceSessionIntelligenceRoute ? resumedDraft?.startedAt ?? startedAtFallback : null,
  )
  const [liveSessionId, setLiveSessionId] = useState<string | null>(() =>
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

    let isActive = true
    let activeSource: Shot['source'] = 'mock'
    const adapter =
      selectedFeedMode === 'real' && novaWebSocketUrl
        ? novaWebSocketAdapter(novaWebSocketUrl)
        : mockNovaAdapter
    const connection: NovaConnection = adapter.connectToShots(
      (incomingShot) => {
        if (!isActive) {
          return
        }

        const shot = buildShot(incomingShot, selectedClubRef.current, activeSource)
        setShots((currentShots) => [shot, ...currentShots])

        const openGolfCoachInput = buildOpenGolfCoachInput(incomingShot)
        console.info('[OpenGolfCoach] built input:', openGolfCoachInput)
        if (!hasOpenGolfCoachInput(openGolfCoachInput)) {
          console.info(
            '[OpenGolfCoach] enrichment skipped: required input fields missing',
            openGolfCoachInput,
          )
          return
        }

        void openGolfCoachEnricher.enrichShot(openGolfCoachInput).then((result) => {
          if (!isActive) {
            return
          }

          if (result.status === 'failure') {
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
            setHelperReachable(true)
            setLastEnrichmentStatus('success')
          }

          if (!result.payload) {
            return
          }

          setShots((currentShots) =>
            currentShots.map((currentShot) =>
              currentShot.id === shot.id
                ? mergeDerivedValues(currentShot, result.payload, result.derivedValues)
                : currentShot,
            ),
          )
        })
      },
      setConnectionStatus,
      () => undefined,
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
    () => savedSessions.flatMap((savedSession) => savedSession.shots),
    [savedSessions],
  )

  const sessionRecencyWeights = useMemo(
    () =>
      buildSessionRecencyWeights(
        savedSessions,
        confidenceConfig.recency.sessionDecayStrength,
        confidenceConfig.recency.minSessionWeightFloor,
      ),
    [savedSessions],
  )

  const dashboardSummaries: ReviewClubSummary[] = useMemo(
    () =>
      activeBagClubIds
        .map((club) => summarizeReviewClub(club, dashboardShots, savedSessions, null))
        .filter((summary): summary is ReviewClubSummary => summary !== null),
    [dashboardShots, savedSessions],
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
    const latestSession = savedSessions[0]

    if (!latestSession) {
      return summaries
    }

    activeBagClubIds.forEach((club) => {
      const summary = summarizeReviewClub(
        club,
        latestSession.shots,
        savedSessions.filter((session) => session.id !== latestSession.id),
        latestSession.id,
      )

      if (summary) {
        summaries.set(club, summary)
      }
    })

    return summaries
  }, [savedSessions])

  const previousSummariesByClub = useMemo(() => {
    const summaries = new Map<Club, ReviewClubSummary>()
    const previousSession = savedSessions[1]

    if (!previousSession) {
      return summaries
    }

    activeBagClubIds.forEach((club) => {
      const summary = summarizeReviewClub(
        club,
        previousSession.shots,
        savedSessions.filter((session) => session.id !== previousSession.id),
        previousSession.id,
      )

      if (summary) {
        summaries.set(club, summary)
      }
    })

    return summaries
  }, [savedSessions])

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

    const historicalSessions = savedSessions.slice(1)

    activeBagClubIds.forEach((club) => {
      const summaryPoints = historicalSessions
        .map((session) =>
          ({
            summary: summarizeReviewClub(
              club,
              session.shots,
              savedSessions.filter((savedSession) => savedSession.id !== session.id),
              session.id,
            ),
            weight: sessionRecencyWeights.get(session.id) ?? 1,
          }),
        )
        .filter(
          (point): point is { summary: ReviewClubSummary; weight: number } =>
            point.summary !== null,
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
          summaryPoints.map((point) => point.summary.componentScores.flightQuality),
          summaryPoints.map((point) => point.weight),
        ),
        patternStability: weightedAverageNumbers(
          summaryPoints.map((point) => point.summary.componentScores.patternStability),
          summaryPoints.map((point) => point.weight),
        ),
        dataConfidence: weightedAverageNumbers(
          summaryPoints.map((point) => point.summary.componentScores.dataConfidence),
          summaryPoints.map((point) => point.weight),
        ),
      })
    })

    return map
  }, [savedSessions, sessionRecencyWeights])

  const lastSessionComparisonRows = useMemo(() => {
    const latestSession = savedSessions[0]
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
          typeof history?.flightQuality === 'number'
            ? summary.componentScores.flightQuality - history.flightQuality
            : undefined
        const patternDelta =
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
              label: 'Distance Window',
              value: summary.componentScores.distanceWindow,
              historical: history?.distanceWindow,
              delta: distanceDelta,
              direction: comparisonDirection(distanceDelta),
              tone: comparisonTone(distanceDelta, comparisonTolerance.component),
            },
            {
              key: 'directionWindow',
              label: 'Direction Window',
              value: summary.componentScores.directionWindow,
              historical: history?.directionWindow,
              delta: directionDelta,
              direction: comparisonDirection(directionDelta),
              tone: comparisonTone(directionDelta, comparisonTolerance.component),
            },
            {
              key: 'flightQuality',
              label: 'Flight Quality',
              value: summary.componentScores.flightQuality,
              historical: history?.flightQuality,
              delta: flightDelta,
              direction: comparisonDirection(flightDelta),
              tone: comparisonTone(flightDelta, comparisonTolerance.component),
            },
            {
              key: 'patternStability',
              label: 'Pattern Stability',
              value: summary.componentScores.patternStability,
              historical: history?.patternStability,
              delta: patternDelta,
              direction: comparisonDirection(patternDelta),
              tone: comparisonTone(patternDelta, comparisonTolerance.component),
            },
            {
              key: 'dataConfidence',
              label: 'Data Confidence',
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
  }, [historicalAveragesByClub, latestSessionSummariesByClub, savedSessions])

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
      savedSessions.flatMap((session) =>
        session.shots.filter((shot) => shot.club === selectedDetailClub),
      ),
    [savedSessions, selectedDetailClub],
  )

  const selectedClubHistoricalShotWeights = useMemo(() => {
    const map = new Map<string, number>()
    savedSessions.forEach((session) => {
      const sessionWeight = sessionRecencyWeights.get(session.id) ?? 1
      session.shots.forEach((shot) => {
        if (shot.club === selectedDetailClub && !map.has(shot.id)) {
          map.set(shot.id, sessionWeight)
        }
      })
    })
    return map
  }, [savedSessions, selectedDetailClub, sessionRecencyWeights])

  const selectedClubOpenGolfCoachKeys = useMemo(() => {
    const keys = new Set<string>()

    selectedClubHistoricalShots.forEach((shot) => {
      if (!shot.openGolfCoach) {
        return
      }

      Object.keys(shot.openGolfCoach).forEach((key) => keys.add(key))
    })

    return [...keys].sort((left, right) => left.localeCompare(right))
  }, [selectedClubHistoricalShots])

  const selectedClubMetrics = useMemo(() => {
    const shotWeights = selectedClubHistoricalShots.map(
      (shot) => selectedClubHistoricalShotWeights.get(shot.id) ?? 1,
    )
    const carryAverage = weightedAverageNumbers(
      selectedClubHistoricalShots.map(carryValue),
      shotWeights,
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
          const rank = `${shot.shotRanking}`
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
      [...savedSessions]
        .reverse()
        .map((session) => {
          const clubShots = session.shots.filter((shot) => shot.club === selectedDetailClub)
          if (clubShots.length === 0) {
            return null
          }

          const summary = summarizeReviewClub(
            selectedDetailClub,
            session.shots,
            savedSessions.filter((savedSession) => savedSession.id !== session.id),
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
    [savedSessions, selectedDetailClub],
  )

  const baselineComparison = useMemo(() => {
    if (selectedClubSessionSeries.length === 0) {
      return null
    }

    const latest = selectedClubSessionSeries[selectedClubSessionSeries.length - 1]
    const prior =
      selectedClubSessionSeries.length > 1
        ? selectedClubSessionSeries[selectedClubSessionSeries.length - 2]
        : null

    return {
      latest,
      prior,
      scoreDelta:
        prior && typeof latest.score === 'number' && typeof prior.score === 'number'
          ? latest.score - prior.score
          : undefined,
      carryDelta:
        prior &&
        typeof latest.carryAverage === 'number' &&
        typeof prior.carryAverage === 'number'
          ? latest.carryAverage - prior.carryAverage
          : undefined,
      offlineDelta:
        prior &&
        typeof latest.dispersion === 'number' &&
        typeof prior.dispersion === 'number'
          ? latest.dispersion - prior.dispersion
          : undefined,
    }
  }, [selectedClubSessionSeries])

  const latestAndPrior = (values: Array<number | undefined>) => {
    const defined = values.filter((value): value is number => typeof value === 'number')
    if (defined.length === 0) {
      return null
    }

    return {
      latest: defined[defined.length - 1],
      prior: defined.length > 1 ? defined[defined.length - 2] : undefined,
    }
  }

  const trendCards = useMemo(() => {
    const formatDelta = (latest: number, prior: number | undefined, unit: string) => {
      if (typeof prior !== 'number') {
        return 'No prior-session baseline'
      }

      const delta = latest - prior
      const rounded = Math.abs(delta).toFixed(1)
      return `${delta >= 0 ? '+' : '-'}${rounded}${unit} vs prior session`
    }

    const carryTrend = latestAndPrior(
      selectedClubSessionSeries.map((point) => point.carryAverage),
    )
    const offlineTrend = latestAndPrior(
      selectedClubSessionSeries.map((point) => point.dispersion),
    )
    const biasTrend = latestAndPrior(selectedClubSessionSeries.map((point) => point.bias))
    const vlaTrend = latestAndPrior(
      selectedClubSessionSeries.map((point) => point.vlaAverage),
    )
    const spinTrend = latestAndPrior(
      selectedClubSessionSeries.map((point) => point.spinAverage),
    )

    const cards = [
      {
        key: 'carry',
        label: 'Carry',
        series: selectedClubSessionSeries
          .map((point) => point.carryAverage)
          .filter((value): value is number => typeof value === 'number'),
        value:
          carryTrend && typeof carryTrend.latest === 'number'
            ? `${formatDecimal(carryTrend.latest, ' yd')}`
            : '-',
        detail:
          carryTrend && typeof carryTrend.latest === 'number'
            ? formatDelta(carryTrend.latest, carryTrend.prior, ' yd')
            : 'No carry trend yet',
      },
      {
        key: 'offline-dispersion',
        label: 'Offline / Dispersion',
        series: selectedClubSessionSeries
          .map((point) => point.dispersion)
          .filter((value): value is number => typeof value === 'number'),
        value:
          offlineTrend && typeof offlineTrend.latest === 'number'
            ? `${formatDecimal(offlineTrend.latest, ' yd')}`
            : '-',
        detail:
          offlineTrend && typeof offlineTrend.latest === 'number'
            ? formatDelta(offlineTrend.latest, offlineTrend.prior, ' yd')
            : 'No dispersion trend yet',
      },
      {
        key: 'bias',
        label: 'Bias',
        series: selectedClubSessionSeries
          .map((point) => point.bias)
          .filter((value): value is number => typeof value === 'number'),
        value:
          biasTrend && typeof biasTrend.latest === 'number'
            ? `${biasTrend.latest >= 0 ? 'Right' : 'Left'} ${formatDecimal(Math.abs(biasTrend.latest), ' yd')}`
            : '-',
        detail:
          biasTrend && typeof biasTrend.latest === 'number'
            ? formatDelta(Math.abs(biasTrend.latest), biasTrend.prior ? Math.abs(biasTrend.prior) : undefined, ' yd')
            : 'No bias trend yet',
      },
      {
        key: 'vla',
        label: 'VLA',
        series: selectedClubSessionSeries
          .map((point) => point.vlaAverage)
          .filter((value): value is number => typeof value === 'number'),
        value:
          vlaTrend && typeof vlaTrend.latest === 'number'
            ? `${formatDecimal(vlaTrend.latest, ' deg')}`
            : '-',
        detail:
          vlaTrend && typeof vlaTrend.latest === 'number'
            ? formatDelta(vlaTrend.latest, vlaTrend.prior, ' deg')
            : 'No launch trend yet',
      },
      {
        key: 'spin',
        label: 'Spin',
        series: selectedClubSessionSeries
          .map((point) => point.spinAverage)
          .filter((value): value is number => typeof value === 'number'),
        value:
          spinTrend && typeof spinTrend.latest === 'number'
            ? `${formatWhole(spinTrend.latest, ' rpm')}`
            : '-',
        detail:
          spinTrend && typeof spinTrend.latest === 'number'
            ? formatDelta(spinTrend.latest, spinTrend.prior, ' rpm')
            : 'No spin trend yet',
      },
    ] as const

    return cards
  }, [selectedClubSessionSeries])

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
      ['patternStability', selectedClubSummary.componentScores.patternStability],
      ['directionWindow', selectedClubSummary.componentScores.directionWindow],
      ['distanceWindow', selectedClubSummary.componentScores.distanceWindow],
      ['flightQuality', selectedClubSummary.componentScores.flightQuality],
    ]

    const ranked = [...components].sort((left, right) => right[1] - left[1])
    const strongest = ranked[0][0]
    const weakest = ranked[ranked.length - 1][0]

    const plainLabel = (
      key: 'distanceWindow' | 'directionWindow' | 'flightQuality' | 'patternStability',
    ) => {
      switch (key) {
        case 'patternStability':
          return 'repeatability'
        case 'directionWindow':
          return 'start-line control'
        case 'distanceWindow':
          return 'carry control'
        case 'flightQuality':
          return 'flight shape'
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
    const orderedKeys: Array<keyof ReviewClubSummary['componentScores']> = [
      'flightQuality',
      'patternStability',
      'directionWindow',
      'distanceWindow',
      'dataConfidence',
    ]

    return orderedKeys.map((key) => {
      const value = scores?.[key]
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
        label: 'Pattern Stability',
        value: scores?.patternStability,
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
        ...buildDriverCopy('patternStability', scores?.patternStability),
      },
      {
        key: 'directionWindow',
        label: 'Direction Window',
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
        label: 'Distance Window',
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
        label: 'Flight Quality',
        value: scores?.flightQuality,
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
        ...buildDriverCopy('flightQuality', scores?.flightQuality),
      },
      {
        key: 'dataConfidence',
        label: 'Data Confidence',
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

    return rows
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
    ] as const
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
    ] as const
  }, [selectedClubHistoricalShots, selectedClubHistoricalShotWeights])

  const selectedClubShotProfiles = useMemo(() => {
    const includedShots = selectedClubHistoricalShots.filter((shot) => shot.included)
    if (includedShots.length === 0) {
      return {
        bestAvailable: null,
        mostLikely: null,
        deltaSummary: 'Not enough included shots to profile this club yet.',
      }
    }

    const recencyWeight = (shot: Shot) => selectedClubHistoricalShotWeights.get(shot.id) ?? 1
    const anchorTolerance = confidenceConfig.distanceWindow.anchorToleranceYards
    const targetWidth = confidenceConfig.directionWindow.targetWidthByClub[selectedDetailClub]

    const carryAnchor = weightedAverageNumbers(
      includedShots.map(carryValue),
      includedShots.map((shot) => recencyWeight(shot) * rankWeightForShot(shot)),
    )

    const candidates = includedShots.flatMap((shot) => {
      const carry = carryValue(shot)
      const offline = offlineValue(shot)
      if (typeof carry !== 'number' || typeof offline !== 'number' || typeof carryAnchor !== 'number') {
        return []
      }

      const carryError = Math.abs(carry - carryAnchor)
      const normalizedCarryError = carryError / Math.max(anchorTolerance, 1)
      const normalizedOffline = Math.abs(offline) / Math.max(targetWidth, 1)
      const rankWeight = rankWeightForShot(shot)
      const recent = recencyWeight(shot)
      const qualityScore =
        (1 / (1 + normalizedCarryError + normalizedOffline)) * rankWeight * recent

      return [
        {
          shot,
          qualityScore,
          effectiveWeight: rankWeight * recent,
        },
      ]
    })

    const bestSubset = (() => {
      if (candidates.length === 0) {
        return []
      }
      const ranked = [...candidates].sort((left, right) => right.qualityScore - left.qualityScore)
      const subsetSize = Math.min(Math.max(Math.round(ranked.length * 0.4), 3), 8)
      return ranked.slice(0, subsetSize)
    })()

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

      return {
        key,
        carry: weightedAverageNumbers(shots.map(carryValue), weights),
        total: weightedAverageNumbers(shots.map(totalValue), weights),
        dispersion: weightedAverageNumbers(absOffline, weights),
        dispersionVariability: weightedStandardDeviationNumbers(offline, weights),
        spin: weightedAverageNumbers(shots.map(spinValue), weights),
      }
    }

    const bestAvailable = buildProfile(bestSubset, 'best')
    const mostLikely = buildProfile(
      includedShots.map((shot) => ({
        shot,
        effectiveWeight: recencyWeight(shot),
      })),
      'likely',
    )

    const deltaSummary = (() => {
      if (
        !bestAvailable ||
        !mostLikely ||
        typeof bestAvailable.carry !== 'number' ||
        typeof mostLikely.carry !== 'number' ||
        typeof bestAvailable.dispersion !== 'number' ||
        typeof mostLikely.dispersion !== 'number'
      ) {
        return 'Gap: building as more clean swings come in.'
      }

      const carryGap = bestAvailable.carry - mostLikely.carry
      const dispersionGap = bestAvailable.dispersion - mostLikely.dispersion
      return `Gap: ${carryGap >= 0 ? '+' : '-'}${Math.abs(carryGap).toFixed(1)} yd carry, ${dispersionGap >= 0 ? '+' : '-'}${Math.abs(dispersionGap).toFixed(1)} yd dispersion when executed well.`
    })()

    return {
      bestAvailable,
      mostLikely,
      deltaSummary,
    }
  }, [selectedClubHistoricalShotWeights, selectedClubHistoricalShots, selectedDetailClub])

  const selectedClubOpenGolfCoachShots = useMemo(
    () =>
      selectedClubHistoricalShots.filter(
        (shot): shot is Shot & { openGolfCoach: OpenGolfCoachPayload } =>
          typeof shot.openGolfCoach === 'object' && shot.openGolfCoach !== null,
      ),
    [selectedClubHistoricalShots],
  )

  const stringifyDebugJson = (value: unknown) => {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return 'Unable to stringify payload.'
    }
  }

  // Temporary Club Detail skeleton mode: richer sections are intentionally
  // not rendered yet, but these values stay wired for the next layer.
  void selectedClubOpenGolfCoachKeys
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
    window.location.assign(`/session-intelligence?${params.toString()}`)
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
    window.location.assign('/session-summary')
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

  const startOver = () => {
    setSessionState('setup')
    setShots([])
    setActiveSessionId(null)
    setLiveSessionId(null)
    setFeedMode(null)
    setConnectionStatus('disconnected')
    setHelperReachable(null)
    setLastEnrichmentStatus('idle')
    setSessionStartedAt(null)
    clearActiveSessionDraft()
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
  const latestShotScoreTag = (() => {
    const rank = latestShot?.shotRanking
    if (typeof rank === 'number') {
      if (rank <= 2) return { label: 'GOOD', tone: 'good' as const }
      if (rank <= 3) return { label: 'NEUTRAL', tone: 'neutral' as const }
      return { label: 'POOR', tone: 'poor' as const }
    }
    const normalized = typeof rank === 'string' ? rank.toUpperCase() : ''
    if (normalized === 'A' || normalized === 'B') {
      return { label: 'GOOD', tone: 'good' as const }
    }
    if (normalized === 'C' || normalized === '3') {
      return { label: 'NEUTRAL', tone: 'neutral' as const }
    }
    if (normalized === 'D' || normalized === '4' || normalized === '5') {
      return { label: 'POOR', tone: 'poor' as const }
    }
    return { label: 'NEUTRAL', tone: 'neutral' as const }
  })()
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
          const rank = String(shot.shotRanking)
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
            <button
              className="session-intelligence-pause"
              onClick={feedMode === 'mock' ? toggleMockFeed : undefined}
              type="button"
            >
              {feedMode === 'mock' && connectionStatus === 'paused'
                ? 'Resume Session'
                : 'Pause Session'}
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
          {latestShotWhy && <p className="session-intelligence-why">{latestShotWhy}</p>}
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
              <span className="session-shot-hero-value">{formatDecimal(latestShot ? carryValue(latestShot) : undefined)}</span>
              <span className="session-shot-hero-label">Carry (yd)</span>
            </div>
            <div className="session-shot-hero-metric">
              <span className="session-shot-hero-value">{formatOfflineValue(latestShot ? offlineValue(latestShot) : undefined)}</span>
              <span className="session-shot-hero-label">{offlineLabel(latestShot ? offlineValue(latestShot) : undefined)}</span>
            </div>
            <div className="session-shot-hero-metric">
              <span className="session-shot-hero-value">{formatWhole(latestShot ? spinValue(latestShot) : undefined)}</span>
              <span className="session-shot-hero-label">Spin (rpm)</span>
            </div>
            <div className="session-shot-hero-metric">
              <span className="session-shot-hero-value">{formatDecimal(latestShot ? launchValue(latestShot) : undefined, '°')}</span>
              <span className="session-shot-hero-label">Launch (°)</span>
            </div>
            <div className="session-shot-hero-metric">
              <span className="session-shot-hero-value">
                {typeof (latestShot ? smashFactorValue(latestShot) : undefined) === 'number'
                  ? (latestShot ? smashFactorValue(latestShot) : undefined)!.toFixed(2)
                  : '-'}
              </span>
              <span className="session-shot-hero-label">Smash</span>
            </div>
          </div>
        </section>

        <section className="session-intelligence-heatmap" aria-label="Active club heatmap">
          {sessionIntelligencePoints.length === 0 ? (
            <p className="support-card-copy">No included shots for this club yet.</p>
          ) : (
            <ClubDispersionPlot lastShotId={latestShot?.id} points={sessionIntelligencePoints} />
          )}
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
      {import.meta.env.DEV && <p><a href="/looper">Open Looper Landing (/looper)</a></p>}

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
              Live Nova selected, but `VITE_NOVA_WS_URL` is not configured.
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
              <div className="dashboard-rail-mark">The Looper</div>
              <div>
                <div className="dashboard-rail-title">The Looper</div>
              </div>
            </div>

            <nav className="dashboard-rail-nav" aria-label="Dashboard navigation">
              <button
                className={dashboardNavTarget === 'dashboard' ? 'is-active' : undefined}
                onClick={() =>
                  navigateDashboardSection('dashboard-overview', 'dashboard')
                }
              >
                Dashboard
              </button>
              <button
                className={dashboardNavTarget === 'bag' ? 'is-active' : undefined}
                onClick={() => navigateDashboardSection('dashboard-bag', 'bag')}
              >
                Bag
              </button>
              <button
                className={dashboardNavTarget === 'lastSession' ? 'is-active' : undefined}
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
                    className={card.club === selectedDetailClub ? 'is-selected' : undefined}
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

            <div className="dashboard-rail-utility">
              <button onClick={startOver}>Start New Session</button>
              <button disabled={shots.length === 0} onClick={undoLastShot}>
                Undo Last Shot
              </button>
              <button>Export</button>
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

                {featuredDriverCard && featuredDriverSummary && (
                  <section className="driver-feature-card" id={clubAnchorId(featuredDriverCard.club)}>
                    <div className="driver-feature-header">
                      <div>
                        <div className="section-kicker">Featured Club</div>
                        <h3 className="driver-feature-title">{getClubLabel(featuredDriverCard.club)}</h3>
                        <p className="driver-feature-copy">
                          {featuredDriverSummary.explanation}
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
                        {featuredDriverSummary.insights.slice(0, 2).map((insight) => (
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
                          <span>Trend</span>
                          <span>
                            {typeof featuredDriverCard.delta === 'number'
                              ? `${featuredDriverCard.delta >= 0 ? '+' : ''}${formatScore(featuredDriverCard.delta)} vs prior`
                              : 'No prior-session read'}
                          </span>
                        </div>
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
                        <div className="club-card-descriptor">{card.descriptor}</div>
                        <div className="club-card-trend">
                          {card.summary
                            ? `Swings Included ${formatWhole(card.summary.includedShots)}`
                            : 'No current saved data'}
                        </div>
                      </article>
                    ))}
                  </div>
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

                {reviewView === 'clubDetail' && (
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
                        <div className="supporting-title">COMPONENT BREAKDOWN</div>
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
                          <div className="club-detail-shot-profile-title">Best Available Shot</div>
                          <div className="club-detail-shot-list">
                            <div className="component-row">
                              <span>Carry</span>
                              <span>{formatDecimal(selectedClubShotProfiles.bestAvailable?.carry, ' yd')}</span>
                            </div>
                            <div className="component-row">
                              <span>Total distance</span>
                              <span>{formatDecimal(selectedClubShotProfiles.bestAvailable?.total, ' yd')}</span>
                            </div>
                            <div className="component-row">
                              <span>Dispersion</span>
                              <span>{formatDecimal(selectedClubShotProfiles.bestAvailable?.dispersion, ' yd')}</span>
                            </div>
                            <div className="component-row">
                              <span>Dispersion variability</span>
                              <span>{formatDecimal(selectedClubShotProfiles.bestAvailable?.dispersionVariability, ' yd')}</span>
                            </div>
                            <div className="component-row">
                              <span>Spin</span>
                              <span>{formatWhole(selectedClubShotProfiles.bestAvailable?.spin, ' rpm')}</span>
                            </div>
                          </div>
                        </div>

                        <div className="club-detail-shot-profile-block">
                          <div className="club-detail-shot-profile-title">Most Likely Outcome</div>
                          <div className="club-detail-shot-list">
                            <div className="component-row">
                              <span>Carry</span>
                              <span>{formatDecimal(selectedClubShotProfiles.mostLikely?.carry, ' yd')}</span>
                            </div>
                            <div className="component-row">
                              <span>Total distance</span>
                              <span>{formatDecimal(selectedClubShotProfiles.mostLikely?.total, ' yd')}</span>
                            </div>
                            <div className="component-row">
                              <span>Dispersion</span>
                              <span>{formatDecimal(selectedClubShotProfiles.mostLikely?.dispersion, ' yd')}</span>
                            </div>
                            <div className="component-row">
                              <span>Dispersion variability</span>
                              <span>{formatDecimal(selectedClubShotProfiles.mostLikely?.dispersionVariability, ' yd')}</span>
                            </div>
                            <div className="component-row">
                              <span>Spin</span>
                              <span>{formatWhole(selectedClubShotProfiles.mostLikely?.spin, ' rpm')}</span>
                            </div>
                          </div>
                        </div>

                        <p className="club-detail-shot-gap">{selectedClubShotProfiles.deltaSummary}</p>
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

                    <section className="club-detail-debug-section" aria-label="FULL OGC DEBUG">
                      <article className="dashboard-card">
                        <div className="section-kicker">FULL OGC DEBUG</div>
                        <p className="support-card-copy">
                          Selected club: <strong>{getClubLabel(selectedDetailClub)}</strong>
                        </p>
                        <p className="support-card-copy">
                          Historical shots found: <strong>{formatWhole(selectedClubHistoricalShots.length)}</strong>
                        </p>
                        {selectedClubOpenGolfCoachShots.length === 0 ? (
                          <p className="support-card-copy">
                            No stored openGolfCoach payload exists yet for this club.
                          </p>
                        ) : (
                          <>
                            <div className="section-kicker">Representative Shot Payload</div>
                            <pre style={{ margin: '8px 0 14px', overflowX: 'auto' }}>
                              {stringifyDebugJson(selectedClubOpenGolfCoachShots[0].openGolfCoach)}
                            </pre>

                            <div className="section-kicker">First 3 Shot Payloads</div>
                            {selectedClubOpenGolfCoachShots.slice(0, 3).map((shot, index) => (
                              <div key={shot.id} style={{ marginTop: 8 }}>
                                <p className="support-card-copy" style={{ marginBottom: 6 }}>
                                  Shot {index + 1} ({shot.id})
                                </p>
                                <pre style={{ margin: 0, overflowX: 'auto' }}>
                                  {stringifyDebugJson(shot.openGolfCoach)}
                                </pre>
                              </div>
                            ))}
                          </>
                        )}
                      </article>
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
                                <th>Distance Window</th>
                                <th>Direction Window</th>
                                <th>Flight Quality</th>
                                <th>Pattern Stability</th>
                                <th>Data Confidence</th>
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
}

function ClubDispersionPlot({ points, lastShotId }: ClubDispersionPlotProps) {
  const width = 820
  const height = 330
  const padding = { top: 22, right: 32, bottom: 48, left: 62 }

  const offlineMax = Math.max(...points.map((point) => Math.abs(point.offline)), 5)
  const carryMin = Math.min(...points.map((point) => point.carry))
  const carryMax = Math.max(...points.map((point) => point.carry))
  const carryRange = Math.max(carryMax - carryMin, 1)
  const carryPadding = carryRange * 0.1
  const carryDomainMin = Math.floor((carryMin - carryPadding) / 5) * 5
  const carryDomainMax = Math.ceil((carryMax + carryPadding) / 5) * 5
  const yRange = Math.max(carryDomainMax - carryDomainMin, 1)
  const offlineDomainMax = Math.max(10, Math.ceil(offlineMax / 5) * 5)
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom

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
      <text className="club-detail-axis-label" x={padding.left + 8} y={height - 14}>
        Left miss (yd)
      </text>
      <text className="club-detail-axis-label" x={width - padding.right - 62} y={height - 14}>
        Right miss (yd)
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
        Target line (0)
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
