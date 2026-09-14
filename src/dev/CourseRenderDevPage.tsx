import { useMemo, useState } from 'react'
import { greywolfHole01RenderFixture as hole } from './greywolfHole01RenderFixture'
import './courseRenderDev.css'

type Point = readonly [number, number]
type PolygonLayer = readonly (readonly Point[])[]

const SVG_WIDTH = 420
const SVG_HEIGHT = 980
const PAD = 28
const PROFILE_TEE_OFFSET_YDS = 46.9

function CourseRenderDevPage() {
  const [showContours, setShowContours] = useState(true)
  const [showShots, setShowShots] = useState(true)

  const displayBounds = useMemo(
    () => ({
      ...hole.bounds,
      // Keep enough terrain behind the selected tee for context, but do not let
      // unrelated mapped water ~65 yd behind the tee dominate the live-hole crop.
      minY: Math.max(hole.bounds.minY, -28),
    }),
    [],
  )

  const transform = useMemo(() => {
    const spanX = displayBounds.maxX - displayBounds.minX
    const spanY = displayBounds.maxY - displayBounds.minY
    const scale = Math.min((SVG_WIDTH - PAD * 2) / spanX, (SVG_HEIGHT - PAD * 2) / spanY)
    const usedWidth = spanX * scale
    const usedHeight = spanY * scale
    const offsetX = (SVG_WIDTH - usedWidth) / 2
    const offsetY = (SVG_HEIGHT - usedHeight) / 2

    return {
      point([x, y]: Point) {
        return [
          offsetX + (x - displayBounds.minX) * scale,
          SVG_HEIGHT - (offsetY + (y - displayBounds.minY) * scale),
        ] as const
      },
      scale,
    }
  }, [displayBounds])

  const pathFor = (points: readonly Point[]) => {
    if (points.length === 0) return ''
    return points
      .map((point, index) => {
        const [x, y] = transform.point(point)
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
      })
      .join(' ') + ' Z'
  }

  const polylineFor = (points: readonly Point[]) =>
    points
      .map((point) => {
        const [x, y] = transform.point(point)
        return `${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(' ')

  const renderPolygons = (layer: PolygonLayer, className: string) =>
    layer.map((points, index) => (
      <path key={`${className}-${index}`} d={pathFor(points)} className={className} />
    ))

  const [teeX, teeY] = transform.point([hole.markers.tee.x, hole.markers.tee.y])
  const [pinX, pinY] = transform.point([hole.markers.pin.x, hole.markers.pin.y])

  // The preserved OSM hole route begins ~46.9 yd behind the selected GSPro tee.
  // Normalize the cached LiDAR route profile so this dev page begins at the
  // actually selected tee rather than the back-most OSM route endpoint.
  const selectedTeeProfile = useMemo(
    () => [
      { distanceYds: 0, elevationFt: hole.metrics.teeElevationFt },
      ...hole.elevationProfile
        .filter((point) => point.distanceYds > PROFILE_TEE_OFFSET_YDS)
        .map((point) => ({
          distanceYds: point.distanceYds - PROFILE_TEE_OFFSET_YDS,
          elevationFt: point.elevationFt,
        })),
    ],
    [],
  )
  const profileMin = Math.min(...selectedTeeProfile.map((point) => point.elevationFt))
  const profileMax = Math.max(...selectedTeeProfile.map((point) => point.elevationFt))
  const profileDistance = Math.max(...selectedTeeProfile.map((point) => point.distanceYds))
  const profilePoints = selectedTeeProfile
    .map((point) => {
      const x = 16 + (point.distanceYds / profileDistance) * 288
      const y = 138 - ((point.elevationFt - profileMin) / Math.max(profileMax - profileMin, 1)) * 104
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <main className="course-render-dev">
      <header className="course-render-header">
        <div>
          <p className="course-render-eyebrow">LOOPER · COURSE RENDER V0</p>
          <h1>{hole.course} · Hole {hole.hole}</h1>
          <p>
            Real OSM surfaces + official 1 m LiDAR. This page is intentionally deterministic—no generated imagery.
          </p>
        </div>
        <div className="course-render-controls" aria-label="Render controls">
          <label>
            <input type="checkbox" checked={showContours} onChange={(event) => setShowContours(event.target.checked)} />
            LiDAR contours
          </label>
          <label>
            <input type="checkbox" checked={showShots} onChange={(event) => setShowShots(event.target.checked)} />
            Round 215 shots
          </label>
        </div>
      </header>

      <section className="course-render-grid">
        <article className="course-map-card">
          <div className="course-map-title-row">
            <div>
              <span className="course-map-kicker">{hole.location}</span>
              <h2>Par {hole.par} · {hole.yardage} yds</h2>
            </div>
            <span className="truth-pill">REAL DATA</span>
          </div>

          <svg
            className="course-hole-svg"
            viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
            role="img"
            aria-label={`Data driven rendering of ${hole.course} hole ${hole.hole}`}
            data-testid="greywolf-hole-1-render"
          >
            <defs>
              <linearGradient id="courseBg" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0" stopColor="#071a17" />
                <stop offset="1" stopColor="#173226" />
              </linearGradient>
              <linearGradient id="fairwayFill" x1="0" y1="1" x2="0.8" y2="0">
                <stop offset="0" stopColor="#548b42" />
                <stop offset="1" stopColor="#86b65a" />
              </linearGradient>
              <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodOpacity="0.28" />
              </filter>
            </defs>

            <rect width={SVG_WIDTH} height={SVG_HEIGHT} rx="24" fill="url(#courseBg)" />

            {showContours && (
              <g className="terrain-contours" aria-label="LiDAR elevation contours">
                {hole.layers.contours.map((contour, index) => (
                  <polyline
                    key={`contour-${index}`}
                    points={polylineFor(contour.points)}
                    fill="none"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
            )}

            <g filter="url(#softShadow)">{renderPolygons(hole.layers.rough, 'surface rough')}</g>
            <g filter="url(#softShadow)">{renderPolygons(hole.layers.water, 'surface water')}</g>
            <g filter="url(#softShadow)">{renderPolygons(hole.layers.fairway, 'surface fairway')}</g>
            <g filter="url(#softShadow)">{renderPolygons(hole.layers.green, 'surface green')}</g>
            <g filter="url(#softShadow)">{renderPolygons(hole.layers.bunker, 'surface bunker')}</g>
            <g filter="url(#softShadow)">{renderPolygons(hole.layers.tee, 'surface tee')}</g>

            {[100, 200, 300].map((distance) => {
              const [, y] = transform.point([0, distance])
              return (
                <g key={distance} className="distance-marker">
                  <line x1="110" x2="310" y1={y} y2={y} />
                  <rect x="184" y={y - 13} width="52" height="24" rx="12" />
                  <text x="210" y={y + 4}>{distance}</text>
                </g>
              )
            })}

            <g className="tee-marker">
              <circle cx={teeX} cy={teeY} r="8" />
              <circle cx={teeX} cy={teeY} r="3" />
              <text x={teeX + 13} y={teeY + 4}>TEE</text>
            </g>

            <g className="pin-marker">
              <line x1={pinX} x2={pinX} y1={pinY + 18} y2={pinY - 10} />
              <path d={`M ${pinX} ${pinY - 10} l 17 6 l -17 7 Z`} />
              <circle cx={pinX} cy={pinY + 18} r="4" />
            </g>

            {showShots && hole.markers.shots.map((shot, index) => {
              const [x, y] = transform.point([shot.x, shot.y])
              return (
                <g key={shot.label} className="live-shot-marker" data-shot-index={index + 1}>
                  <circle cx={x} cy={y} r="8" />
                  <circle cx={x} cy={y} r="3" />
                  <text x={x + 12} y={y - 10}>{index + 1}</text>
                </g>
              )
            })}
          </svg>

          <div className="course-map-legend">
            <span><i className="legend-swatch tee" />Tee</span>
            <span><i className="legend-swatch fairway" />Fairway</span>
            <span><i className="legend-swatch green" />Green</span>
            <span><i className="legend-swatch bunker" />Bunker</span>
            <span><i className="legend-swatch water" />OSM penalty / water</span>
          </div>
          <p className="course-map-attribution">
            Data ©{' '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              OpenStreetMap contributors
            </a>
            {' '}·{' '}
            <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">
              ODbL 1.0
            </a>
          </p>
        </article>

        <aside className="course-data-column">
          <section className="course-data-card">
            <p className="card-kicker">HOLE OVERVIEW</p>
            <dl className="metric-list">
              <div><dt>Tee → green</dt><dd>{hole.yardage} yds</dd></div>
              <div><dt>Tee elevation</dt><dd>{hole.metrics.teeElevationFt.toLocaleString()} ft</dd></div>
              <div><dt>Green elevation</dt><dd>{hole.metrics.greenElevationFt.toLocaleString()} ft</dd></div>
              <div><dt>Climb</dt><dd>+{hole.metrics.climbFt} ft</dd></div>
              <div><dt>Avg. fairway width</dt><dd>{hole.metrics.averageFairwayWidthYds} yds</dd></div>
              <div><dt>Bunkers</dt><dd>{hole.metrics.bunkerCount}</dd></div>
              <div><dt>Water polygons</dt><dd>{hole.metrics.waterPolygonCount}</dd></div>
            </dl>
          </section>

          <section className="course-data-card">
            <p className="card-kicker">GREEN TERRAIN</p>
            <div className="green-terrain-summary">
              <strong>{hole.metrics.greenElevationRangeFt} ft</strong>
              <span>low-to-high range</span>
            </div>
            <p className="terrain-note">
              Back quarter averages <strong>+{hole.metrics.greenBackVsFrontFt} ft</strong> versus the front quarter.
            </p>
            <div className="green-high-low">
              <span className="high-dot" /> High {hole.markers.greenHigh.elevationFt.toFixed(1)} ft
              <span className="low-dot" /> Low {hole.markers.greenLow.elevationFt.toFixed(1)} ft
            </div>
          </section>

          <section className="course-data-card">
            <p className="card-kicker">ELEVATION PROFILE</p>
            <svg className="elevation-profile" viewBox="0 0 320 160" role="img" aria-label="LiDAR elevation profile from selected tee to green">
              <line x1="16" x2="304" y1="138" y2="138" className="profile-axis" />
              <polyline points={profilePoints} fill="none" className="profile-line" />
              <text x="16" y="154">Tee</text>
              <text x="304" y="154" textAnchor="end">Green · {profileDistance.toFixed(0)} route yds</text>
              <text x="304" y="22" textAnchor="end" className="profile-climb">+{hole.metrics.climbFt} ft</text>
            </svg>
          </section>

          <section className="course-data-card proof-card">
            <p className="card-kicker">LIVE COORDINATE CHECK</p>
            {hole.markers.shots.map((shot, index) => (
              <div key={shot.label} className="shot-proof-row">
                <span className="shot-index">{index + 1}</span>
                <div>
                  <strong>{shot.label}</strong>
                  <small>{shot.x.toFixed(1)} yd right · {shot.y.toFixed(1)} yd forward · {shot.surface}</small>
                </div>
              </div>
            ))}
            <p className="proof-footnote">These are real Round 215 GSPro endpoints transformed into the same course coordinate system as the SVG.</p>
          </section>
        </aside>
      </section>
    </main>
  )
}

export default CourseRenderDevPage
