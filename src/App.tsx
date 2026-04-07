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
import {
  buildOpenGolfCoachInput,
  hasOpenGolfCoachInput,
  isOpenGolfCoachConfigured,
  openGolfCoachEnricher,
} from './lib/openGolfCoach'
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
  type OpenGolfCoachInput,
  type OpenGolfCoachPayload,
  type ReviewClubSummary,
  type SavedSession,
  type Shot,
} from './types'

type SessionState = 'setup' | 'live' | 'review'
type SessionFeedMode = 'mock' | 'real'

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

const formatDebugValue = (key: string, value: number) => {
  const lowerKey = key.toLowerCase()

  if (lowerKey.includes('score')) {
    return Number(Math.round(value))
  }

  if (lowerKey.includes('spin') && !lowerKey.includes('axis')) {
    return Number(Math.round(value))
  }

  return Number(value.toFixed(1))
}

const formatDebugPayload = (payload: unknown) => {
  if (payload === null || typeof payload === 'undefined') {
    return '-'
  }

  return JSON.stringify(
    payload,
    (key, value) =>
      typeof value === 'number' ? formatDebugValue(key, value) : value,
    2,
  )
}

const formatRawJson = (payload: unknown) => {
  if (payload === null || typeof payload === 'undefined') {
    return '-'
  }

  return JSON.stringify(payload, null, 2)
}

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

function App() {
  const [sessionState, setSessionState] = useState<SessionState>('setup')
  const [selectedFeedMode, setSelectedFeedMode] = useState<SessionFeedMode>('mock')
  const [selectedClub, setSelectedClub] = useState<Club>('7i')
  const [shots, setShots] = useState<Shot[]>([])
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
  const [lastRawMessage, setLastRawMessage] = useState<string>('-')
  const [lastParsedShot, setLastParsedShot] =
    useState<IncomingNovaShot | null>(null)
  const [lastStoredShot, setLastStoredShot] = useState<Shot | null>(null)
  const [lastOpenGolfCoachInput, setLastOpenGolfCoachInput] =
    useState<OpenGolfCoachInput | null>(null)
  const [lastOpenGolfCoachResponse, setLastOpenGolfCoachResponse] =
    useState<OpenGolfCoachPayload | null>(null)
  const [sessionStartedAt, setSessionStartedAt] = useState<string | null>(null)
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null)
  const [showShotData, setShowShotData] = useState(false)
  const selectedClubRef = useRef(selectedClub)
  const connectionRef = useRef<NovaConnection | null>(null)
  const configuredMode: NovaFeedMode = selectedFeedMode
  const connectionResult =
    connectionStatus === 'connected'
      ? 'success'
      : connectionStatus === 'error'
        ? 'failure'
        : connectionStatus
  const liveNovaUnavailable = selectedFeedMode === 'real' && !novaWebSocketUrl
  const mostRecentShotData = useMemo(() => {
    const mostRecentShot = shots[0]

    if (!mostRecentShot) {
      return null
    }

    return {
      rawNova:
        lastStoredShot && lastStoredShot.id === mostRecentShot.id ? lastParsedShot : null,
      shot: mostRecentShot,
      openGolfCoach: mostRecentShot.openGolfCoach ?? null,
      enrichmentStatus: mostRecentShot.enrichmentStatus,
    }
  }, [lastParsedShot, lastStoredShot, shots])
  const latestShotOpenGolfCoachKeys = useMemo(() => {
    const payload = shots[0]?.openGolfCoach

    if (!payload) {
      return []
    }

    return Object.keys(payload).sort((left, right) => left.localeCompare(right))
  }, [shots])
  const helperResponseTopLevelKeys = useMemo(() => {
    if (!lastOpenGolfCoachResponse) {
      return []
    }

    return Object.keys(lastOpenGolfCoachResponse).sort((left, right) =>
      left.localeCompare(right),
    )
  }, [lastOpenGolfCoachResponse])
  const latestReloadedOpenGolfCoachKeys = useMemo(() => {
    const reloadTraceToken = `${sessionState}:${savedSessions.length}:${shots.length}`
    void reloadTraceToken

    const activeDraftShot = loadActiveSessionDraft()?.shots[0]
    if (activeDraftShot?.openGolfCoach) {
      return Object.keys(activeDraftShot.openGolfCoach).sort((left, right) =>
        left.localeCompare(right),
      )
    }

    const reloadedSavedShot = loadSavedSessions()[0]?.shots[0]
    if (reloadedSavedShot?.openGolfCoach) {
      return Object.keys(reloadedSavedShot.openGolfCoach).sort((left, right) =>
        left.localeCompare(right),
      )
    }

    return []
  }, [savedSessions.length, sessionState, shots.length])

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
        setLastStoredShot(shot)

        const openGolfCoachInput = buildOpenGolfCoachInput(incomingShot)
        console.info('[OpenGolfCoach] built input:', openGolfCoachInput)
        setLastOpenGolfCoachInput(openGolfCoachInput)
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
            setLastOpenGolfCoachResponse(null)
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
            setLastOpenGolfCoachResponse(result.payload)
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
          setLastStoredShot((currentShot) =>
            currentShot && currentShot.id === shot.id
              ? mergeDerivedValues(currentShot, result.payload, result.derivedValues)
              : currentShot,
          )
        })
      },
      setConnectionStatus,
      (event) => {
        setLastRawMessage(event.rawMessage)
        setLastParsedShot(event.normalizedShot)
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

  const groupedShots = useMemo(
    () =>
      activeBagClubIds
        .map((club) => ({
          club,
          shots: shots.filter((shot) => shot.club === club),
        }))
        .filter((group) => group.shots.length > 0),
    [shots],
  )

  const dashboardShots = useMemo(
    () => savedSessions.flatMap((savedSession) => savedSession.shots),
    [savedSessions],
  )

  const reviewSummaries: ReviewClubSummary[] = useMemo(
    () =>
      activeBagClubIds
        .map((club) =>
          summarizeReviewClub(club, shots, savedSessions, activeSessionId),
        )
        .filter((summary): summary is ReviewClubSummary => summary !== null),
    [activeSessionId, savedSessions, shots],
  )

  const dashboardSummaries: ReviewClubSummary[] = useMemo(
    () =>
      activeBagClubIds
        .map((club) => summarizeReviewClub(club, dashboardShots, savedSessions, null))
        .filter((summary): summary is ReviewClubSummary => summary !== null),
    [dashboardShots, savedSessions],
  )

  const rankedReviewSummaries = useMemo(
    () => [...reviewSummaries].sort((left, right) => right.caddieScore - left.caddieScore),
    [reviewSummaries],
  )

  const rankedDashboardSummaries = useMemo(
    () =>
      [...dashboardSummaries].sort((left, right) => right.caddieScore - left.caddieScore),
    [dashboardSummaries],
  )

  const dashboardSummaryLead = rankedDashboardSummaries[0] ?? null

  const reviewSummaryLead = rankedReviewSummaries[0] ?? null
  const reviewInsights = useMemo(() => {
    if (!reviewSummaryLead) {
      return []
    }

    const insights = [
      `${getClubLabel(reviewSummaryLead.club)} is the current ${reviewSummaryLead.caddieCall.toLowerCase()} club at ${reviewSummaryLead.caddieScore}.`,
      ...reviewSummaryLead.insights,
    ]

    return insights.slice(0, 3)
  }, [reviewSummaryLead])

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

  const startSession = () => {
    setShots([])
    setLiveSessionId(crypto.randomUUID())
    setFeedMode(null)
    setConnectionStatus('connecting')
    setHelperReachable(null)
    setLastEnrichmentStatus('idle')
    setLastRawMessage('-')
    setLastParsedShot(null)
    setLastStoredShot(null)
    setLastOpenGolfCoachInput(null)
    setLastOpenGolfCoachResponse(null)
    setSessionStartedAt(new Date().toISOString())
    setSessionState('live')
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

    setSavedSessions((currentSessions) => {
      const nextSessions = [savedSession, ...currentSessions]
      saveSessionHistory(nextSessions)
      return nextSessions
    })
    clearActiveSessionDraft()
    setActiveSessionId(savedSession.id)
    setLiveSessionId(null)
    setSessionState('review')
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
    setLastRawMessage('-')
    setLastParsedShot(null)
    setLastStoredShot(null)
    setLastOpenGolfCoachInput(null)
    setLastOpenGolfCoachResponse(null)
    setSessionStartedAt(null)
    clearActiveSessionDraft()
  }

  const undoLastShot = () => {
    setShots((currentShots) => currentShots.slice(1))
  }

  const updateShotClub = (shotId: string, club: Club) => {
    setShots((currentShots) =>
      currentShots.map((shot) =>
        shot.id === shotId ? { ...shot, club } : shot,
      ),
    )
  }

  const openSavedSession = (sessionId: string) => {
    const session = savedSessions.find((savedSession) => savedSession.id === sessionId)
    if (!session) {
      return
    }

    setShots(session.shots)
    setActiveSessionId(session.id)
    setSessionState('review')
  }

  const ogcValidationSection = (
    <section className="panel ogc-validation-panel">
      <h2>FULL OGC VALIDATION</h2>
      <p>
        Helper response keys:{' '}
        {helperResponseTopLevelKeys.length > 0
          ? helperResponseTopLevelKeys.join(', ')
          : '-'}
      </p>
      <p>
        openGolfCoach keys before save:{' '}
        {latestShotOpenGolfCoachKeys.length > 0
          ? latestShotOpenGolfCoachKeys.join(', ')
          : '-'}
      </p>
      <p>
        openGolfCoach keys after reload:{' '}
        {latestReloadedOpenGolfCoachKeys.length > 0
          ? latestReloadedOpenGolfCoachKeys.join(', ')
          : '-'}
      </p>
      <pre className="debug-value debug-value-full">
        {formatRawJson(shots[0]?.openGolfCoach ?? null)}
      </pre>
    </section>
  )

  return (
    <main className={`app-shell ${sessionState === 'review' ? 'dashboard-shell' : ''}`}>
      {sessionState !== 'review' && <h1>Nova Stock Range Validation</h1>}

      {sessionState !== 'review' && ogcValidationSection}

      {sessionState !== 'review' && (
        <section className="panel">
          <div className="button-row">
            <button onClick={() => setShowShotData((current) => !current)}>
              {showShotData ? 'Hide Shot Data' : 'Show Shot Data'}
            </button>
          </div>
          {showShotData && (
            <>
              <p>
                Full OpenGolfCoach payload on latest shot:{' '}
                {shots[0]?.openGolfCoach ? 'yes' : 'no'}
              </p>
              <p>
                Top-level OpenGolfCoach keys:{' '}
                {latestShotOpenGolfCoachKeys.length > 0
                  ? latestShotOpenGolfCoachKeys.join(', ')
                  : '-'}
              </p>
              <p>
                Helper response top-level keys:{' '}
                {helperResponseTopLevelKeys.length > 0
                  ? helperResponseTopLevelKeys.join(', ')
                  : '-'}
              </p>
              <p>
                shot.openGolfCoach top-level keys before persistence:{' '}
                {latestShotOpenGolfCoachKeys.length > 0
                  ? latestShotOpenGolfCoachKeys.join(', ')
                  : '-'}
              </p>
              <p>
                shot.openGolfCoach top-level keys after reload from localStorage:{' '}
                {latestReloadedOpenGolfCoachKeys.length > 0
                  ? latestReloadedOpenGolfCoachKeys.join(', ')
                  : '-'}
              </p>
              <p>Stored shot view mostly shows convenience fields plus nested openGolfCoach.</p>
              <pre className="debug-value debug-value-full">
                {formatRawJson(mostRecentShotData)}
              </pre>
            </>
          )}
        </section>
      )}

      {sessionState !== 'review' && (
        <section className="panel tester-panel">
        <h2>Nova Connection Tester</h2>
        <table>
          <tbody>
            <tr>
              <th>VITE_NOVA_WS_URL</th>
              <td>{novaWebSocketUrl ?? 'not set'}</td>
            </tr>
            <tr>
              <th>Attempting mode</th>
              <td>{configuredMode}</td>
            </tr>
            <tr>
              <th>Active mode</th>
              <td>{feedMode ?? 'not connected'}</td>
            </tr>
            <tr>
              <th>Connection result</th>
              <td>
                <span className={`status-indicator status-${connectionStatus}`}>
                  {connectionResult}
                </span>
              </td>
            </tr>
            <tr>
              <th>Raw Nova message</th>
              <td>
                <pre className="debug-value">{lastRawMessage}</pre>
              </td>
            </tr>
            <tr>
              <th>Parsed shot</th>
              <td>
                <pre className="debug-value">
                  {formatDebugPayload(lastParsedShot)}
                </pre>
              </td>
            </tr>
            <tr>
              <th>Stored shot</th>
              <td>
                <pre className="debug-value debug-value-full">
                  {formatRawJson(lastStoredShot)}
                </pre>
              </td>
            </tr>
            <tr>
              <th>Stored shot OpenGolfCoach</th>
              <td>
                <pre className="debug-value debug-value-full">
                  {formatRawJson(lastStoredShot?.openGolfCoach ?? null)}
                </pre>
              </td>
            </tr>
            <tr>
              <th>OpenGolfCoach input</th>
              <td>
                <pre className="debug-value">
                  {formatDebugPayload(lastOpenGolfCoachInput)}
                </pre>
              </td>
            </tr>
            <tr>
              <th>OpenGolfCoach response</th>
              <td>
                <pre className="debug-value">
                  {formatDebugPayload(lastOpenGolfCoachResponse)}
                </pre>
              </td>
            </tr>
          </tbody>
        </table>
        </section>
      )}

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
              <div className="dashboard-rail-mark">Nova</div>
              <div>
                <div className="dashboard-rail-title">Caddie Dashboard</div>
                <div className="dashboard-rail-subtitle">Current game status</div>
              </div>
            </div>

            <nav className="dashboard-rail-nav" aria-label="Dashboard navigation">
              <a href="#dashboard-overview">Overview</a>
              <a href="#dashboard-spotlights">Spotlights</a>
              <a href="#dashboard-bag">Bag</a>
              <a href="#dashboard-trends">Trends</a>
              <a href="#dashboard-review">Detailed Review</a>
            </nav>

            <div className="dashboard-rail-clubs">
              <div className="dashboard-rail-label">Club List</div>
              <div className="dashboard-rail-club-list">
                {dashboardClubCards.map((card) => (
                  <a href={`#${clubAnchorId(card.club)}`} key={card.club}>
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
              <button onClick={() => setShowShotData((current) => !current)}>
                {showShotData ? 'Hide Shot Data' : 'Show Shot Data'}
              </button>
            </div>
          </aside>

          <div className="dashboard-screen">
            {ogcValidationSection}

            {dashboardSummaryLead ? (
              <>
                <section
                  aria-labelledby="dashboard-game-status-title"
                  className="dashboard-hero-card"
                  id="dashboard-overview"
                >
                  <h3 className="dashboard-hero-title" id="dashboard-game-status-title">
                    Game Status
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

                <section className="review-details-card" id="dashboard-review">
                <div className="section-kicker">Session Review</div>
                <details className="supporting-details">
                  <summary>Open detailed review</summary>
                  <section className="review-card caddie-summary-card">
                    <div
                      className={`caddie-summary-primary ${caddieToneClassName(
                        reviewSummaryLead.caddieCall,
                      )}`}
                    >
                      <div className="section-kicker">Caddie Score</div>
                      <div className="caddie-score-value">
                        {formatScore(reviewSummaryLead.caddieScore)}
                      </div>
                      <div className={caddieCallClassName(reviewSummaryLead.caddieCall)}>
                        {reviewSummaryLead.caddieCall}
                      </div>
                      <div className="summary-support-text">
                        {getClubLabel(reviewSummaryLead.club)} • {reviewSummaryLead.includedShots} included shots
                      </div>
                    </div>
                    <div className="caddie-summary-explanation">
                      <p>{reviewSummaryLead.explanation}</p>
                    </div>
                    <div className="caddie-summary-components">
                      <div className="component-row">
                        <span>Distance Window</span>
                        <span>{formatScore(reviewSummaryLead.componentScores.distanceWindow)}</span>
                      </div>
                      <div className="component-row">
                        <span>Direction Window</span>
                        <span>{formatScore(reviewSummaryLead.componentScores.directionWindow)}</span>
                      </div>
                      <div className="component-row">
                        <span>Flight Quality</span>
                        <span>{formatScore(reviewSummaryLead.componentScores.flightQuality)}</span>
                      </div>
                      <div className="component-row">
                        <span>Pattern Stability</span>
                        <span>{formatScore(reviewSummaryLead.componentScores.patternStability)}</span>
                      </div>
                      <div className="component-row">
                        <span>Data Confidence</span>
                        <span>{formatScore(reviewSummaryLead.componentScores.dataConfidence)}</span>
                      </div>
                    </div>
                  </section>

                  <section className="review-card">
                    <div className="section-kicker">Key Insights</div>
                    <div className="insight-list">
                      {reviewInsights.map((insight) => (
                        <div
                          className={`insight-row ${caddieToneClassName(
                            reviewSummaryLead.caddieCall,
                          )}`}
                          key={insight}
                        >
                          {insight}
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="review-card">
                    <div className="section-kicker">Club Review</div>
                    <div className="review-table-wrap">
                      <table className="review-table">
                        <thead>
                          <tr>
                            <th>Club</th>
                            <th>Caddie Score</th>
                            <th>Caddie Call</th>
                            <th>Insights</th>
                            <th>Included Shots</th>
                            <th>Carry Avg / Std Dev</th>
                            <th>Offline Avg / Std Dev</th>
                            <th>Shot Rank Summary</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reviewSummaries.map((summary) => (
                            <tr key={summary.club}>
                              <td>{getClubLabel(summary.club)}</td>
                              <td className="review-score-cell">
                                {formatScore(summary.caddieScore)}
                              </td>
                              <td>
                                <span className={caddieCallClassName(summary.caddieCall)}>
                                  {summary.caddieCall}
                                </span>
                              </td>
                              <td className="review-insight-cell">{summary.insights.join(' ')}</td>
                              <td className="review-center-cell">
                                {formatWhole(summary.includedShots)}
                              </td>
                              <td>
                                <div>
                                  {summary.carryAverageYards === null
                                    ? '-'
                                    : formatDecimal(summary.carryAverageYards, ' yd')}
                                </div>
                                <div className="metric-subline">
                                  {summary.carryStdDevYards === null
                                    ? '-'
                                    : `Std dev ${formatDecimal(summary.carryStdDevYards, ' yd')}`}
                                </div>
                              </td>
                              <td>
                                <div>
                                  {summary.offlineAverageYards === null
                                    ? '-'
                                    : formatDecimal(summary.offlineAverageYards, ' yd')}
                                </div>
                                <div className="metric-subline">
                                  {summary.offlineStdDevYards === null
                                    ? '-'
                                    : `Std dev ${formatDecimal(summary.offlineStdDevYards, ' yd')}`}
                                </div>
                              </td>
                              <td>{summary.shotRankSummary}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                <section className="review-card">
                  <div className="section-kicker">Supporting Metrics</div>
                  {showShotData && (
                    <>
                      <p>
                        Full OpenGolfCoach payload on latest shot:{' '}
                        {shots[0]?.openGolfCoach ? 'yes' : 'no'}
                      </p>
                      <p>
                        Top-level OpenGolfCoach keys:{' '}
                          {latestShotOpenGolfCoachKeys.length > 0
                            ? latestShotOpenGolfCoachKeys.join(', ')
                            : '-'}
                      </p>
                      <p>
                        Helper response top-level keys:{' '}
                        {helperResponseTopLevelKeys.length > 0
                          ? helperResponseTopLevelKeys.join(', ')
                          : '-'}
                      </p>
                      <p>
                        shot.openGolfCoach top-level keys before persistence:{' '}
                        {latestShotOpenGolfCoachKeys.length > 0
                          ? latestShotOpenGolfCoachKeys.join(', ')
                          : '-'}
                      </p>
                      <p>
                        shot.openGolfCoach top-level keys after reload from localStorage:{' '}
                        {latestReloadedOpenGolfCoachKeys.length > 0
                          ? latestReloadedOpenGolfCoachKeys.join(', ')
                          : '-'}
                      </p>
                      <p>
                        Stored shot view mostly shows convenience fields plus nested
                        openGolfCoach.
                      </p>
                      <pre className="debug-value debug-value-full">
                        {formatRawJson(mostRecentShotData)}
                      </pre>
                    </>
                  )}
                  <div className="supporting-grid">
                      <div className="supporting-block">
                        <div className="supporting-title">Component Breakdown</div>
                        {reviewSummaries.map((summary) => (
                          <div className="supporting-metric-group" key={summary.club}>
                            <div className="supporting-club-row">
                              <span>{getClubLabel(summary.club)}</span>
                              <span>{formatScore(summary.caddieScore)}</span>
                            </div>
                            <div className="component-row">
                              <span>Distance Window</span>
                              <span>{formatScore(summary.componentScores.distanceWindow)}</span>
                            </div>
                            <div className="component-row">
                              <span>Direction Window</span>
                              <span>{formatScore(summary.componentScores.directionWindow)}</span>
                            </div>
                            <div className="component-row">
                              <span>Flight Quality</span>
                              <span>{formatScore(summary.componentScores.flightQuality)}</span>
                            </div>
                            <div className="component-row">
                              <span>Pattern Stability</span>
                              <span>{formatScore(summary.componentScores.patternStability)}</span>
                            </div>
                            <div className="component-row">
                              <span>Data Confidence</span>
                              <span>{formatScore(summary.componentScores.dataConfidence)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="supporting-block">
                        <div className="supporting-title">Debug / Breakdown</div>
                        <details className="supporting-details">
                          <summary>Show debug details</summary>
                          <div className="supporting-debug">
                            <div className="supporting-debug-label">Raw Nova message</div>
                            <pre className="debug-value">{lastRawMessage}</pre>
                          </div>
                          <div className="supporting-debug">
                            <div className="supporting-debug-label">Parsed shot</div>
                            <pre className="debug-value">{formatDebugPayload(lastParsedShot)}</pre>
                          </div>
                          <div className="supporting-debug">
                            <div className="supporting-debug-label">Stored shot</div>
                            <pre className="debug-value debug-value-full">
                              {formatRawJson(lastStoredShot)}
                            </pre>
                          </div>
                          <div className="supporting-debug">
                            <div className="supporting-debug-label">
                              Stored shot OpenGolfCoach
                            </div>
                            <pre className="debug-value debug-value-full">
                              {formatRawJson(lastStoredShot?.openGolfCoach ?? null)}
                            </pre>
                          </div>
                          <div className="supporting-debug">
                            <div className="supporting-debug-label">OpenGolfCoach input</div>
                            <pre className="debug-value">{formatDebugPayload(lastOpenGolfCoachInput)}</pre>
                          </div>
                          <div className="supporting-debug">
                            <div className="supporting-debug-label">OpenGolfCoach response</div>
                            <pre className="debug-value">{formatDebugPayload(lastOpenGolfCoachResponse)}</pre>
                          </div>
                        </details>
                      </div>
                      {groupedShots.length > 0 && (
                        <div className="supporting-block supporting-block-full">
                          <div className="supporting-title">Shot Review</div>
                          <details className="supporting-details">
                            <summary>Show shot review</summary>
                            {groupedShots.map((group) => (
                              <div className="club-group" key={group.club}>
                                <h3>{getClubLabel(group.club)}</h3>
                                <ShotTable
                                  shots={group.shots}
                                  onChangeClub={updateShotClub}
                                  onToggleShot={toggleShot}
                                />
                              </div>
                            ))}
                          </details>
                        </div>
                      )}
                    </div>
                  </section>
                </details>
                </section>
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
