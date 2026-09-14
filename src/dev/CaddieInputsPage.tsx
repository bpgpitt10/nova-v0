import { useEffect, useMemo, useState } from 'react'
import { getCurrentLooperUser } from '../cloud/supabaseClient'
import { buildLiveCaddieProfileSet } from '../liveCaddie/profileProvider'
import { modelShotContext } from '../liveCaddie/shotContextModel'
import type {
  CaddieModelFactor,
  CaddieModelStatus,
  ShotContextInput,
} from '../liveCaddie/modelContract'
import {
  buildWindCalibrationMatrix,
  createWindCalibrationObservation,
  loadWindCalibrationObservations,
  saveWindCalibrationObservations,
  WIND_DIRECTIONS,
  WIND_SPEEDS,
  WIND_TRAJECTORY_CLASSES,
  windCalibrationReadiness,
  windDirectionLabel,
  type WindDirectionCase,
  type WindTrajectoryClass,
} from '../liveCaddie/windCalibration'
import {
  loadSavedSessions,
  SESSION_HISTORY_UPDATED_EVENT,
} from '../lib/sessions'
import type { SavedSession } from '../types'
import './caddieInputs.css'

const statusLabel: Record<CaddieModelStatus, string> = {
  modeled: 'MODELED',
  calibrating: 'CALIBRATING',
  review: 'REVIEW',
  'not-modeled': 'NOT MODELED',
  unavailable: 'UNAVAILABLE',
}

const pct = (value: number) => `${Math.round(value * 100)}%`

const numberOrNull = (value: string) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const effectLabel = (factor: CaddieModelFactor) =>
  factor.affects.length > 0 ? factor.affects.join(' · ') : '—'

function CaddieInputsPage() {
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadSavedSessions())
  const [playerEmail, setPlayerEmail] = useState<string | null>(null)
  const [selectedClub, setSelectedClub] = useState<string>('')
  const [targetDistance, setTargetDistance] = useState(160)
  const [surface, setSurface] = useState('fairway')
  const [elevationDeltaFt, setElevationDeltaFt] = useState(0)
  const [windMph, setWindMph] = useState(0)
  const [windRelativeDeg, setWindRelativeDeg] = useState(0)
  const [lieUpDownDeg, setLieUpDownDeg] = useState(0)
  const [lieLeftRightDeg, setLieLeftRightDeg] = useState(0)
  const [observations, setObservations] = useState(() => loadWindCalibrationObservations())

  const [calTrajectory, setCalTrajectory] = useState<WindTrajectoryClass>('mid-iron')
  const [calSpeed, setCalSpeed] = useState<(typeof WIND_SPEEDS)[number]>(10)
  const [calDirection, setCalDirection] = useState<WindDirectionCase>('head')
  const [baseCarry, setBaseCarry] = useState('')
  const [baseOffline, setBaseOffline] = useState('0')
  const [windCarry, setWindCarry] = useState('')
  const [windOffline, setWindOffline] = useState('0')
  const [calNote, setCalNote] = useState('')

  useEffect(() => {
    void getCurrentLooperUser()
      .then((user) => setPlayerEmail(user?.email ?? null))
      .catch(() => setPlayerEmail(null))

    const refresh = () => setSessions(loadSavedSessions())
    window.addEventListener(SESSION_HISTORY_UPDATED_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(SESSION_HISTORY_UPDATED_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const profileSet = useMemo(() => buildLiveCaddieProfileSet(sessions), [sessions])

  useEffect(() => {
    if (profileSet.clubs.length === 0) {
      setSelectedClub('')
      return
    }
    if (!selectedClub || !profileSet.clubs.some((profile) => profile.club === selectedClub)) {
      setSelectedClub(profileSet.clubs[0].club)
    }
  }, [profileSet, selectedClub])

  const profile = profileSet.clubs.find((item) => item.club === selectedClub) ?? null
  const support = profileSet.club_support.find((item) => item.club === selectedClub)

  const rawContext: ShotContextInput = {
    targetDistanceYds: targetDistance,
    surface,
    elevationDeltaFt,
    elevationSource: 'Manual review value / LiDAR candidate value in Aim Lab',
    elevationConfidence: 'medium',
    windMph,
    windRelativeDeg,
    lieUpDownDeg,
    lieLeftRightDeg,
    lieSource: 'Manual review value / GSPro lie sensor when connected',
    lieConfidence: 'high',
    mishitEvidenceLabel: 'Player-specific evidence immature',
  }

  const modeled = useMemo(
    () => modelShotContext(
      {
        club: profile?.club ?? null,
        variant: 'Stock',
        stockCarryYds: profile?.stock_carry_yds ?? null,
        carrySigmaYds: profile?.carry_sigma_yds ?? null,
        lateralBiasYds: profile?.lateral_bias_yds ?? null,
        lateralSigmaYds: profile?.lateral_sigma_yds ?? null,
        supportShots: support?.included_stock_shots ?? 0,
      },
      rawContext,
    ),
    [
      profile,
      support,
      targetDistance,
      surface,
      elevationDeltaFt,
      windMph,
      windRelativeDeg,
      lieUpDownDeg,
      lieLeftRightDeg,
    ],
  )

  const matrix = useMemo(() => buildWindCalibrationMatrix(), [])
  const readiness = useMemo(() => windCalibrationReadiness(observations), [observations])
  const observedIds = useMemo(() => new Set(observations.map((item) => item.caseId)), [observations])

  const addObservation = () => {
    const baselineCarry = numberOrNull(baseCarry)
    const baselineOffline = numberOrNull(baseOffline)
    const conditionedCarry = numberOrNull(windCarry)
    const conditionedOffline = numberOrNull(windOffline)
    if (
      baselineCarry == null ||
      baselineOffline == null ||
      conditionedCarry == null ||
      conditionedOffline == null
    ) return

    const next = [
      ...observations,
      createWindCalibrationObservation({
        trajectoryClass: calTrajectory,
        windMph: calSpeed,
        direction: calDirection,
        baselineCarryYds: baselineCarry,
        baselineOfflineYds: baselineOffline,
        conditionedCarryYds: conditionedCarry,
        conditionedOfflineYds: conditionedOffline,
        note: calNote.trim() || undefined,
      }),
    ]
    setObservations(next)
    saveWindCalibrationObservations(next)
    setWindCarry('')
    setWindOffline('0')
    setCalNote('')
  }

  const clearObservations = () => {
    setObservations([])
    saveWindCalibrationObservations([])
  }

  const exportCalibration = () => {
    const payload = JSON.stringify({
      schemaVersion: 'looper-gspro-wind-calibration-v1',
      exportedAt: new Date().toISOString(),
      observations,
    }, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `looper-wind-calibration-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="caddie-inputs-page">
      <header className="inputs-header">
        <div>
          <p className="inputs-eyebrow">LOOPER · CADDIE MODEL CONTRACT V1</p>
          <h1>Caddie Inputs / Model Inspector</h1>
          <p>The canonical audit page for what Looper knows, how it transforms it, and what is actually allowed to influence a recommendation.</p>
        </div>
        <div className="inputs-player">
          <strong>{playerEmail ?? 'Signed-in player'}</strong>
          <span>{profileSet.session_count} sessions · {profileSet.shot_count} profile shots</span>
        </div>
      </header>

      <section className="inputs-grid top-grid">
        <article className="inputs-card">
          <div className="inputs-card-heading">
            <div><span>PLAYER BASELINE</span><h2>Choose the Stock profile</h2></div>
          </div>
          <label className="field-label">Club
            <select value={selectedClub} onChange={(event) => setSelectedClub(event.target.value)}>
              {profileSet.clubs.map((item) => <option key={item.club} value={item.club}>{item.club}</option>)}
            </select>
          </label>
          <div className="metric-grid">
            <div><span>Stock carry</span><strong>{profile ? `${profile.stock_carry_yds.toFixed(1)} yd` : '—'}</strong></div>
            <div><span>Carry σ</span><strong>{profile?.carry_sigma_yds?.toFixed(1) ?? '—'} yd</strong></div>
            <div><span>Lateral bias</span><strong>{profile?.lateral_bias_yds?.toFixed(1) ?? '—'} yd</strong></div>
            <div><span>Lateral σ</span><strong>{profile?.lateral_sigma_yds?.toFixed(1) ?? '—'} yd</strong></div>
            <div><span>Support</span><strong>{support?.included_stock_shots ?? 0} shots</strong></div>
            <div><span>Variant</span><strong>Stock</strong></div>
          </div>
        </article>

        <article className="inputs-card">
          <div className="inputs-card-heading">
            <div><span>CURRENT SHOT CONTEXT</span><h2>Review / simulate inputs</h2></div>
          </div>
          <div className="input-form-grid">
            <label>Target yd<input type="number" value={targetDistance} onChange={(e) => setTargetDistance(Number(e.target.value))} /></label>
            <label>Surface<select value={surface} onChange={(e) => setSurface(e.target.value)}><option>tee</option><option>fairway</option><option>rough</option><option>deep-rough</option><option>bunker</option></select></label>
            <label>Elevation Δ ft<input type="number" step="0.1" value={elevationDeltaFt} onChange={(e) => setElevationDeltaFt(Number(e.target.value))} /></label>
            <label>Wind mph<input type="number" step="0.1" value={windMph} onChange={(e) => setWindMph(Number(e.target.value))} /></label>
            <label>Wind relative °<input type="number" value={windRelativeDeg} onChange={(e) => setWindRelativeDeg(Number(e.target.value))} /></label>
            <label>Lie up/down °<input type="number" step="0.1" value={lieUpDownDeg} onChange={(e) => setLieUpDownDeg(Number(e.target.value))} /></label>
            <label>Lie left/right °<input type="number" step="0.1" value={lieLeftRightDeg} onChange={(e) => setLieLeftRightDeg(Number(e.target.value))} /></label>
          </div>
          <p className="inputs-note">Manual values are a review harness. Live sensors can replace the source later without changing the model contract.</p>
        </article>
      </section>

      <section className="inputs-card">
        <div className="inputs-card-heading">
          <div><span>TRANSFORMATION SUMMARY</span><h2>What currently reaches the optimizer</h2></div>
        </div>
        <div className="transform-strip">
          <div><span>Raw target</span><strong>{targetDistance.toFixed(1)} yd</strong></div>
          <div><span>Effective target</span><strong>{modeled.effectiveTargetDistanceYds?.toFixed(1) ?? '—'} yd</strong></div>
          <div><span>Baseline carry</span><strong>{profile?.stock_carry_yds.toFixed(1) ?? '—'} yd</strong></div>
          <div><span>Modeled carry</span><strong>{modeled.modeledCarryYds?.toFixed(1) ?? '—'} yd</strong></div>
          <div><span>Modeled lateral bias</span><strong>{modeled.modeledLateralBiasYds?.toFixed(1) ?? '—'} yd</strong></div>
        </div>
        <p className="inputs-callout">If an uncalibrated factor is entered above, these modeled numbers should NOT secretly change. Its row below must explain why.</p>
      </section>

      <section className="inputs-card">
        <div className="inputs-card-heading">
          <div><span>CANONICAL FACTOR TABLE</span><h2>Raw → source → transformation → modeled value</h2></div>
          <small>{modeled.contract.schemaVersion}</small>
        </div>
        <div className="inputs-table-wrap">
          <table className="inputs-table factor-contract-table">
            <thead><tr><th>Factor</th><th>Raw input</th><th>Source / confidence</th><th>Transformation</th><th>Modeled value</th><th>Affects</th><th>Version</th><th>Status</th></tr></thead>
            <tbody>
              {modeled.contract.factors.map((factor) => (
                <tr key={factor.id}>
                  <td><strong>{factor.label}</strong><small>{factor.evidenceBasis}</small></td>
                  <td>{factor.rawDisplay}</td>
                  <td>{factor.source}<small>{factor.sourceConfidence} confidence</small></td>
                  <td className="wrap-cell">{factor.transformation}</td>
                  <td className="wrap-cell">{factor.modeledDisplay}</td>
                  <td className="wrap-cell">{effectLabel(factor)}</td>
                  <td><code>{factor.modelVersion}</code></td>
                  <td><b className={`model-status status-${factor.status}`}>{statusLabel[factor.status]}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="inputs-card wind-section">
        <div className="inputs-card-heading">
          <div><span>WIND CALIBRATION</span><h2>GSPro-specific controlled response model</h2></div>
          <div className={`readiness readiness-${readiness.status}`}><strong>{readiness.observedCases}/{readiness.totalCases}</strong><span>{pct(readiness.coverage)} matrix coverage</span></div>
        </div>
        <p className="inputs-note strong-note">Calibration pairs must use the same launch conditions in GSPro. Normal human swings are not valid paired calibration evidence; this harness records controlled simulator observations.</p>

        <div className="wind-cal-grid">
          <div className="cal-form">
            <h3>Add controlled observation</h3>
            <div className="input-form-grid compact">
              <label>Trajectory<select value={calTrajectory} onChange={(e) => setCalTrajectory(e.target.value as WindTrajectoryClass)}>{WIND_TRAJECTORY_CLASSES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              <label>Wind speed<select value={calSpeed} onChange={(e) => setCalSpeed(Number(e.target.value) as (typeof WIND_SPEEDS)[number])}>{WIND_SPEEDS.map((item) => <option key={item} value={item}>{item} mph</option>)}</select></label>
              <label>Direction<select value={calDirection} onChange={(e) => setCalDirection(e.target.value as WindDirectionCase)}>{WIND_DIRECTIONS.map((item) => <option key={item} value={item}>{windDirectionLabel(item)}</option>)}</select></label>
              <label>0-wind carry<input value={baseCarry} onChange={(e) => setBaseCarry(e.target.value)} inputMode="decimal" /></label>
              <label>0-wind offline<input value={baseOffline} onChange={(e) => setBaseOffline(e.target.value)} inputMode="decimal" /></label>
              <label>Wind carry<input value={windCarry} onChange={(e) => setWindCarry(e.target.value)} inputMode="decimal" /></label>
              <label>Wind offline<input value={windOffline} onChange={(e) => setWindOffline(e.target.value)} inputMode="decimal" /></label>
              <label className="wide-field">Note<input value={calNote} onChange={(e) => setCalNote(e.target.value)} placeholder="same launch packet / replay id / anything notable" /></label>
            </div>
            <div className="button-row">
              <button type="button" onClick={addObservation}>Add observation</button>
              <button type="button" className="secondary" onClick={exportCalibration} disabled={observations.length === 0}>Export JSON</button>
              <button type="button" className="danger" onClick={clearObservations} disabled={observations.length === 0}>Clear local data</button>
            </div>
          </div>

          <div className="cal-summary">
            <h3>Evidence policy</h3>
            <div className="policy-list">
              <div><span>Physics / structure</span><strong>Trajectory class + wind vector</strong></div>
              <div><span>GSPro calibration</span><strong>Carry Δ + lateral Δ from identical launch</strong></div>
              <div><span>Player history</span><strong>Not used to fit V1 wind coefficients</strong></div>
              <div><span>Recommendation impact</span><strong>Blocked until calibration model is promoted</strong></div>
            </div>
          </div>
        </div>

        <div className="inputs-table-wrap matrix-wrap">
          <table className="inputs-table matrix-table">
            <thead><tr><th>Trajectory</th>{WIND_SPEEDS.flatMap((speed) => WIND_DIRECTIONS.map((direction) => <th key={`${speed}-${direction}`}>{speed} · {direction.replaceAll('-', ' ')}</th>))}</tr></thead>
            <tbody>
              {WIND_TRAJECTORY_CLASSES.map((trajectory) => (
                <tr key={trajectory}>
                  <td><strong>{trajectory}</strong></td>
                  {WIND_SPEEDS.flatMap((speed) => WIND_DIRECTIONS.map((direction) => {
                    const id = `${trajectory}-${speed}-${direction}`
                    return <td key={id}><span className={observedIds.has(id) ? 'matrix-cell observed' : 'matrix-cell'}>{observedIds.has(id) ? '✓' : '·'}</span></td>
                  }))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {observations.length > 0 && (
          <div className="recent-observations">
            <h3>Recent observations</h3>
            {observations.slice(-8).reverse().map((item) => (
              <div key={item.id} className="observation-row">
                <strong>{item.trajectoryClass} · {item.windMph} mph · {windDirectionLabel(item.direction)}</strong>
                <span>carry Δ {item.carryDeltaYds >= 0 ? '+' : ''}{item.carryDeltaYds.toFixed(1)} yd</span>
                <span>lateral Δ {item.lateralDeltaYds >= 0 ? '+' : ''}{item.lateralDeltaYds.toFixed(1)} yd</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="inputs-card provenance-card">
        <div className="inputs-card-heading"><div><span>RESEARCH EVIDENCE</span><h2>What prior Greywolf work actually establishes</h2></div></div>
        <div className="research-grid">
          <div><strong>GSPro lie angle</strong><p>Direct up/down and left/right values were captured across Greywolf. Measurement exists; flight-response coefficients do not.</p><b className="model-status status-modeled">MEASUREMENT PROVEN</b></div>
          <div><strong>LiDAR terrain</strong><p>Real-world elevation and local terrain planes exist. Prior proof explicitly notes GSPro may resculpt terrain, so source and confidence remain visible.</p><b className="model-status status-review">SOURCE-AWARE</b></div>
          <div><strong>Wind response</strong><p>No validated coefficient set has been promoted. The 120-cell controlled matrix above is the path to a GSPro-specific V1.</p><b className="model-status status-calibrating">CALIBRATING</b></div>
        </div>
      </section>

      <footer className="inputs-footer">This page is the canonical model audit surface. New caddie factors should register here before they are allowed to influence recommendations.</footer>
    </main>
  )
}

export default CaddieInputsPage
