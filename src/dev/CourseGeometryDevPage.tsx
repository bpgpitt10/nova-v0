import { useEffect, useMemo, useState } from 'react'
import { getCurrentLooperUser } from '../cloud/supabaseClient'
import { greywolfHole01Geometry as hole } from '../courseGeometry/greywolfHole01'
import {
  greywolfHole01Regression,
  greywolfHole01RegressionPasses,
} from '../courseGeometry/greywolfHole01Regression'
import { TACTICAL_SURFACE_SEMANTICS } from '../courseGeometry/semantics'
import type { CourseSurfaceKind } from '../courseGeometry/types'
import {
  evaluatePlayerStockClubsOnHole,
  type ClubGeometryOutcome,
} from '../liveCaddie/playerGeometryOutcomes'
import {
  loadSavedSessions,
  SESSION_HISTORY_UPDATED_EVENT,
} from '../lib/sessions'
import type { SavedSession } from '../types'
import './courseGeometryDev.css'

const percent = (value: number) => `${Math.round(value * 100)}%`
const maybePercent = (value: number | null | undefined) =>
  typeof value === 'number' ? percent(value) : '—'
const yards = (value: number | null) => (value == null ? '—' : `${value.toFixed(1)} yd`)
const signedYards = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)} yd`

const surfaceOrder: readonly CourseSurfaceKind[] = [
  'tee',
  'fairway',
  'rough',
  'deep-rough',
  'green',
  'bunker',
  'water',
  'penalty',
]

const mishitEvidenceLabel = (outcome: ClubGeometryOutcome) => {
  const evidence = outcome.mishitEvidence
  if (evidence.observedMishitRate == null) {
    return `${evidence.evidence} · no rate yet`
  }
  return `${evidence.evidence} · ${percent(evidence.observedMishitRate)} observed`
}

function CourseGeometryDevPage() {
  const validation = greywolfHole01Regression.geometryValidation
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadSavedSessions())
  const [playerEmail, setPlayerEmail] = useState<string | null>(null)
  const [playerError, setPlayerError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    void getCurrentLooperUser()
      .then((user) => {
        if (!active) return
        setPlayerEmail(user?.email ?? null)
      })
      .catch((error) => {
        if (!active) return
        setPlayerError(error instanceof Error ? error.message : String(error))
      })

    const refresh = () => setSessions(loadSavedSessions())
    window.addEventListener(SESSION_HISTORY_UPDATED_EVENT, refresh)
    window.addEventListener('storage', refresh)

    return () => {
      active = false
      window.removeEventListener(SESSION_HISTORY_UPDATED_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const playerOutcomes = useMemo(
    () => evaluatePlayerStockClubsOnHole(sessions, hole),
    [sessions],
  )

  return (
    <main className="geometry-lab">
      <header className="geometry-lab-header">
        <div>
          <p className="geometry-lab-eyebrow">LOOPER · TACTICAL GEOMETRY V0</p>
          <h1>{hole.courseName} · Hole {hole.holeNumber}</h1>
          <p>
            Offline course-intelligence lab. No GSPro input is required on this page.
          </p>
        </div>
        <span className={greywolfHole01RegressionPasses ? 'geometry-status good' : 'geometry-status bad'}>
          {greywolfHole01RegressionPasses ? 'REGRESSION PASS' : 'CHECK REQUIRED'}
        </span>
      </header>

      <section className="geometry-summary-grid">
        <article className="geometry-card">
          <span>SCHEMA</span>
          <strong>{hole.schemaVersion}</strong>
          <small>{validation.surfaceCount} surfaces · {validation.polygonCount} polygons</small>
        </article>
        <article className="geometry-card">
          <span>REGISTRATION</span>
          <strong>{hole.registration.status}</strong>
          <small>
            {hole.registration.validation?.exactSurfaceMatches}/{hole.registration.validation?.testedEndpoints} exact surface matches
          </small>
        </article>
        <article className="geometry-card">
          <span>PLAYER DATA</span>
          <strong>{playerEmail ?? (playerError ? 'Unavailable' : 'Signed-in player')}</strong>
          <small>{sessions.length} hydrated sessions · {sessions.reduce((sum, session) => sum + session.shots.length, 0)} raw shots</small>
        </article>
      </section>

      <section className="geometry-panel player-geometry-panel">
        <div className="geometry-panel-heading">
          <div>
            <span>PLAYER × COURSE</span>
            <h2>Stock club outcomes from the selected tee</h2>
          </div>
          <p>
            Planning = Looper Stock distribution after mishit filtering. Empirical = all source-included Stock shots,
            including ugly outcomes when they exist. Risk envelope uses the more conservative supported view.
          </p>
        </div>

        {playerOutcomes.length === 0 ? (
          <div className="geometry-empty-state">
            No hydrated player profiles yet. Sign in and let cloud history hydrate, then this table fills automatically.
          </div>
        ) : (
          <div className="geometry-table-wrap">
            <table className="geometry-table player-outcome-table">
              <thead>
                <tr>
                  <th>Club</th>
                  <th>Stock</th>
                  <th>Carry σ</th>
                  <th>Lateral</th>
                  <th>Support</th>
                  <th>Aim @ carry</th>
                  <th>Planning preferred</th>
                  <th>Planning trouble</th>
                  <th>Planning penalty</th>
                  <th>All-shot preferred</th>
                  <th>All-shot trouble</th>
                  <th>All-shot penalty</th>
                  <th>Risk envelope</th>
                  <th>Mishit evidence</th>
                </tr>
              </thead>
              <tbody>
                {playerOutcomes.map((outcome) => {
                  const empiricalSupported = outcome.empiricalShotCount >= 5
                  return (
                    <tr key={outcome.club}>
                      <td><strong>{outcome.club}</strong></td>
                      <td>{outcome.stockCarryYds.toFixed(1)} yd</td>
                      <td>{yards(outcome.carrySigmaYds)}</td>
                      <td>
                        {signedYards(outcome.lateralBiasYds)} bias · {yards(outcome.lateralSigmaYds)} σ
                      </td>
                      <td>{outcome.profileSupportShots} shots · {outcome.profileSupportingSessions} sess.</td>
                      <td>{signedYards(outcome.aimRightYdsAtStockCarry)}</td>
                      <td>{maybePercent(outcome.planningModel?.preferred)}</td>
                      <td>{maybePercent(outcome.planningModel?.trouble)}</td>
                      <td>{maybePercent(outcome.planningModel?.penalty)}</td>
                      <td className={!empiricalSupported ? 'thin-data' : ''}>
                        {maybePercent(outcome.empiricalAllShots?.preferred)} ({outcome.empiricalShotCount})
                      </td>
                      <td className={!empiricalSupported ? 'thin-data' : ''}>
                        {maybePercent(outcome.empiricalAllShots?.trouble)}
                      </td>
                      <td className={!empiricalSupported ? 'thin-data' : ''}>
                        {maybePercent(outcome.empiricalAllShots?.penalty)}
                      </td>
                      <td>
                        <strong>{maybePercent(outcome.riskEnvelope.preferredFloor)} floor</strong>
                        <small>
                          {maybePercent(outcome.riskEnvelope.troubleCeiling)} trouble · {maybePercent(outcome.riskEnvelope.penaltyCeiling)} penalty
                        </small>
                      </td>
                      <td>
                        <span className={`mishit-evidence ${outcome.mishitEvidence.evidence}`}>
                          {mishitEvidenceLabel(outcome)}
                        </span>
                        <small>{outcome.mishitEvidence.baselineStatus} baseline</small>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="geometry-note player-model-note">
          This is deliberately not claiming mature total-shot probabilities yet. The normal-shot model is useful now;
          empirical all-shot history acts as a guardrail, and mishit confidence can improve as new classified reps arrive.
        </p>
      </section>

      <section className="geometry-panel">
        <div className="geometry-panel-heading">
          <div>
            <span>TACTICAL CROSS-SECTIONS</span>
            <h2>What is around a landing area?</h2>
          </div>
          <p>Geometry-only footprint = 15 yd lateral × 15 yd longitudinal. It is coverage, not shot probability.</p>
        </div>

        <div className="geometry-table-wrap">
          <table className="geometry-table">
            <thead>
              <tr>
                <th>Forward</th>
                <th>Fairway width</th>
                <th>Fairway center</th>
                <th>Landing depth</th>
                <th>Nearest trouble</th>
                <th>Penalty</th>
                <th>Bunker</th>
                <th>Safe side</th>
                <th>Preferred footprint</th>
                <th>Trouble footprint</th>
              </tr>
            </thead>
            <tbody>
              {greywolfHole01Regression.stations.map((station) => (
                <tr key={station.forwardYds}>
                  <td><strong>{station.forwardYds} yd</strong></td>
                  <td>{yards(station.fairwayCorridor?.widthYds ?? null)}</td>
                  <td>
                    {station.fairwayCorridor
                      ? `${station.fairwayCorridor.centerRightYds >= 0 ? '+' : ''}${station.fairwayCorridor.centerRightYds.toFixed(1)} yd R`
                      : '—'}
                  </td>
                  <td>{yards(station.landingDepthYds)}</td>
                  <td>{yards(station.nearestTroubleYds)}</td>
                  <td>{yards(station.nearestPenaltyYds)}</td>
                  <td>{yards(station.nearestBunkerYds)}</td>
                  <td className="geometry-safe-side">{station.safeSide}</td>
                  <td>{percent(station.landingCoverage.preferredCoverage)}</td>
                  <td>{percent(station.landingCoverage.troubleCoverage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="geometry-two-column">
        <article className="geometry-panel">
          <div className="geometry-panel-heading compact">
            <div>
              <span>KNOWN SHOTS</span>
              <h2>Regression checks</h2>
            </div>
          </div>
          <div className="geometry-check-list">
            {greywolfHole01Regression.shotSurfaceChecks.map((check) => (
              <div className="geometry-check-row" key={check.label}>
                <span className={check.pass ? 'geometry-check-dot good' : 'geometry-check-dot bad'} />
                <div>
                  <strong>{check.label}</strong>
                  <small>
                    Expected {check.expected} · classified {check.actual} · {check.confidence} confidence
                  </small>
                </div>
              </div>
            ))}
            {validation.issues.map((issue) => (
              <div className="geometry-check-row" key={issue}>
                <span className="geometry-check-dot bad" />
                <div><strong>{issue}</strong></div>
              </div>
            ))}
          </div>
        </article>

        <article className="geometry-panel">
          <div className="geometry-panel-heading compact">
            <div>
              <span>SURFACE CONTRACT</span>
              <h2>What Looper knows</h2>
            </div>
          </div>
          <div className="geometry-surface-list">
            {surfaceOrder.map((kind) => {
              const semantics = TACTICAL_SURFACE_SEMANTICS[kind]
              return (
                <div className="geometry-surface-row" key={kind}>
                  <div>
                    <strong>{semantics.label}</strong>
                    <small>severity {semantics.severity}/5</small>
                  </div>
                  <span className={`availability ${hole.availability[kind]}`}>{hole.availability[kind]}</span>
                </div>
              )
            })}
          </div>
          <p className="geometry-note">
            OSM <code>golf=rough</code> remains regular rough. Woods / forest / scrub are a separate
            <strong> deep-rough</strong> tactical class and stay unavailable until that geometry is present.
          </p>
        </article>
      </section>

      <footer className="geometry-footer">
        <span>{hole.provenance.attribution}</span>
        <span>{hole.provenance.license}</span>
        <span>Course package provenance retained</span>
      </footer>
    </main>
  )
}

export default CourseGeometryDevPage
