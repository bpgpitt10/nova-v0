import { greywolfHole01Geometry as hole } from '../courseGeometry/greywolfHole01'
import {
  greywolfHole01Regression,
  greywolfHole01RegressionPasses,
} from '../courseGeometry/greywolfHole01Regression'
import { TACTICAL_SURFACE_SEMANTICS } from '../courseGeometry/semantics'
import type { CourseSurfaceKind } from '../courseGeometry/types'
import './courseGeometryDev.css'

const percent = (value: number) => `${Math.round(value * 100)}%`
const yards = (value: number | null) => (value == null ? '—' : `${value.toFixed(1)} yd`)

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

function CourseGeometryDevPage() {
  const validation = greywolfHole01Regression.geometryValidation

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
          <span>COORDINATES</span>
          <strong>Selected tee = 0,0</strong>
          <small>+x right · +y forward · yards</small>
        </article>
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
