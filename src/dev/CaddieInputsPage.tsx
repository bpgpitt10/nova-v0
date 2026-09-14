import { useEffect, useMemo, useState } from 'react'
import { getCurrentLooperUser } from '../cloud/supabaseClient'
import { buildLiveCaddieProfileSet } from '../liveCaddie/profileProvider'
import { modelShotContext } from '../liveCaddie/shotContextModel'
import type { CaddieModelFactor, CaddieModelStatus } from '../liveCaddie/modelContract'
import {
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
import { loadSavedSessions, SESSION_HISTORY_UPDATED_EVENT } from '../lib/sessions'
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
const parseNumber = (value: string) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const effectLabel = (factor: CaddieModelFactor) => factor.affects.join(' · ') || '—'

function CaddieInputsPage() {
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadSavedSessions())
  const [playerEmail, setPlayerEmail] = useState<string | null>(null)
  const [club, setClub] = useState('')
  const [targetDistance, setTargetDistance] = useState(160)
  const [surface, setSurface] = useState('fairway')
  const [elevationDeltaFt, setElevationDeltaFt] = useState(0)
  const [windMph, setWindMph] = useState(0)
  const [windRelativeDeg, setWindRelativeDeg] = useState(0)
  const [lieUpDownDeg, setLieUpDownDeg] = useState(0)
  const [lieLeftRightDeg, setLieLeftRightDeg] = useState(0)
  const [observations, setObservations] = useState(() => loadWindCalibrationObservations())
  const [trajectory, setTrajectory] = useState<WindTrajectoryClass>('mid-iron')
  const [speed, setSpeed] = useState<(typeof WIND_SPEEDS)[number]>(10)
  const [direction, setDirection] = useState<WindDirectionCase>('head')
  const [baselineCarry, setBaselineCarry] = useState('')
  const [baselineOffline, setBaselineOffline] = useState('0')
  const [conditionedCarry, setConditionedCarry] = useState('')
  const [conditionedOffline, setConditionedOffline] = useState('0')

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

  const profileSet = useMemo(() => buildLiveCaddieProfileSet(sessions), [sessions])
  useEffect(() => {
    if (profileSet.clubs.length === 0) return
    if (!club || !profileSet.clubs.some((item) => item.club === club)) setClub(profileSet.clubs[0].club)
  }, [profileSet, club])

  const profile = profileSet.clubs.find((item) => item.club === club) ?? null
  const support = profileSet.club_support.find((item) => item.club === club)
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
      {
        targetDistanceYds: targetDistance,
        surface,
        elevationDeltaFt,
        elevationSource: 'Manual review value / LiDAR candidate value in Aim Lab',
        elevationConfidence: 'medium',
        windMph,
        windRelativeDeg,
        lieUpDownDeg,
        lieLeftRightDeg,
        lieSource: 'Manual review value / GSPro direct lie measurement when connected',
        lieConfidence: 'high',
        mishitEvidenceLabel: 'Player-specific evidence immature',
      },
    ),
    [profile, support, targetDistance, surface, elevationDeltaFt, windMph, windRelativeDeg, lieUpDownDeg, lieLeftRightDeg],
  )

  const readiness = useMemo(() => windCalibrationReadiness(observations), [observations])
  const observedIds = useMemo(() => new Set(observations.map((item) => item.caseId)), [observations])

  const addObservation = () => {
    const baseCarry = parseNumber(baselineCarry)
    const baseOffline = parseNumber(baselineOffline)
    const windCarry = parseNumber(conditionedCarry)
    const windOffline = parseNumber(conditionedOffline)
    if (baseCarry == null || baseOffline == null || windCarry == null || windOffline == null) return
    const next = [...observations, createWindCalibrationObservation({
      trajectoryClass: trajectory,
      windMph: speed,
      direction,
      baselineCarryYds: baseCarry,
      baselineOfflineYds: baseOffline,
      conditionedCarryYds: windCarry,
      conditionedOfflineYds: windOffline,
    })]
    setObservations(next)
    saveWindCalibrationObservations(next)
    setConditionedCarry('')
    setConditionedOffline('0')
  }

  const exportCalibration = () => {
    const blob = new Blob([JSON.stringify({ schemaVersion: 'looper-gspro-wind-calibration-v1', exportedAt: new Date().toISOString(), observations }, null, 2)], { type: 'application/json' })
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
        <div><p className="inputs-eyebrow">LOOPER · CADDIE MODEL CONTRACT V1</p><h1>Caddie Inputs / Model Inspector</h1><p>The canonical audit page for what Looper knows, how it transforms it, and what is actually allowed to influence a recommendation.</p></div>
        <div className="inputs-player"><strong>{playerEmail ?? 'Signed-in player'}</strong><span>{profileSet.session_count} sessions · {profileSet.shot_count} profile shots</span></div>
      </header>

      <section className="inputs-grid top-grid">
        <article className="inputs-card">
          <div className="inputs-card-heading"><div><span>PLAYER BASELINE</span><h2>Choose the Stock profile</h2></div></div>
          <label className="field-label">Club<select value={club} onChange={(event) => setClub(event.target.value)}>{profileSet.clubs.map((item) => <option key={item.club}>{item.club}</option>)}</select></label>
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
          <div className="inputs-card-heading"><div><span>CURRENT SHOT CONTEXT</span><h2>Review / simulate inputs</h2></div></div>
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
        <div className="inputs-card-heading"><div><span>TRANSFORMATION SUMMARY</span><h2>What currently reaches the optimizer</h2></div></div>
        <div className="transform-strip">
          <div><span>Raw target</span><strong>{targetDistance.toFixed(1)} yd</strong></div>
          <div><span>Effective target</span><strong>{modeled.effectiveTargetDistanceYds?.toFixed(1) ?? '—'} yd</strong></div>
          <div><span>Baseline carry</span><strong>{profile?.stock_carry_yds.toFixed(1) ?? '—'} yd</strong></div>
          <div><span>Modeled carry</span><strong>{modeled.modeledCarryYds?.toFixed(1) ?? '—'} yd</strong></div>
          <div><span>Modeled lateral bias</span><strong>{modeled.modeledLateralBiasYds?.toFixed(1) ?? '—'} yd</strong></div>
        </div>
        <p className="inputs-callout">Uncalibrated inputs do not secretly change these numbers. Their factor row below must say exactly why.</p>
      </section>

      <section className="inputs-card">
        <div className="inputs-card-heading"><div><span>CANONICAL FACTOR TABLE</span><h2>Raw → source → transformation → modeled value</h2></div><small>{modeled.contract.schemaVersion}</small></div>
        <div className="inputs-table-wrap"><table className="inputs-table factor-contract-table"><thead><tr><th>Factor</th><th>Raw input</th><th>Source / confidence</th><th>Transformation</th><th>Modeled value</th><th>Affects</th><th>Version</th><th>Status</th></tr></thead><tbody>
          {modeled.contract.factors.map((factor) => <tr key={factor.id}><td><strong>{factor.label}</strong><small>{factor.evidenceBasis}</small></td><td>{factor.rawDisplay}</td><td>{factor.source}<small>{factor.sourceConfidence} confidence</small></td><td className="wrap-cell">{factor.transformation}</td><td className="wrap-cell">{factor.modeledDisplay}</td><td className="wrap-cell">{effectLabel(factor)}</td><td><code>{factor.modelVersion}</code></td><td><b className={`model-status status-${factor.status}`}>{statusLabel[factor.status]}</b></td></tr>)}
        </tbody></table></div>
      </section>

      <section className="inputs-card wind-section">
        <div className="inputs-card-heading"><div><span>WIND CALIBRATION</span><h2>GSPro-specific controlled response model</h2></div><div className={`readiness readiness-${readiness.status}`}><strong>{readiness.observedCases}/{readiness.totalCases}</strong><span>{pct(readiness.coverage)} coverage</span></div></div>
        <p className="inputs-note strong-note">Calibration pairs must use identical launch conditions in GSPro. Normal human swing pairs are not valid calibration evidence.</p>
        <div className="wind-cal-grid">
          <div className="cal-form"><h3>Add controlled observation</h3><div className="input-form-grid compact">
            <label>Trajectory<select value={trajectory} onChange={(e) => setTrajectory(e.target.value as WindTrajectoryClass)}>{WIND_TRAJECTORY_CLASSES.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>Wind speed<select value={speed} onChange={(e) => setSpeed(Number(e.target.value) as (typeof WIND_SPEEDS)[number])}>{WIND_SPEEDS.map((item) => <option key={item} value={item}>{item} mph</option>)}</select></label>
            <label>Direction<select value={direction} onChange={(e) => setDirection(e.target.value as WindDirectionCase)}>{WIND_DIRECTIONS.map((item) => <option key={item} value={item}>{windDirectionLabel(item)}</option>)}</select></label>
            <label>0-wind carry<input value={baselineCarry} onChange={(e) => setBaselineCarry(e.target.value)} /></label>
            <label>0-wind offline<input value={baselineOffline} onChange={(e) => setBaselineOffline(e.target.value)} /></label>
            <label>Wind carry<input value={conditionedCarry} onChange={(e) => setConditionedCarry(e.target.value)} /></label>
            <label>Wind offline<input value={conditionedOffline} onChange={(e) => setConditionedOffline(e.target.value)} /></label>
          </div><div className="button-row"><button type="button" onClick={addObservation}>Add observation</button><button type="button" className="secondary" onClick={exportCalibration} disabled={observations.length === 0}>Export JSON</button><button type="button" className="danger" onClick={() => { setObservations([]); saveWindCalibrationObservations([]) }} disabled={observations.length === 0}>Clear</button></div></div>
          <div className="cal-summary"><h3>Evidence policy</h3><div className="policy-list"><div><span>Structure</span><strong>Trajectory + wind vector</strong></div><div><span>Calibration</span><strong>Carry Δ + lateral Δ</strong></div><div><span>Player history</span><strong>Not used for V1 coefficients</strong></div><div><span>Recommendation impact</span><strong>Blocked until promoted</strong></div></div></div>
        </div>
        <div className="inputs-table-wrap matrix-wrap"><table className="inputs-table matrix-table"><thead><tr><th>Trajectory</th>{WIND_SPEEDS.flatMap((windSpeed) => WIND_DIRECTIONS.map((windDirection) => <th key={`${windSpeed}-${windDirection}`}>{windSpeed} · {windDirection.replaceAll('-', ' ')}</th>))}</tr></thead><tbody>{WIND_TRAJECTORY_CLASSES.map((trajectoryClass) => <tr key={trajectoryClass}><td><strong>{trajectoryClass}</strong></td>{WIND_SPEEDS.flatMap((windSpeed) => WIND_DIRECTIONS.map((windDirection) => { const id = `${trajectoryClass}-${windSpeed}-${windDirection}`; return <td key={id}><span className={observedIds.has(id) ? 'matrix-cell observed' : 'matrix-cell'}>{observedIds.has(id) ? '✓' : '·'}</span></td> }))}</tr>)}</tbody></table></div>
      </section>

      <section className="inputs-card provenance-card"><div className="inputs-card-heading"><div><span>RESEARCH EVIDENCE</span><h2>What prior Greywolf work actually establishes</h2></div></div><div className="research-grid"><div><strong>GSPro lie angle</strong><p>Direct up/down and left/right values were captured. Measurement exists; numerical flight-response coefficients do not.</p><b className="model-status status-modeled">MEASUREMENT PROVEN</b></div><div><strong>LiDAR terrain</strong><p>Real-world elevation and local terrain planes exist. GSPro can resculpt terrain, so provenance stays visible.</p><b className="model-status status-review">SOURCE-AWARE</b></div><div><strong>Wind response</strong><p>No coefficient set is promoted. The controlled matrix is the path to a GSPro-specific V1.</p><b className="model-status status-calibrating">CALIBRATING</b></div></div></section>

      <footer className="inputs-footer">New caddie factors should register on this audit surface before they are allowed to influence recommendations.</footer>
    </main>
  )
}

export default CaddieInputsPage
