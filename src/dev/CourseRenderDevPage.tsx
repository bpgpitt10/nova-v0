import { useEffect, useMemo, useState } from 'react'
import {
  buildHoleRenderModel,
  loadCourseGeometryPackage,
} from '../courseGeometry/courseGeometry'
import type {
  Bounds,
  CourseGeometryPackage,
  CoursePoint,
  HoleRenderFeature,
} from '../courseGeometry/types'
import { greywolfHole01RenderFixture as holeOneEvidence } from './greywolfHole01RenderFixture'
import './courseRenderDev.css'

const SVG_WIDTH = 420
const SVG_HEIGHT = 980
const PAD = 28
const PROFILE_TEE_OFFSET_YDS = 46.9

const signed = (value: number, digits = 1) =>
  `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`

function CourseRenderDevPage() {
  const [coursePackage, setCoursePackage] = useState<CourseGeometryPackage | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedHole, setSelectedHole] = useState(1)
  const [showContours, setShowContours] = useState(true)
  const [showShots, setShowShots] = useState(true)

  useEffect(() => {
    let active = true
    loadCourseGeometryPackage()
      .then((payload) => {
        if (active) setCoursePackage(payload)
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      active = false
    }
  }, [])

  const renderModel = useMemo(
    () => (coursePackage ? buildHoleRenderModel(coursePackage, selectedHole) : null),
    [coursePackage, selectedHole],
  )
  const hasHoleOneEvidence = selectedHole === 1

  const displayBounds = useMemo<Bounds | null>(() => {
    if (!renderModel) return null
    if (!hasHoleOneEvidence) return renderModel.bounds
    return {
      minX: Math.min(renderModel.bounds.minX, holeOneEvidence.bounds.minX),
      maxX: Math.max(renderModel.bounds.maxX, holeOneEvidence.bounds.maxX),
      minY: Math.max(Math.min(renderModel.bounds.minY, holeOneEvidence.bounds.minY), -28),
      maxY: Math.max(renderModel.bounds.maxY, holeOneEvidence.bounds.maxY),
    }
  }, [hasHoleOneEvidence, renderModel])

  const transform = useMemo(() => {
    if (!displayBounds) return null
    const spanX = displayBounds.maxX - displayBounds.minX
    const spanY = displayBounds.maxY - displayBounds.minY
    const scale = Math.min((SVG_WIDTH - PAD * 2) / spanX, (SVG_HEIGHT - PAD * 2) / spanY)
    const usedWidth = spanX * scale
    const usedHeight = spanY * scale
    const offsetX = (SVG_WIDTH - usedWidth) / 2
    const offsetY = (SVG_HEIGHT - usedHeight) / 2
    return {
      point([x, y]: CoursePoint) {
        return [
          offsetX + (x - displayBounds.minX) * scale,
          SVG_HEIGHT - (offsetY + (y - displayBounds.minY) * scale),
        ] as const
      },
    }
  }, [displayBounds])

  const pathForRing = (points: readonly CoursePoint[]) => {
    if (!transform || points.length === 0) return ''
    return `${points
      .map((point, index) => {
        const [x, y] = transform.point(point)
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
      })
      .join(' ')} Z`
  }

  const pathForFeature = (feature: HoleRenderFeature) =>
    feature.polygons
      .flatMap((polygon) => polygon.map((ring) => pathForRing(ring)))
      .join(' ')

  const polylineFor = (points: readonly CoursePoint[]) => {
    if (!transform) return ''
    return points
      .map((point) => {
        const [x, y] = transform.point(point)
        return `${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(' ')
  }

  const renderFeatures = (kind: HoleRenderFeature['kind'], className: string) =>
    renderModel?.features
      .filter((feature) => feature.kind === kind)
      .map((feature) => (
        <path
          key={feature.id}
          d={pathForFeature(feature)}
          className={className}
          fillRule="evenodd"
          clipRule="evenodd"
          data-feature-id={feature.id}
        />
      ))

  const selectedTeeProfile = useMemo(
    () => [
      { distanceYds: 0, elevationFt: holeOneEvidence.metrics.teeElevationFt },
      ...holeOneEvidence.elevationProfile
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

  if (loadError) {
    return (
      <main className="course-render-dev">
        <section className="course-loading-card" role="alert">
          <p className="course-render-eyebrow">COURSE GEOMETRY PACKAGE</p>
          <h1>Greywolf could not load</h1>
          <p>{loadError}</p>
        </section>
      </main>
    )
  }
  if (!coursePackage || !renderModel || !transform) {
    return (
      <main className="course-render-dev">
        <section className="course-loading-card" aria-live="polite">
          <p className="course-render-eyebrow">COURSE GEOMETRY PACKAGE</p>
          <h1>Loading Greywolf…</h1>
        </section>
      </main>
    )
  }

  const hole = renderModel.hole
  const [teeX, teeY] = transform.point(renderModel.tee)
  const [greenX, greenY] = transform.point(renderModel.targetGreen)
  const carryDistances = Array.from(
    { length: Math.floor((renderModel.targetGreen[1] - 1) / 100) },
    (_, index) => (index + 1) * 100,
  )
  const carryArc = (distance: number) =>
    Array.from({ length: 81 }, (_, index) => {
      const angle = -Math.PI / 2 + (Math.PI * index) / 80
      return [Math.sin(angle) * distance, Math.cos(angle) * distance] as const
    })
  const surfaceLabel = hole.par.value ? `Par ${hole.par.value}` : 'Par unverified'

  return (
    <main className="course-render-dev">
      <header className="course-render-header">
        <div>
          <p className="course-render-eyebrow">LOOPER · COURSE GEOMETRY PACKAGE V1</p>
          <h1>{coursePackage.course.name} · Hole {hole.number}</h1>
          <p>
            {hasHoleOneEvidence
              ? 'Course-wide OSM surfaces + official 1 m LiDAR proof, rendered from a deterministic package.'
              : 'Course-wide OSM surfaces in the fixed Greywolf coordinate system. LiDAR render detail is not yet compiled for this hole.'}
          </p>
        </div>
        <div className="course-render-controls" aria-label="Render controls">
          <label className="hole-picker">
            Hole
            <select value={selectedHole} onChange={(event) => setSelectedHole(Number(event.target.value))}>
              {coursePackage.holes.map((candidate) => (
                <option key={candidate.number} value={candidate.number}>{candidate.number}</option>
              ))}
            </select>
          </label>
          <label className={!hasHoleOneEvidence ? 'control-disabled' : undefined}>
            <input
              type="checkbox"
              checked={showContours && hasHoleOneEvidence}
              disabled={!hasHoleOneEvidence}
              onChange={(event) => setShowContours(event.target.checked)}
            />
            LiDAR contours
          </label>
          <label className={!hasHoleOneEvidence ? 'control-disabled' : undefined}>
            <input
              type="checkbox"
              checked={showShots && hasHoleOneEvidence}
              disabled={!hasHoleOneEvidence}
              onChange={(event) => setShowShots(event.target.checked)}
            />
            Round 215 shots
          </label>
        </div>
      </header>

      <section className="course-render-grid">
        <article className="course-map-card">
          <div className="course-map-title-row">
            <div>
              <span className="course-map-kicker">{coursePackage.course.location}</span>
              <h2>{surfaceLabel} · {hole.yardage.gsproTeeToPinYards.toFixed(0)} GSPro yds</h2>
            </div>
            <span className="truth-pill">{hasHoleOneEvidence ? 'OSM + LIDAR PROOF' : 'OSM GEOMETRY'}</span>
          </div>

          <svg
            className="course-hole-svg"
            viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
            role="img"
            aria-label={`Data-driven rendering of ${coursePackage.course.name} hole ${hole.number}`}
            data-testid={`greywolf-hole-${hole.number}-render`}
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
              <clipPath id="holeViewClip">
                <rect width={SVG_WIDTH} height={SVG_HEIGHT} rx="24" />
              </clipPath>
            </defs>

            <rect width={SVG_WIDTH} height={SVG_HEIGHT} rx="24" fill="url(#courseBg)" />

            <g clipPath="url(#holeViewClip)">
              {showContours && hasHoleOneEvidence && (
                <g className="terrain-contours" aria-label="LiDAR elevation contours">
                  {holeOneEvidence.layers.contours.map((contour, index) => (
                    <polyline
                      key={`contour-${index}`}
                      points={polylineFor(contour.points)}
                      fill="none"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </g>
              )}

              <g filter="url(#softShadow)">{renderFeatures('rough', 'surface rough')}</g>
              <g filter="url(#softShadow)">{renderFeatures('water', 'surface water')}</g>
              <g filter="url(#softShadow)">{renderFeatures('fairway', 'surface fairway')}</g>
              <g filter="url(#softShadow)">{renderFeatures('green', 'surface green')}</g>
              <g filter="url(#softShadow)">{renderFeatures('bunker', 'surface bunker')}</g>
              <g filter="url(#softShadow)">{renderFeatures('tee', 'surface tee')}</g>

              {carryDistances.map((distance) => {
                const [, labelY] = transform.point([0, distance])
                return (
                  <g key={distance} className="distance-marker carry-marker">
                    <polyline points={polylineFor(carryArc(distance))} fill="none" />
                    <rect x="184" y={labelY - 13} width="52" height="24" rx="12" />
                    <text x="210" y={labelY + 4}>{distance}</text>
                  </g>
                )
              })}

              <g className="tee-marker">
                <circle cx={teeX} cy={teeY} r="8" />
                <circle cx={teeX} cy={teeY} r="3" />
                <text x={teeX + 13} y={teeY + 4}>TEE</text>
              </g>

              <g className="pin-marker">
                <title>OSM target-green centroid; live pin remains a separate GSPro sensor.</title>
                <line x1={greenX} x2={greenX} y1={greenY + 18} y2={greenY - 10} />
                <path d={`M ${greenX} ${greenY - 10} l 17 6 l -17 7 Z`} />
                <circle cx={greenX} cy={greenY + 18} r="4" />
              </g>

              {showShots && hasHoleOneEvidence && holeOneEvidence.markers.shots.map((shot, index) => {
                const [x, y] = transform.point([shot.x, shot.y])
                return (
                  <g key={shot.label} className="live-shot-marker" data-shot-index={index + 1}>
                    <circle cx={x} cy={y} r="8" />
                    <circle cx={x} cy={y} r="3" />
                    <text x={x + 12} y={y - 10}>{index + 1}</text>
                  </g>
                )
              })}
            </g>
          </svg>

          <div className="course-map-legend">
            <span><i className="legend-swatch tee" />Selected tee</span>
            <span><i className="legend-swatch fairway" />Fairway</span>
            <span><i className="legend-swatch green" />Target green</span>
            <span><i className="legend-swatch bunker" />Bunker</span>
            <span><i className="legend-swatch water" />OSM penalty / water</span>
          </div>
        </article>

        <aside className="course-data-column">
          <section className="course-data-card">
            <p className="card-kicker">HOLE OVERVIEW</p>
            <dl className="metric-list">
              <div><dt>GSPro tee → pin</dt><dd>{hole.yardage.gsproTeeToPinYards.toFixed(0)} yds</dd></div>
              <div><dt>OSM tee → green</dt><dd>{hole.yardage.osmTeeToGreenCentroidYards.toFixed(1)} yds</dd></div>
              <div><dt>Distance residual</dt><dd>{signed(hole.yardage.residualYards)} yds</dd></div>
              <div><dt>True heading</dt><dd>{hole.anchors.headingDegreesTrue.toFixed(1)}°</dd></div>
              <div><dt>Fairway polygons</dt><dd>{renderModel.counts.fairway}</dd></div>
              <div><dt>Bunkers</dt><dd>{renderModel.counts.bunker}</dd></div>
              <div><dt>Penalty / water</dt><dd>{renderModel.counts.water}</dd></div>
            </dl>
          </section>

          {hasHoleOneEvidence && (
            <>
              <section className="course-data-card">
                <p className="card-kicker">GREEN TERRAIN</p>
                <div className="green-terrain-summary">
                  <strong>{holeOneEvidence.metrics.greenElevationRangeFt} ft</strong>
                  <span>low-to-high range</span>
                </div>
                <p className="terrain-note">
                  Back quarter averages <strong>+{holeOneEvidence.metrics.greenBackVsFrontFt} ft</strong> versus the front quarter.
                </p>
                <div className="green-high-low">
                  <span className="high-dot" /> High {holeOneEvidence.markers.greenHigh.elevationFt.toFixed(1)} ft
                  <span className="low-dot" /> Low {holeOneEvidence.markers.greenLow.elevationFt.toFixed(1)} ft
                </div>
              </section>

              <section className="course-data-card">
                <p className="card-kicker">ELEVATION PROFILE</p>
                <svg className="elevation-profile" viewBox="0 0 320 160" role="img" aria-label="LiDAR elevation profile from selected tee to green">
                  <line x1="16" x2="304" y1="138" y2="138" className="profile-axis" />
                  <polyline points={profilePoints} fill="none" className="profile-line" />
                  <text x="16" y="154">Tee</text>
                  <text x="304" y="154" textAnchor="end">Green · {profileDistance.toFixed(0)} route yds</text>
                  <text x="304" y="22" textAnchor="end" className="profile-climb">+{holeOneEvidence.metrics.climbFt} ft</text>
                </svg>
              </section>

              <section className="course-data-card proof-card">
                <p className="card-kicker">LIVE COORDINATE CHECK</p>
                {holeOneEvidence.markers.shots.map((shot, index) => (
                  <div key={shot.label} className="shot-proof-row">
                    <span className="shot-index">{index + 1}</span>
                    <div>
                      <strong>{shot.label}</strong>
                      <small>{shot.x.toFixed(1)} yd right · {shot.y.toFixed(1)} yd forward · {shot.surface}</small>
                    </div>
                  </div>
                ))}
                <p className="proof-footnote">Real Round 215 GSPro endpoints transformed into the package coordinate system.</p>
              </section>
            </>
          )}

          <section className="course-data-card proof-card">
            <p className="card-kicker">PACKAGE STATUS</p>
            <dl className="metric-list">
              <div><dt>Registered holes</dt><dd>{coursePackage.holes.length}</dd></div>
              <div><dt>Static features</dt><dd>{coursePackage.compilerDiagnostics.featureCount}</dd></div>
              <div><dt>Max tie-point error</dt><dd>{coursePackage.registration.validation.maxResidualYards.toFixed(3)} yd</dd></div>
              <div><dt>Strategy authority</dt><dd>Shadow only</dd></div>
            </dl>
            <p className="proof-footnote">
              Wind remains required GSPro top-center HUD OCR. It is never inferred from OSM and OCR failure never means calm.
            </p>
          </section>
        </aside>
      </section>
    </main>
  )
}

export default CourseRenderDevPage
