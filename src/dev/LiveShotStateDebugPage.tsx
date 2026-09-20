import { useCallback, useEffect, useRef, useState } from 'react'
import {
  connectBrowserGsproCourseStateFolder,
  connectToBrowserGsproCourseState,
  prepareBrowserGsproCourseStateRuntime,
  type BrowserGsproCourseConnection,
  type BrowserGsproCourseSnapshot,
  type BrowserGsproCourseStatus,
} from '../adapters/reliableBrowserGsproCourseState'
import {
  connectToGsproLieObservation,
  type GsproLieObservationConnection,
} from '../adapters/gsproLieObservation'
import {
  connectToGsproWindObservation,
  type GsproWindObservationConnection,
} from '../adapters/gsproWindObservation'
import { assembleLiveShotState } from '../liveState/liveShotStateAssembler'
import { PreShotStateTracker, type PreShotFreezeEvent } from '../liveState/preShotTracker'
import type {
  GsproLieObservation,
  LiveField,
  LiveShotState,
  LiveStateStatus,
  TeeSelection,
  WindObservation,
} from '../liveState/types'

const mono: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
}

const statusColor: Record<LiveStateStatus, string> = {
  READY: '#166534',
  STALE: '#b45309',
  UNKNOWN: '#6b7280',
  UNAVAILABLE: '#991b1b',
}

const display = (value: unknown): string => {
  if (value == null) return '—'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3)
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return `[${value.map((item) => typeof item === 'number' ? item.toFixed(2) : String(item)).join(', ')}]`
  return JSON.stringify(value)
}

function StatusBadge({ status }: { status: LiveStateStatus }) {
  return <strong style={{ color: statusColor[status], letterSpacing: '0.04em' }}>{status}</strong>
}

function FieldRow({ label, field }: { label: string; field: LiveField<unknown> }) {
  return (
    <tr>
      <td style={{ padding: '7px 9px', fontWeight: 700, whiteSpace: 'nowrap' }}>{label}</td>
      <td style={{ padding: '7px 9px', ...mono }}>{display(field.value)}</td>
      <td style={{ padding: '7px 9px' }}><StatusBadge status={field.status} /></td>
      <td style={{ padding: '7px 9px', ...mono }}>{field.source ?? '—'}</td>
      <td style={{ padding: '7px 9px' }}>{field.ageMs == null ? '—' : `${Math.round(field.ageMs)} ms`}</td>
      <td style={{ padding: '7px 9px', minWidth: 320 }}>{field.note ?? '—'}</td>
    </tr>
  )
}

function Section({
  title,
  rows,
}: {
  title: string
  rows: Array<[string, LiveField<unknown>]>
}) {
  return (
    <section style={{ marginTop: 18 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>{title}</h2>
      <div style={{ overflowX: 'auto', border: '1px solid #9ca3af', background: '#f3f4f6' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', background: '#d1d5db' }}>
              {['Field', 'Value', 'Status', 'Source', 'Age', 'Note'].map((heading) => (
                <th key={heading} style={{ padding: '7px 9px', borderBottom: '1px solid #9ca3af' }}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, rowField]) => <FieldRow key={label} label={label} field={rowField} />)}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ValidationChain({
  title,
  stages,
}: {
  title: string
  stages: Array<{ label: string; field: LiveField<unknown> }>
}) {
  return (
    <section style={{ marginTop: 14, padding: 12, border: '1px solid #9ca3af', background: '#f3f4f6' }}>
      <h2 style={{ margin: '0 0 10px', fontSize: 18 }}>{title}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
        {stages.map(({ label, field: stageField }, index) => (
          <div key={label} style={{ padding: 10, border: '1px solid #9ca3af', background: '#e5e7eb' }}>
            <div style={{ fontSize: 10, fontWeight: 900, letterSpacing: '0.08em' }}>STAGE {index + 1}</div>
            <div style={{ marginTop: 3, fontWeight: 800 }}>{label}</div>
            <div style={{ marginTop: 6 }}><StatusBadge status={stageField.status} /></div>
            <div style={{ marginTop: 4, ...mono, fontSize: 11 }}>{display(stageField.value)}</div>
            {stageField.note && <div style={{ marginTop: 5, fontSize: 11 }}>{stageField.note}</div>}
          </div>
        ))}
      </div>
    </section>
  )
}

const PACKAGE_SELECTED_TEE: TeeSelection = {
  label: 'Greywolf package-selected tee',
  coursePoint: [0, 0],
  confidence: 'high',
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function LiveShotStateDebugPage() {
  const connectionRef = useRef<BrowserGsproCourseConnection | null>(null)
  const windConnectionRef = useRef<GsproWindObservationConnection | null>(null)
  const lieConnectionRef = useRef<GsproLieObservationConnection | null>(null)
  const latestSnapshotRef = useRef<BrowserGsproCourseSnapshot | null>(null)
  const latestWindRef = useRef<WindObservation | null>(null)
  const latestLieRef = useRef<GsproLieObservation | null>(null)
  const teeSelectionRef = useRef<TeeSelection | null>(null)
  const revisionRef = useRef(0)
  const assemblyRequestRef = useRef(0)
  const preShotTrackerRef = useRef(new PreShotStateTracker())
  const [connectionStatus, setConnectionStatus] = useState<BrowserGsproCourseStatus>('idle')
  const [state, setState] = useState<LiveShotState | null>(null)
  const [lastFrozen, setLastFrozen] = useState<PreShotFreezeEvent | null>(null)
  const [confirmedTee, setConfirmedTee] = useState<TeeSelection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const assembleSnapshot = useCallback((snapshot: BrowserGsproCourseSnapshot) => {
    revisionRef.current += 1
    assemblyRequestRef.current += 1
    const request = assemblyRequestRef.current
    const revision = revisionRef.current
    void assembleLiveShotState({
      snapshot,
      revision,
      wind: latestWindRef.current,
      lie: latestLieRef.current,
      roundTeeSelection: teeSelectionRef.current,
    })
      .then((next) => {
        if (request !== assemblyRequestRef.current) return
        preShotTrackerRef.current.acceptAssembledState(next, snapshot)
        setState(next)
      })
      .catch((assemblyError) => setError(`LiveShotState assembly failed: ${errorText(assemblyError)}`))
  }, [])

  const reassembleLatest = useCallback(() => {
    const snapshot = latestSnapshotRef.current
    if (snapshot) assembleSnapshot(snapshot)
  }, [assembleSnapshot])

  const confirmPackageTee = useCallback(() => {
    teeSelectionRef.current = PACKAGE_SELECTED_TEE
    setConfirmedTee(PACKAGE_SELECTED_TEE)
    reassembleLatest()
  }, [reassembleLatest])

  const clearTeeConfirmation = useCallback(() => {
    teeSelectionRef.current = null
    setConfirmedTee(null)
    reassembleLatest()
  }, [reassembleLatest])

  const stopWatcher = useCallback(() => {
    connectionRef.current?.disconnect()
    connectionRef.current = null
    latestSnapshotRef.current = null
  }, [])

  const startWatcher = useCallback(() => {
    stopWatcher()
    preShotTrackerRef.current.reset()
    setError(null)
    connectionRef.current = connectToBrowserGsproCourseState({
      onStatusChange: setConnectionStatus,
      onError: (nextError) => setError(errorText(nextError)),
      onSnapshot: (snapshot) => {
        latestSnapshotRef.current = snapshot
        setWarnings(snapshot.warnings)

        const frozen = preShotTrackerRef.current.observeSnapshot(snapshot)
        if (frozen) setLastFrozen(frozen)

        assembleSnapshot(snapshot)
      },
    })
  }, [assembleSnapshot, stopWatcher])

  useEffect(() => {
    let cancelled = false

    windConnectionRef.current = connectToGsproWindObservation({
      onObservation: (observation) => {
        latestWindRef.current = observation
        const snapshot = latestSnapshotRef.current
        if (snapshot) assembleSnapshot(snapshot)
      },
      onError: (windError) => setError(`Wind observation bridge failed: ${errorText(windError)}`),
    })

    lieConnectionRef.current = connectToGsproLieObservation({
      onObservation: (observation) => {
        latestLieRef.current = observation
        const snapshot = latestSnapshotRef.current
        if (snapshot) assembleSnapshot(snapshot)
      },
      onError: (lieError) => setError(`Lie observation bridge failed: ${errorText(lieError)}`),
    })

    void prepareBrowserGsproCourseStateRuntime()
      .then((ready) => {
        if (!cancelled && ready) startWatcher()
      })
      .catch((prepareError) => {
        if (!cancelled) setError(errorText(prepareError))
      })

    return () => {
      cancelled = true
      stopWatcher()
      windConnectionRef.current?.disconnect()
      windConnectionRef.current = null
      latestWindRef.current = null
      lieConnectionRef.current?.disconnect()
      lieConnectionRef.current = null
      latestLieRef.current = null
    }
  }, [assembleSnapshot, startWatcher, stopWatcher])

  const chooseFolder = async () => {
    try {
      setError(null)
      await connectBrowserGsproCourseStateFolder()
      startWatcher()
    } catch (folderError) {
      setError(errorText(folderError))
    }
  }

  const gameRows: Array<[string, LiveField<unknown>]> = state ? [
    ['Course', state.game.course],
    ['Hole', state.game.hole],
    ['Shot', state.game.shotNumber],
    ['Ball XYZ', state.game.ballPositionWorld],
    ['Ball local yd', state.game.ballPositionLocalYds],
    ['GSPro surface', state.game.startingSurface],
    ['GSPro HUD up/down lie°', state.game.gsproLieUpDownDegrees],
    ['GSPro HUD left/right lie°', state.game.gsproLieLeftRightDegrees],
    ['Target XYZ', state.game.targetPositionWorld],
    ['Target local yd', state.game.targetPositionLocalYds],
    ['Pin distance yd', state.game.targetDistanceYards],
    ['Ball→pin local bearing°', state.game.aimBearingDegrees],
    ['Ball→pin true bearing°', state.game.aimCompassBearingDegrees],
  ] : []

  const courseRows: Array<[string, LiveField<unknown>]> = state ? [
    ['Matched coordinate', state.course.matchedCoordinate],
    ['Registration residual m', state.course.registrationResidualMeters],
    ['OSM surface', state.course.surface],
    ['Ground elevation ft', state.course.groundElevationFt],
    ['Terrain plane', state.course.terrainPlane],
    ['LiDAR up/down lie°', state.course.uphillDownhillLieDegrees],
    ['LiDAR left/right lie°', state.course.leftRightLieDegrees],
    ['Target elevation Δ ft', state.course.targetElevationChangeFt],
  ] : []

  const windRows: Array<[string, LiveField<unknown>]> = state ? [
    ['Wind speed mph', state.wind.speedMph],
    ['Wind direction°', state.wind.directionDegrees],
    ['Direction convention', state.wind.directionConvention],
    ['Reference frame', state.wind.referenceFrame],
    ['OCR confidence', state.wind.ocrConfidence],
    ['Helping / hurting mph', state.wind.helpingHurtingMph],
    ['Left / right mph', state.wind.leftRightMph],
  ] : []

  const teeRows: Array<[string, LiveField<unknown>]> = state ? [
    ['Tee selection', state.tee.selection],
  ] : []

  const sourceRows: Array<[string, LiveField<unknown>]> = state ? [
    ['currentRound.dat', state.sources.currentRound],
    ['output_log.txt', state.sources.outputLog],
    ['Course registration', state.sources.registration],
    ['LiDAR', state.sources.lidar],
    ['Wind OCR', state.sources.windOcr],
    ['Lie OCR', state.sources.lieOcr],
  ] : []

  return (
    <main style={{ maxWidth: 1500, margin: '0 auto', padding: 24, color: '#111827', background: '#e5e7eb', minHeight: '100vh' }}>
      <header style={{ paddingBottom: 14, borderBottom: '2px solid #6b7280' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'baseline' }}>
          <div>
            <p style={{ margin: 0, fontSize: 11, fontWeight: 900, letterSpacing: '0.14em' }}>LOOPER DEV · GREYWOLF PRE-SHOT STATE</p>
            <h1 style={{ margin: '4px 0 2px' }}>LiveShotState gray wall</h1>
          </div>
          <strong style={mono}>watcher: {connectionStatus}</strong>
          {state && <strong style={mono}>REV {state.revision}</strong>}
          {state && <StatusBadge status={state.overallStatus} />}
        </div>
        <p style={{ margin: '8px 0 0', maxWidth: 1050 }}>
          Diagnostic truth surface only. UNKNOWN / UNAVAILABLE values are intentional. This page does not feed or alter Live Caddie recommendations.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => void chooseFolder()}>Choose / reconnect GSPro folder</button>
          <button type="button" onClick={startWatcher}>Restart watcher</button>
        </div>
      </header>

      {error && (
        <div style={{ marginTop: 14, padding: 12, border: '1px solid #991b1b', background: '#fee2e2' }}>
          <strong>ERROR:</strong> {error}
        </div>
      )}

      {!state && !error && (
        <div style={{ marginTop: 18, padding: 18, border: '1px solid #9ca3af', background: '#f3f4f6' }}>
          Waiting for a trustworthy GSPro course-state snapshot. If folder permission is not already persisted, choose the GSPro folder above.
        </div>
      )}

      {state && (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '10px 0 0', ...mono }}>
            <span>assembled: {state.assembledAt}</span>
            <span>tee method: {state.tee.detectionMethod}</span>
          </div>

          <section style={{ marginTop: 14, padding: 12, border: '1px solid #9ca3af', background: '#fff7ed' }}>
            <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Shot-1 tee validation</h2>
            <p style={{ margin: '0 0 10px', maxWidth: 1100 }}>
              Greywolf currently retains exact local geometry only for the tee selected when the package was built. Confirm it only when GSPro is using that same tee. This never auto-assumes [0,0]; alternate tees remain unresolved until their exact coordinates are retained in the package.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" onClick={confirmPackageTee} disabled={Boolean(confirmedTee)}>
                Confirm package-selected tee [0,0]
              </button>
              <button type="button" onClick={clearTeeConfirmation} disabled={!confirmedTee}>
                Clear tee confirmation
              </button>
              <strong style={mono}>{confirmedTee ? 'CONFIRMED FOR THIS DEV SESSION' : 'NOT CONFIRMED'}</strong>
            </div>
          </section>

          <ValidationChain
            title="Wind validation chain"
            stages={[
              { label: 'HUD OCR feed', field: state.sources.windOcr },
              { label: 'Parsed speed', field: state.wind.speedMph },
              { label: 'Parsed compass direction', field: state.wind.directionDegrees },
              { label: 'True shot bearing', field: state.game.aimCompassBearingDegrees },
              { label: 'Helping / hurting', field: state.wind.helpingHurtingMph },
              { label: 'Left / right', field: state.wind.leftRightMph },
            ]}
          />

          <ValidationChain
            title="GSPro minimap lie validation chain"
            stages={[
              { label: 'Minimap OCR feed', field: state.sources.lieOcr },
              { label: 'Current surface', field: state.game.startingSurface },
              { label: 'HUD up/down lie', field: state.game.gsproLieUpDownDegrees },
              { label: 'HUD left/right lie', field: state.game.gsproLieLeftRightDegrees },
            ]}
          />

          <ValidationChain
            title="Ball → LiDAR terrain → independent lie validation chain"
            stages={[
              { label: 'Ball local coordinate', field: state.game.ballPositionLocalYds },
              { label: 'Course registration', field: state.sources.registration },
              { label: 'LiDAR sample', field: state.sources.lidar },
              { label: 'Terrain plane', field: state.course.terrainPlane },
              { label: 'LiDAR up/down lie', field: state.course.uphillDownhillLieDegrees },
              { label: 'LiDAR sidehill lie', field: state.course.leftRightLieDegrees },
            ]}
          />

          <section style={{ marginTop: 14, padding: 12, border: '1px solid #9ca3af', background: '#f3f4f6' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>Last automatic pre-shot freeze</h2>
            {lastFrozen ? (
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', ...mono }}>
                <span>trigger: {lastFrozen.triggerShotKey}</span>
                <span>epoch: {lastFrozen.sourceEpoch}</span>
                <span>frozen: {lastFrozen.frozenAt}</span>
                <span>state REV: {lastFrozen.state.revision}</span>
                <span>H{lastFrozen.state.game.hole.value ?? '—'} / shot {lastFrozen.state.game.shotNumber.value ?? '—'}</span>
                <span>status: {lastFrozen.state.overallStatus}</span>
              </div>
            ) : (
              <p style={{ margin: 0 }}>None yet. A freeze occurs only when a new physical GSPro latestShotKey arrives and exactly matches the last assembled pre-shot hole + shot number in the same source epoch.</p>
            )}
          </section>

          <Section title="GSPro / game" rows={gameRows} />
          <Section title="Greywolf course + terrain" rows={courseRows} />
          <Section title="Wind" rows={windRows} />
          <Section title="Tee" rows={teeRows} />
          <Section title="Source health" rows={sourceRows} />
          <section style={{ marginTop: 18, padding: 12, border: '1px solid #9ca3af', background: '#f3f4f6' }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Watcher warnings</h2>
            {warnings.length === 0 ? <p style={{ margin: 0 }}>None.</p> : (
              <ul style={{ marginBottom: 0 }}>
                {warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  )
}

export default LiveShotStateDebugPage
