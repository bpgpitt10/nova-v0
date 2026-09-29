import { useEffect, useMemo, useState } from 'react'
import {
  courseCatalog,
  GREYWOLF_COURSE_ID,
  type CourseId,
} from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import type {
  CourseContextKind,
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurfaceKind,
} from '../courseGeometry/types'
import { greywolfHole01RenderFixture as holeOneEvidence } from './greywolfHole01RenderFixture'
import './courseRenderDev.css'

const SVG_WIDTH = 420
const SVG_HEIGHT = 980
const PAD = 28

const signed = (value: number, digits = 1) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`

function CourseRenderDevPage() {
  const [selectedCourseId, setSelectedCourseId] = useState<CourseId>(GREYWOLF_COURSE_ID)
  const [selectedHole, setSelectedHole] = useState(1)
  const [geometry, setGeometry] = useState<CourseHoleGeometry | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showContours, setShowContours] = useState(true)
  const [showVegetation, setShowVegetation] = useState(true)
  const [showShots, setShowShots] = useState(true)
  const selectedCourse = courseCatalog.find((course) => course.id === selectedCourseId)

  useEffect(() => {
    let active = true
    setGeometry(null)
    setLoadError(null)
    loadCourseHoleGeometry(selectedCourseId, selectedHole)
      .then((payload) => {
        if (active) setGeometry(payload)
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      active = false
    }
  }, [selectedCourseId, selectedHole])

  const displayBounds = useMemo(() => {
    if (!geometry) return null
    const baseBounds = geometry.viewBounds ?? geometry.bounds
    const clampGreywolfHoleOne = selectedCourseId === GREYWOLF_COURSE_ID && selectedHole === 1
    return {
      minX: baseBounds.minX,
      maxX: baseBounds.maxX,
      minY: Math.max(baseBounds.minY, clampGreywolfHoleOne ? -28 : baseBounds.minY),
      maxY: baseBounds.maxY,
    }
  }, [geometry, selectedCourseId, selectedHole])

  const transform = useMemo(() => {
    if (!displayBounds) return null
    const spanX = Math.max(displayBounds.maxX - displayBounds.minX, 1)
    const spanY = Math.max(displayBounds.maxY - displayBounds.minY, 1)
    const scale = Math.min((SVG_WIDTH - PAD * 2) / spanX, (SVG_HEIGHT - PAD * 2) / spanY)
    const usedWidth = spanX * scale
    const usedHeight = spanY * scale
    const offsetX = (SVG_WIDTH - usedWidth) / 2
    const offsetY = (SVG_HEIGHT - usedHeight) / 2
    return {
      point([x, y]: CoursePointYds) {
        return [
          offsetX + (x - displayBounds.minX) * scale,
          SVG_HEIGHT - (offsetY + (y - displayBounds.minY) * scale),
        ] as const
      },
    }
  }, [displayBounds])

  const pathFor = (points: CoursePolygonYds) => {
    if (!transform || points.length === 0) return ''
    return `${points
      .map((point, index) => {
        const [x, y] = transform.point(point)
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
      })
      .join(' ')} Z`
  }

  const polylineFor = (points: readonly CoursePointYds[]) => {
    if (!transform) return ''
    return points
      .map((point) => {
        const [x, y] = transform.point(point)
        return `${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(' ')
  }

  const renderSurfaces = (kind: CourseSurfaceKind, className: string) =>
    geometry?.surfaces
      .filter((surface) => surface.kind === kind)
      .flatMap((surface) =>
        surface.polygons.map((polygon, index) => (
          <path key={`${surface.id}-${index}`} d={pathFor(polygon)} className={className} />
        )),
      )

  const renderContext = (kind: CourseContextKind, className: string) =>
    geometry?.contextLayers
      ?.filter((layer) => layer.kind === kind)
      .flatMap((layer) =>
        layer.polygons.map((polygon, index) => (
          <path key={`${layer.id}-${index}`} d={pathFor(polygon)} className={className} />
        )),
      )

  if (loadError) {
    return (
      <main className="course-render-dev">
        <section className="course-loading-card" role="alert">
          <p className="course-render-eyebrow">LOOPER · COURSE RENDER</p>
          <h1>{selectedCourse?.name ?? selectedCourseId} Hole {selectedHole} could not load</h1>
          <p>{loadError}</p>
        </section>
      </main>
    )
  }

  if (!geometry || !transform) {
    return (
      <main className="course-render-dev">
        <section className="course-loading-card" aria-live="polite">
          <p className="course-render-eyebrow">LOOPER · COURSE RENDER</p>
          <h1>Loading {selectedCourse?.name ?? selectedCourseId} Hole {selectedHole}…</h1>
        </section>
      </main>
    )
  }

  const pin = geometry.markers.pin
  const [teeX, teeY] = transform.point(geometry.markers.tee)
  const [pinX, pinY] = transform.point(pin ?? [0, geometry.statedYardageYds ?? geometry.bounds.maxY])
  const forwardDistance = Math.max(pin?.[1] ?? geometry.statedYardageYds ?? geometry.bounds.maxY, 0)
  const carryDistances = Array.from(
    { length: Math.floor((forwardDistance - 1) / 100) },
    (_, index) => (index + 1) * 100,
  )
  const carryArc = (distance: number) =>
    Array.from({ length: 81 }, (_, index) => {
      const angle = -Math.PI / 2 + (Math.PI * index) / 80
      return [Math.sin(angle) * distance, Math.cos(angle) * distance] as const
    })

  const surfaceCounts = geometry.surfaces.reduce<Record<string, number>>((counts, surface) => {
    counts[surface.kind] = (counts[surface.kind] ?? 0) + surface.polygons.length
    return counts
  }, {})
  const contextCounts = (geometry.contextLayers ?? []).reduce<Record<string, number>>((counts, layer) => {
    counts[layer.kind] = (counts[layer.kind] ?? 0) + layer.polygons.length
    return counts
  }, {})
  const contours = geometry.contours ?? []
  const contourElevations = contours.map((contour) => contour.elevationFt)
  const contourRange = contourElevations.length > 0
    ? `${Math.min(...contourElevations).toFixed(0)}–${Math.max(...contourElevations).toFixed(0)} ft`
    : 'Unavailable'
  const hasHoleOneEvidence = selectedCourseId === GREYWOLF_COURSE_ID && selectedHole === 1
  const hasLidar = Boolean(geometry.terrain || contours.length)
  const exactMatches = geometry.registration.validation?.exactSurfaceMatches
  const testedEndpoints = geometry.registration.validation?.testedEndpoints
  const within2m = geometry.registration.validation?.endpointsWithin2m
  const coordinateFrameLabel = geometry.coordinateSystem.origin === 'osm-hole-route-start'
    ? 'OSM HOLE START LOCAL YARDS'
    : 'SELECTED TEE LOCAL YARDS'

  return (
    <main className="course-render-dev">
      <header className="course-render-header">
        <div>
          <p className="course-render-eyebrow">LOOPER · CANONICAL COURSE RENDER</p>
          <h1>{geometry.courseName} · Hole {geometry.holeNumber}</h1>
          <p>
            Canonical course geometry loaded through the same provider contract used by Looper strategy. OSM context and LiDAR terrain appear when the source package provides them.
          </p>
        </div>
        <div className="course-render-controls" aria-label="Render controls">
          <label className="hole-picker">
            Course
            <select
              value={selectedCourseId}
              onChange={(event) => setSelectedCourseId(event.target.value as CourseId)}
            >
              {courseCatalog.map((course) => (
                <option key={course.id} value={course.id}>{course.name}</option>
              ))}
            </select>
          </label>
          <label className="hole-picker">
            Hole
            <select value={selectedHole} onChange={(event) => setSelectedHole(Number(event.target.value))}>
              {Array.from({ length: 18 }, (_, index) => index + 1).map((hole) => (
                <option key={hole} value={hole}>{hole}</option>
              ))}
            </select>
          </label>
          <label className={!geometry.contextLayers?.length ? 'control-disabled' : undefined}>
            <input
              type="checkbox"
              checked={showVegetation && Boolean(geometry.contextLayers?.length)}
              disabled={!geometry.contextLayers?.length}
              onChange={(event) => setShowVegetation(event.target.checked)}
            />
            OSM vegetation
          </label>
          <label className={!contours.length ? 'control-disabled' : undefined}>
            <input
              type="checkbox"
              checked={showContours && Boolean(contours.length)}
              disabled={!contours.length}
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
            Round 215 proof
          </label>
        </div>
      </header>

      <section className="course-render-grid">
        <article className="course-map-card">
          <div className="course-map-title-row">
            <div>
              <span className="course-map-kicker">{geometry.location ?? selectedCourse?.location ?? 'Unknown location'}</span>
              <h2>
                {geometry.par ? `Par ${geometry.par} · ` : ''}
                {geometry.statedYardageYds ? `${geometry.statedYardageYds.toFixed(0)} yd geometry` : 'Course geometry'}
              </h2>
            </div>
            <span className="truth-pill">{hasLidar ? 'OSM + LIDAR' : 'OSM'}</span>
          </div>

          <svg
            className="course-hole-svg"
            viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
            role="img"
            aria-label={`Data-driven rendering of ${geometry.courseName} hole ${geometry.holeNumber}`}
            data-testid={`${geometry.courseId}-hole-${geometry.holeNumber}-render`}
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
              <pattern id="woodsCanopyPattern" width="22" height="22" patternUnits="userSpaceOnUse">
                <rect width="22" height="22" fill="#173d29" fillOpacity="0.22" />
                <circle cx="4" cy="6" r="3.8" fill="#6f9962" fillOpacity="0.18" />
                <circle cx="14" cy="4" r="4.8" fill="#4f7a4b" fillOpacity="0.16" />
                <circle cx="10" cy="15" r="5.2" fill="#7ba06b" fillOpacity="0.14" />
              </pattern>
              <pattern id="scrubTexturePattern" width="18" height="18" patternUnits="userSpaceOnUse">
                <rect width="18" height="18" fill="#4d4a2d" fillOpacity="0.18" />
                <circle cx="4" cy="5" r="2.4" fill="#b5a967" fillOpacity="0.18" />
                <circle cx="13" cy="12" r="2.8" fill="#8c854f" fillOpacity="0.16" />
              </pattern>
              <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodOpacity="0.28" />
              </filter>
              <clipPath id="holeViewClip">
                <rect width={SVG_WIDTH} height={SVG_HEIGHT} rx="24" />
              </clipPath>
            </defs>

            <rect width={SVG_WIDTH} height={SVG_HEIGHT} rx="24" fill="url(#courseBg)" />
            <g clipPath="url(#holeViewClip)">
              {showVegetation && (
                <>
                  <g>{renderContext('grass-context', 'surface grass-context')}</g>
                  <g>{renderContext('woods', 'surface woods')}</g>
                  <g>{renderContext('scrub', 'surface scrub')}</g>
                </>
              )}

              {showContours && contours.length > 0 && (
                <g className="terrain-contours" aria-label="LiDAR elevation contours">
                  {contours.map((contour, index) => (
                    <polyline
                      key={`${contour.elevationFt}-${index}`}
                      points={polylineFor(contour.points)}
                      fill="none"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </g>
              )}

              <g filter="url(#softShadow)">{renderSurfaces('rough', 'surface rough')}</g>
              <g filter="url(#softShadow)">{renderSurfaces('water', 'surface water')}</g>
              <g filter="url(#softShadow)">{renderSurfaces('penalty', 'surface penalty')}</g>
              <g filter="url(#softShadow)">{renderSurfaces('fairway', 'surface fairway')}</g>
              <g filter="url(#softShadow)">{renderSurfaces('green', 'surface green')}</g>
              <g filter="url(#softShadow)">{renderSurfaces('bunker', 'surface bunker')}</g>
              <g filter="url(#softShadow)">{renderSurfaces('tee', 'surface tee')}</g>

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

              {pin && (
                <g className="pin-marker">
                  <title>OSM green centroid. Live GSPro pin remains a separate dynamic input.</title>
                  <line x1={pinX} x2={pinX} y1={pinY + 18} y2={pinY - 10} />
                  <path d={`M ${pinX} ${pinY - 10} l 17 6 l -17 7 Z`} />
                  <circle cx={pinX} cy={pinY + 18} r="4" />
                </g>
              )}

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
            <span><i className="legend-swatch tee" />Tee</span>
            <span><i className="legend-swatch fairway" />Fairway</span>
            <span><i className="legend-swatch green" />Green</span>
            <span><i className="legend-swatch bunker" />Bunker</span>
            <span><i className="legend-swatch water" />Water / penalty</span>
            <span><i className="legend-swatch woods" />Woods / obstruction</span>
          </div>
          <p className="course-map-attribution">
            Data ©{' '}
            <a href={geometry.provenance.copyrightUrl ?? 'https://www.openstreetmap.org/copyright'} target="_blank" rel="noreferrer">
              OpenStreetMap contributors
            </a>
            {' '}· {geometry.provenance.license ?? 'ODbL'}
            {hasLidar ? ' · LiDAR terrain from the compiled course package.' : ''}
          </p>
        </article>

        <aside className="course-data-column">
          <section className="course-data-card">
            <p className="card-kicker">STRATEGY READINESS</p>
            <dl className="metric-list">
              <div><dt>Registration</dt><dd>{geometry.registration.status.toUpperCase()}</dd></div>
              <div><dt>OSM surfaces</dt><dd>{geometry.surfaces.length} layers</dd></div>
              <div><dt>Vegetation</dt><dd>{(geometry.contextLayers ?? []).length} layers</dd></div>
              <div><dt>LiDAR terrain</dt><dd>{geometry.terrain ? 'DEM ACTIVE' : contours.length ? 'CONTOURS' : 'UNAVAILABLE'}</dd></div>
              <div><dt>Contour range</dt><dd>{contourRange}</dd></div>
              <div><dt>Coordinate frame</dt><dd>{coordinateFrameLabel}</dd></div>
            </dl>
          </section>

          <section className="course-data-card">
            <p className="card-kicker">SURFACE INVENTORY</p>
            <dl className="metric-list compact-metrics">
              <div><dt>Fairway polygons</dt><dd>{surfaceCounts.fairway ?? 0}</dd></div>
              <div><dt>Rough polygons</dt><dd>{surfaceCounts.rough ?? 0}</dd></div>
              <div><dt>Green polygons</dt><dd>{surfaceCounts.green ?? 0}</dd></div>
              <div><dt>Bunkers</dt><dd>{surfaceCounts.bunker ?? 0}</dd></div>
              <div><dt>Water</dt><dd>{surfaceCounts.water ?? 0}</dd></div>
              <div><dt>Woods</dt><dd>{contextCounts.woods ?? 0}</dd></div>
              <div><dt>Scrub</dt><dd>{contextCounts.scrub ?? 0}</dd></div>
            </dl>
          </section>

          <section className="course-data-card proof-card">
            <p className="card-kicker">GEOMETRY PROOF</p>
            <div className="proof-stat-grid">
              <div><strong>{exactMatches ?? '—'}</strong><span>exact matches</span></div>
              <div><strong>{testedEndpoints ?? '—'}</strong><span>tested endpoints</span></div>
              <div><strong>{within2m ?? '—'}</strong><span>within 2 m</span></div>
              <div><strong>{geometry.registration.residualsMeters?.mean?.toFixed(2) ?? '—'} m</strong><span>mean residual</span></div>
            </div>
            <p className="proof-footnote">
              {geometry.registration.note ?? 'Static course registration evidence has not yet been attached to this package.'}
            </p>
          </section>

          {hasHoleOneEvidence && (
            <section className="course-data-card proof-card">
              <p className="card-kicker">ROUND 215 LIVE CHECK</p>
              {holeOneEvidence.markers.shots.map((shot, index) => (
                <div key={shot.label} className="shot-proof-row">
                  <span className="shot-index">{index + 1}</span>
                  <div>
                    <strong>{shot.label}</strong>
                    <small>{signed(shot.x)} yd right · {signed(shot.y)} yd forward · {shot.surface}</small>
                  </div>
                </div>
              ))}
              <p className="proof-footnote">Real GSPro endpoints plotted in the same coordinate frame as the rendered OSM geometry.</p>
            </section>
          )}
        </aside>
      </section>
    </main>
  )
}

export default CourseRenderDevPage
