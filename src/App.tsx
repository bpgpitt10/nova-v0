import { useEffect, useMemo, useRef, useState } from 'react'
import {
  novaAdapter,
  type NovaConnection,
  type NovaConnectionStatus,
  type NovaFeedMode,
} from './adapters/nova'
import './App.css'
import { scoreClub } from './lib/scoring'
import { clubs, type Club, type ClubSummary, type IncomingNovaShot, type Shot } from './types'

type SessionState = 'setup' | 'live' | 'review'

const novaWebSocketUrl = import.meta.env.VITE_NOVA_WS_URL as string | undefined

const formatValue = (value: number | undefined, unit = '') => {
  if (typeof value !== 'number') {
    return '-'
  }

  return `${value}${unit}`
}

const formatDebugPayload = (payload: IncomingNovaShot | null) =>
  payload ? JSON.stringify(payload, null, 2) : '-'

const buildShot = (
  incomingShot: IncomingNovaShot,
  club: Club,
  source: Shot['source'],
): Shot => ({
  id:
    incomingShot.id ??
    `${source}-${incomingShot.timestamp ?? Date.now()}-${crypto.randomUUID()}`,
  club,
  included: true,
  capturedAt: incomingShot.timestamp ?? new Date().toISOString(),
  ballSpeedMph: incomingShot.ballSpeedMph,
  carryYards: incomingShot.carryYards ?? incomingShot.carry,
  totalYards: incomingShot.totalYards ?? incomingShot.total,
  offlineYards: incomingShot.offlineYards ?? incomingShot.offline,
  launchAngleDeg: incomingShot.launchAngleDeg ?? incomingShot.vla,
  spinRpm: incomingShot.spinRpm ?? incomingShot.spin,
  shotRanking: incomingShot.shotRanking,
  source,
})

function App() {
  const [sessionState, setSessionState] = useState<SessionState>('setup')
  const [selectedClub, setSelectedClub] = useState<Club>('7 Iron')
  const [shots, setShots] = useState<Shot[]>([])
  const [summaries, setSummaries] = useState<ClubSummary[]>([])
  const [feedMode, setFeedMode] = useState<NovaFeedMode | null>(null)
  const [connectionStatus, setConnectionStatus] =
    useState<NovaConnectionStatus>('disconnected')
  const [lastRawMessage, setLastRawMessage] = useState<string>('-')
  const [lastNormalizedShot, setLastNormalizedShot] =
    useState<IncomingNovaShot | null>(null)
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

    let activeSource: Shot['source'] = 'mock'
    const connection: NovaConnection = novaAdapter.connectToShots(
      (incomingShot) => {
        setShots((currentShots) => [
          buildShot(incomingShot, selectedClubRef.current, activeSource),
          ...currentShots,
        ])
      },
      setConnectionStatus,
      (event) => {
        setLastRawMessage(event.rawMessage)
        setLastNormalizedShot(event.normalizedShot)
      },
    )

    activeSource = connection.mode === 'mock' ? 'mock' : 'nova'
    connectionRef.current = connection
    setFeedMode(connection.mode)

    return () => {
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

  const startSession = () => {
    setShots([])
    setSummaries([])
    setFeedMode(null)
    setConnectionStatus('connecting')
    setLastRawMessage('-')
    setLastNormalizedShot(null)
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
    setSummaries(
      clubs
        .map((club) => scoreClub(club, shots))
        .filter((summary) => summary.totalShots > 0),
    )
  }

  const startOver = () => {
    setSessionState('setup')
    setShots([])
    setSummaries([])
    setFeedMode(null)
    setConnectionStatus('disconnected')
    setLastRawMessage('-')
    setLastNormalizedShot(null)
    setSessionStartedAt(null)
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
              <th>Last raw message</th>
              <td>
                <pre className="debug-value">{lastRawMessage}</pre>
              </td>
            </tr>
            <tr>
              <th>Last normalized shot</th>
              <td>
                <pre className="debug-value">
                  {formatDebugPayload(lastNormalizedShot)}
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
                <ShotTable shots={group.shots} onToggleShot={toggleShot} />
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
  onToggleShot: (shotId: string) => void
}

function ShotTable({ shots, onToggleShot }: ShotTableProps) {
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
          <th>Ball speed</th>
          <th>Launch</th>
          <th>Spin</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {shots.map((shot) => (
          <tr key={shot.id}>
            <td>{new Date(shot.capturedAt).toLocaleTimeString()}</td>
            <td>{shot.club}</td>
            <td>{formatValue(shot.carryYards, ' yd')}</td>
            <td>{formatValue(shot.ballSpeedMph, ' mph')}</td>
            <td>{formatValue(shot.launchAngleDeg, ' deg')}</td>
            <td>{formatValue(shot.spinRpm, ' rpm')}</td>
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
