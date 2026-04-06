import { useEffect, useMemo, useRef, useState } from 'react'
import {
  novaAdapter,
  type NovaConnection,
  type NovaConnectionStatus,
  type NovaFeedMode,
} from './adapters/nova'
import './App.css'
import {
  buildOpenGolfCoachInput,
  hasOpenGolfCoachInput,
  isOpenGolfCoachConfigured,
  openGolfCoachEnricher,
} from './lib/openGolfCoach'
import { scoreClub } from './lib/scoring'
import {
  clubs,
  type Club,
  type ClubSummary,
  type IncomingNovaShot,
  type OpenGolfCoachDerivedValues,
  type OpenGolfCoachInput,
  type Shot,
} from './types'

type SessionState = 'setup' | 'live' | 'review'

const novaWebSocketUrl = import.meta.env.VITE_NOVA_WS_URL as string | undefined

const formatValue = (value: number | undefined, unit = '') => {
  if (typeof value !== 'number') {
    return '-'
  }

  return `${value}${unit}`
}

const formatDebugPayload = (
  payload:
    | IncomingNovaShot
    | OpenGolfCoachInput
    | OpenGolfCoachDerivedValues
    | null,
) =>
  payload ? JSON.stringify(payload, null, 2) : '-'

const buildSummaries = (shots: Shot[]) =>
  clubs
    .map((club) => scoreClub(club, shots))
    .filter((summary) => summary.totalShots > 0)

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

const mergeDerivedValues = (
  shot: Shot,
  derivedValues: Awaited<ReturnType<typeof openGolfCoachEnricher.enrichShot>>['derivedValues'],
): Shot => ({
  ...shot,
  enrichmentStatus: 'enriched',
  carryYards: derivedValues.carry_distance_yards ?? shot.carryYards,
  totalYards: derivedValues.total_distance_yards ?? shot.totalYards,
  offlineYards: derivedValues.offline_distance_yards ?? shot.offlineYards,
  shotName: derivedValues.shot_name ?? shot.shotName,
  shotRanking: derivedValues.shot_rank ?? shot.shotRanking,
})

function App() {
  const [sessionState, setSessionState] = useState<SessionState>('setup')
  const [selectedClub, setSelectedClub] = useState<Club>('7 Iron')
  const [shots, setShots] = useState<Shot[]>([])
  const [hasRunScoring, setHasRunScoring] = useState(false)
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
  const [lastOpenGolfCoachInput, setLastOpenGolfCoachInput] =
    useState<OpenGolfCoachInput | null>(null)
  const [lastOpenGolfCoachResponse, setLastOpenGolfCoachResponse] =
    useState<OpenGolfCoachDerivedValues | null>(null)
  const [sessionStartedAt, setSessionStartedAt] = useState<string | null>(null)
  const selectedClubRef = useRef(selectedClub)
  const connectionRef = useRef<NovaConnection | null>(null)
  const configuredMode: NovaFeedMode = novaWebSocketUrl ? 'real' : 'mock'
  const connectionResult =
    connectionStatus === 'connected'
      ? 'success'
      : connectionStatus === 'error'
        ? 'failure'
        : connectionStatus

  useEffect(() => {
    selectedClubRef.current = selectedClub
  }, [selectedClub])

  useEffect(() => {
    if (sessionState !== 'live') {
      return undefined
    }

    let isActive = true
    let activeSource: Shot['source'] = 'mock'
    const connection: NovaConnection = novaAdapter.connectToShots(
      (incomingShot) => {
        if (!isActive) {
          return
        }

        const shot = buildShot(incomingShot, selectedClubRef.current, activeSource)
        setShots((currentShots) => [shot, ...currentShots])

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
            setLastOpenGolfCoachResponse(result.derivedValues)
          }

          const hasDerivedValues = Object.values(result.derivedValues).some(
            (value) => value !== undefined,
          )
          if (!hasDerivedValues) {
            return
          }

          setShots((currentShots) =>
            currentShots.map((currentShot) =>
              currentShot.id === shot.id
                ? mergeDerivedValues(currentShot, result.derivedValues)
                : currentShot,
            ),
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
  }, [sessionState])

  const groupedShots = useMemo(
    () =>
      clubs
        .map((club) => ({
          club,
          shots: shots.filter((shot) => shot.club === club),
        }))
        .filter((group) => group.shots.length > 0),
    [shots],
  )

  const summaries: ClubSummary[] = useMemo(
    () => (hasRunScoring ? buildSummaries(shots) : []),
    [hasRunScoring, shots],
  )

  const startSession = () => {
    setShots([])
    setHasRunScoring(false)
    setFeedMode(null)
    setConnectionStatus('connecting')
    setHelperReachable(null)
    setLastEnrichmentStatus('idle')
    setLastRawMessage('-')
    setLastParsedShot(null)
    setLastOpenGolfCoachInput(null)
    setLastOpenGolfCoachResponse(null)
    setSessionStartedAt(new Date().toISOString())
    setSessionState('live')
  }

  const endSession = () => {
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

  const runScoring = () => {
    setHasRunScoring(true)
  }

  const startOver = () => {
    setSessionState('setup')
    setShots([])
    setHasRunScoring(false)
    setFeedMode(null)
    setConnectionStatus('disconnected')
    setHelperReachable(null)
    setLastEnrichmentStatus('idle')
    setLastRawMessage('-')
    setLastParsedShot(null)
    setLastOpenGolfCoachInput(null)
    setLastOpenGolfCoachResponse(null)
    setSessionStartedAt(null)
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

  return (
    <main className="app-shell">
      <h1>Nova Stock Range Validation</h1>

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

      {sessionState === 'setup' && (
        <section className="panel">
          <h2>Start Session</h2>
          <p>Start a Stock Range Session, choose the first club, and listen for Nova shots.</p>

          <label>
            Club
            <select
              value={selectedClub}
              onChange={(event) => setSelectedClub(event.target.value as Club)}
            >
              {clubs.map((club) => (
                <option key={club} value={club}>
                  {club}
                </option>
              ))}
            </select>
          </label>

          <button onClick={startSession}>Start Stock Range Session</button>
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
              {clubs.map((club) => (
                <option key={club} value={club}>
                  {club}
                </option>
              ))}
            </select>
          </label>

          <ShotTable shots={shots} onToggleShot={toggleShot} />
        </section>
      )}

      {sessionState === 'review' && (
        <section className="panel">
          <div className="toolbar">
            <div>
              <h2>Review Session</h2>
              <p>{shots.length} shots captured.</p>
            </div>
            <div className="button-row">
              <button disabled={shots.length === 0} onClick={undoLastShot}>
                Undo Last Shot
              </button>
              <button onClick={runScoring}>Run Club Scoring</button>
              <button onClick={startOver}>Start Over</button>
            </div>
          </div>

          {groupedShots.length === 0 ? (
            <p>No shots captured.</p>
          ) : (
            groupedShots.map((group) => (
              <div className="club-group" key={group.club}>
                <h3>{group.club}</h3>
                <ShotTable
                  shots={group.shots}
                  onChangeClub={updateShotClub}
                  onToggleShot={toggleShot}
                />
              </div>
            ))
          )}

          {summaries.length > 0 && (
            <div className="club-group">
              <h3>Club Summary</h3>
              <table>
                <thead>
                  <tr>
                    <th>Club</th>
                    <th>Total shots</th>
                    <th>Included</th>
                    <th>Avg carry</th>
                    <th>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((summary) => (
                    <tr key={summary.club}>
                      <td>{summary.club}</td>
                      <td>{summary.totalShots}</td>
                      <td>{summary.includedShots}</td>
                      <td>
                        {summary.averageCarryYards === null
                          ? '-'
                          : `${summary.averageCarryYards} yd`}
                      </td>
                      <td>{summary.confidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
          <th>Launch</th>
          <th>Spin</th>
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
                  {clubs.map((club) => (
                    <option key={`${shot.id}-${club}`} value={club}>
                      {club}
                    </option>
                  ))}
                </select>
              ) : (
                shot.club
              )}
            </td>
            <td>{formatValue(shot.carryYards, ' yd')}</td>
            <td>{formatValue(shot.totalYards, ' yd')}</td>
            <td>{formatValue(shot.offlineYards, ' yd')}</td>
            <td>{formatValue(shot.ballSpeedMph, ' mph')}</td>
            <td>{formatValue(shot.launchAngleDeg, ' deg')}</td>
            <td>{formatValue(shot.spinRpm, ' rpm')}</td>
            <td>
              {typeof shot.shotRanking === 'undefined' ? '-' : `${shot.shotRanking}`}
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
