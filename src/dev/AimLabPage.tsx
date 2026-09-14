import { useEffect, useMemo, useState } from 'react'
import { getCurrentLooperUser } from '../cloud/supabaseClient'
import { classifyPoint, fairwayCorridorAtForwardY } from '../courseGeometry/geometry'
import { loadGreywolfHoleGeometry } from '../courseGeometry/greywolfCourseLoader'
import { estimateGreywolfHole01Terrain } from '../courseGeometry/lidar'
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

const pct = (value: number | null | undefined) =>
  typeof value === 'number' ? `${Math.round(value * 100)}%` : '—'

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

const defaultTarget = (hole: CourseHoleGeometry): CoursePointYds => {
  const pin = hole.markers.pin
  if (!pin) return [0, Math.min(220, hole.bounds.maxY)]
  const pinDistance = Math.hypot(pin[0], pin[1])
  if (pinDistance <= 260) return pin

  const landingY = Math.min(220, pinDistance * 0.65)
  const corridor = fairwayCorridorAtForwardY(hole, landingY)
  return [corridor?.centerRightYds ?? 0, landingY]
}

const pointDistance = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(b[0] - a[0], b[1] - a[1])

function AimMap({
  hole,
  ball,
  target,
  selected,
  editMode,
  onSetPoint,
}: {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  selected: ClubAimEvaluation | null
  editMode: 'ball' | 'target'
  onSetPoint: (point: CoursePointYds) => void
}) {
  const spanX = Math.max(1, hole.bounds.maxX - hole.bounds.minX)
  const spanY = Math.max(1, hole.bounds.maxY - hole.bounds.minY)
  const project = (point: CoursePointYds): [number, number] => [
    ((point[0] - hole.bounds.minX) / spanX) * 100,
    ((hole.bounds.maxY - point[1]) / spanY) * 100,
  ]
  const unproject = (x: number, y: number): CoursePointYds => [
    hole.bounds.minX + (x / 100) * spanX,
    hole.bounds.maxY - (y / 100) * spanY,
  ]

  const ballSvg = project(ball)
  const targetSvg = project(target)
  const best = selected?.bestCandidate ?? null
  const aimSvg = best ? project(best.aimPoint) : null
  const meanSvg = best ? project(best.meanLanding) : null

  const onClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * 100
    const y = ((event.clientY - rect.top) / rect.height) * 100
    onSetPoint(unproject(x, y))
  }

  const lateralSigma = selected?.lateralSigmaYds ?? 0
  const carrySigma = selected?.carrySigmaYds ?? 0
  const ellipseRx = Math.max(0.5, (2 * lateralSigma / spanX) * 100)
  const ellipseRy = Math.max(0.5, (2 * carrySigma / spanY) * 100)
  const shotDx = (aimSvg?.[0] ?? targetSvg[0]) - ballSvg[0]
  const shotDy = (aimSvg?.[1] ?? targetSvg[1]) - ballSvg[1]
  const shotAngle = (Math.atan2(shotDy, shotDx) * 180) / Math.PI + 90

  return (
    <div className="aim-map-shell">
      <svg className={`aim-map edit-${editMode}`} viewBox="0 0 100 100" onClick={onClick}>
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
        <line className="aim-line" x1={ballSvg[0]} y1={ballSvg[1]} x2={targetSvg[0]} y2={targetSvg[1]} />
        {best && aimSvg && meanSvg && (
          <>
            <line className="aim-line candidate" x1={ballSvg[0]} y1={ballSvg[1]} x2={aimSvg[0]} y2={aimSvg[1]} />
            <ellipse
              className="dispersion-ellipse"
              cx={meanSvg[0]}
              cy={meanSvg[1]}
              rx={ellipseRx}
              ry={ellipseRy}
              transform={`rotate(${shotAngle} ${meanSvg[0]} ${meanSvg[1]})`}
            />
            <circle className="mean-marker" cx={meanSvg[0]} cy={meanSvg[1]} r="1.1" />
            <circle className="aim-marker" cx={aimSvg[0]} cy={aimSvg[1]} r="0.9" />
          </>
        )}
        <circle className="target-marker" cx={targetSvg[0]} cy={targetSvg[1]} r="1.2" />
        <circle className="ball-marker" cx={ballSvg[0]} cy={ballSvg[1]} r="1.25" />
      </svg>
      <div className="aim-map-legend">
        <span><i className="legend-dot ball" /> Ball</span>
        <span><i className="legend-dot target" /> Landing target</span>
        <span><i className="legend-dot aim" /> Aim point</span>
        <span><i className="legend-dot mean" /> Expected center</span>
      </div>
    </div>
  )
}

function AimLabPage() {
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadSavedSessions())
  const [playerEmail, setPlayerEmail] = useState<string | null>(null)
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
    let active = true
    setLoadError(null)
    setHole(null)
    void loadGreywolfHoleGeometry(holeNumber)
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
  }, [holeNumber])

  const evaluations = useMemo(
    () => (hole ? evaluateAimLab(sessions, hole, ball, target) : []),
    [sessions, hole, ball, target],
  )

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
  const targetDistance = pointDistance(ball, target)
  const ballSurface = hole ? classifyPoint(hole, ball) : null
  const ballTerrain = holeNumber === 1 ? estimateGreywolfHole01Terrain(ball) : null
  const selectedLandingTerrain =
    holeNumber === 1 && selected?.bestCandidate
      ? estimateGreywolfHole01Terrain(selected.bestCandidate.meanLanding)
      : null
  const selectedElevationDelta =
    ballTerrain && selectedLandingTerrain
      ? selectedLandingTerrain.elevationFt - ballTerrain.elevationFt
      : null

  const resetTee = () => {
    if (!hole) return
    setBall(hole.markers.tee)
    setTarget(defaultTarget(hole))
    setEditMode('target')
  }

  const targetGreen = () => {
    if (!hole?.markers.pin) return
    setTarget(hole.markers.pin)
    setEditMode('target')
  }

  return (
    <main className="aim-lab-page">
      <header className="aim-lab-header">
        <div>
          <p className="aim-eyebrow">LOOPER · AIM LAB V0</p>
          <h1>Greywolf decision inspector</h1>
          <p>See every assumption before we let aim optimization become a black box.</p>
        </div>
        <div className="aim-round-status">
          <strong>{playerEmail ?? 'Signed-in player'}</strong>
          <span>{sessions.length} sessions · {sessions.reduce((sum, session) => sum + session.shots.length, 0)} shots</span>
        </div>
      </header>

      <section className="aim-toolbar">
        <label>
          Hole
          <select value={holeNumber} onChange={(event) => setHoleNumber(Number(event.target.value))}>
            {Array.from({ length: 18 }, (_, index) => index + 1).map((number) => (
              <option value={number} key={number}>#{number}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={resetTee} disabled={!hole}>Tee setup</button>
        <button type="button" onClick={targetGreen} disabled={!hole?.markers.pin}>Target green</button>
        <button type="button" className={editMode === 'ball' ? 'active' : ''} onClick={() => setEditMode('ball')}>
          Click map: set ball
        </button>
        <button type="button" className={editMode === 'target' ? 'active' : ''} onClick={() => setEditMode('target')}>
          Click map: set target
        </button>
        <div className="aim-toolbar-reading">
          <span>Selected landing distance</span>
          <strong>{targetDistance.toFixed(1)} yd</strong>
        </div>
      </section>

      {loadError && <div className="aim-alert bad">{loadError}</div>}
      {!hole && !loadError && <div className="aim-alert">Loading Greywolf Hole {holeNumber}…</div>}

      {hole && (
        <>
          <section className="aim-top-grid">
            <article className="aim-card map-card">
              <div className="aim-card-heading">
                <div>
                  <span>COURSE</span>
                  <h2>Hole {hole.holeNumber} geometry</h2>
                </div>
                <small>{editMode === 'ball' ? 'Click to move ball' : 'Click to move landing target'}</small>
              </div>
              <AimMap
                hole={hole}
                ball={ball}
                target={target}
                selected={selected}
                editMode={editMode}
                onSetPoint={(point) => {
                  if (editMode === 'ball') setBall(point)
                  else setTarget(point)
                }}
              />
            </article>

            <article className="aim-card state-card">
              <div className="aim-card-heading">
                <div>
                  <span>RAW SHOT STATE</span>
                  <h2>What we know right now</h2>
                </div>
              </div>
              <div className="state-grid">
                <div><span>Ball</span><strong>{ball[0].toFixed(1)} R / {ball[1].toFixed(1)} F</strong></div>
                <div><span>Target</span><strong>{target[0].toFixed(1)} R / {target[1].toFixed(1)} F</strong></div>
                <div><span>Distance</span><strong>{targetDistance.toFixed(1)} yd</strong></div>
                <div><span>Surface</span><strong>{ballSurface?.kind ?? 'unknown'}</strong></div>
              </div>

              <div className="manual-context-grid">
                <label>Wind mph<input type="number" value={windMph} onChange={(event) => setWindMph(Number(event.target.value))} /></label>
                <label>Wind relative °<input type="number" value={windRelativeDeg} onChange={(event) => setWindRelativeDeg(Number(event.target.value))} /></label>
                <label>Uphill lie °<input type="number" value={uphillLieDeg} onChange={(event) => setUphillLieDeg(Number(event.target.value))} /></label>
                <label>Sidehill lie °<input type="number" value={sidehillLieDeg} onChange={(event) => setSidehillLieDeg(Number(event.target.value))} /></label>
              </div>
              <p className="aim-note">These manual fields are intentionally visible before the live ShotState bridge is connected. A detected value must never silently imply a modeled effect.</p>
            </article>
          </section>

          <section className="aim-card">
            <div className="aim-card-heading">
              <div>
                <span>FACTOR STACK</span>
                <h2>Value → effect → source → confidence</h2>
              </div>
            </div>
            <div className="aim-table-wrap">
              <table className="aim-table factor-table">
                <thead><tr><th>Factor</th><th>Raw value</th><th>Current model effect</th><th>Source</th><th>Status</th></tr></thead>
                <tbody>
                  <tr><td>Player Stock</td><td>{selected ? `${selected.club} · ${selected.stockCarryYds.toFixed(1)} yd` : '—'}</td><td>Carry + 2D dispersion</td><td>Looper history</td><td><b className="status modeled">MODELED</b></td></tr>
                  <tr><td>Course geometry</td><td>Greywolf H{holeNumber}</td><td>Surface outcome classification</td><td>Cached OSM package</td><td><b className="status modeled">MODELED</b></td></tr>
                  <tr><td>Elevation</td><td>{selectedElevationDelta == null ? 'Unavailable' : `${selectedElevationDelta >= 0 ? '+' : ''}${selectedElevationDelta.toFixed(1)} ft to expected landing`}</td><td>Candidate-specific value displayed; not yet changing carry</td><td>{holeNumber === 1 ? 'LiDAR contour proxy' : 'LiDAR DEM bridge pending'}</td><td><b className="status review">REVIEW</b></td></tr>
                  <tr><td>Wind</td><td>{windMph} mph @ {windRelativeDeg}°</td><td>Detected/manual only; no carry or drift adjustment yet</td><td>Manual tonight / sensor later</td><td><b className="status pending">NOT MODELED</b></td></tr>
                  <tr><td>Surface / lie</td><td>{ballSurface?.kind ?? 'unknown'}</td><td>No carry/dispersion penalty yet</td><td>Course geometry / GSPro later</td><td><b className="status pending">NOT MODELED</b></td></tr>
                  <tr><td>Uphill/downhill lie</td><td>{uphillLieDeg}°</td><td>No launch/carry change yet</td><td>Manual tonight / ShotState later</td><td><b className="status pending">NOT MODELED</b></td></tr>
                  <tr><td>Ball above/below feet</td><td>{sidehillLieDeg}°</td><td>No start-line/curvature change yet</td><td>Manual tonight / ShotState later</td><td><b className="status pending">NOT MODELED</b></td></tr>
                  <tr><td>Mishit tail</td><td>Immature historical support</td><td>Not included in aim score yet</td><td>Looper classifier</td><td><b className="status review">LOW EVIDENCE</b></td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="aim-card">
            <div className="aim-card-heading">
              <div>
                <span>SHOT CANDIDATES</span>
                <h2>Your profile against this landing target</h2>
              </div>
              <small>Click a club to inspect all 11 lateral aim candidates.</small>
            </div>
            <div className="aim-table-wrap">
              <table className="aim-table candidate-table">
                <thead><tr><th>Club</th><th>Stock</th><th>Carry gap</th><th>Best aim</th><th>Preferred</th><th>Rough</th><th>Trouble</th><th>Penalty</th><th>Score</th><th>Support</th></tr></thead>
                <tbody>
                  {evaluations.slice(0, 8).map((item) => {
                    const best = item.bestCandidate
                    const outcomes = best?.surfaceOutcomes
                    return (
                      <tr key={item.club} className={selected?.club === item.club ? 'selected' : ''} onClick={() => setSelectedClub(item.club)}>
                        <td><strong>{item.club}</strong></td>
                        <td>{item.stockCarryYds.toFixed(1)} yd</td>
                        <td>{signedYds(item.carryGapYds)}</td>
                        <td>{signedYds(best?.aimOffsetYds)}</td>
                        <td>{pct(outcomes?.preferred)}</td>
                        <td>{pct(outcomes?.rough)}</td>
                        <td>{pct(outcomes?.trouble)}</td>
                        <td>{pct(outcomes?.penalty)}</td>
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
                  <div>
                    <span>AIM SWEEP · {selected.club.toUpperCase()}</span>
                    <h2>Why one target beats another</h2>
                  </div>
                </div>
                <div className="aim-table-wrap">
                  <table className="aim-table aim-sweep-table">
                    <thead><tr><th>Aim offset</th><th>Preferred</th><th>Rough</th><th>Trouble</th><th>Penalty</th><th>Unknown</th><th>Δ elev</th><th>Score</th></tr></thead>
                    <tbody>
                      {selected.candidates.map((candidate) => {
                        const landingTerrain = holeNumber === 1 ? estimateGreywolfHole01Terrain(candidate.meanLanding) : null
                        const elevationDelta = ballTerrain && landingTerrain ? landingTerrain.elevationFt - ballTerrain.elevationFt : null
                        return (
                          <tr key={candidate.aimOffsetYds} className={candidate === selected.bestCandidate ? 'best' : ''}>
                            <td><strong>{signedYds(candidate.aimOffsetYds)}</strong></td>
                            <td>{pct(candidate.surfaceOutcomes?.preferred)}</td>
                            <td>{pct(candidate.surfaceOutcomes?.rough)}</td>
                            <td>{pct(candidate.surfaceOutcomes?.trouble)}</td>
                            <td>{pct(candidate.surfaceOutcomes?.penalty)}</td>
                            <td>{pct(candidate.surfaceOutcomes?.unknown)}</td>
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
                <div className="aim-card-heading">
                  <div>
                    <span>SCORING ASSUMPTIONS</span>
                    <h2>V0 is intentionally simple</h2>
                  </div>
                </div>
                <div className="score-formula">
                  <code>score = preferred×{AIM_SCORE_ASSUMPTIONS.preferredWeight} + non-penalty-trouble×({AIM_SCORE_ASSUMPTIONS.nonPenaltyTroubleWeight}) + penalty×({AIM_SCORE_ASSUMPTIONS.penaltyWeight}) + unknown×({AIM_SCORE_ASSUMPTIONS.unknownWeight}) + |carry gap|×({AIM_SCORE_ASSUMPTIONS.carryGapPerYard})</code>
                </div>
                <p><strong>This is not final golf strategy.</strong> It is a reviewable baseline so we can argue with every assumption before improving it.</p>
                <div className="assumption-list">
                  <div><span>Aim search</span><strong>−15 to +15 yd, every 3 yd</strong></div>
                  <div><span>Shot shape</span><strong>Stock carry/lateral bias + Gaussian σ</strong></div>
                  <div><span>Smooth 90%</span><strong>Not synthesized yet</strong></div>
                  <div><span>Empirical mishit tail</span><strong>Not scored yet</strong></div>
                  <div><span>LiDAR</span><strong>Candidate-specific display; direct DEM sampler next</strong></div>
                  <div><span>Wind / lie / surface</span><strong>Visible but not yet modifying flight</strong></div>
                </div>
                {selected.notes.length > 0 && (
                  <div className="aim-warning-list">
                    {selected.notes.map((note) => <p key={note}>{note}</p>)}
                  </div>
                )}
              </article>
            </section>
          )}

          <footer className="aim-footer">
            <span>{hole.provenance.attribution}</span>
            <span>{hole.provenance.license}</span>
            <span>Greywolf all-hole geometry · review mode</span>
          </footer>
        </>
      )}
    </main>
  )
}

export default AimLabPage