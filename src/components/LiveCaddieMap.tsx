import { useMemo } from 'react'
import type { AimCandidateEvaluation } from '../liveCaddie/aimOptimization'
import { greenYardage, hazardYardages } from '../liveCaddie/mapYardages'
import { greenHeightImage, type GreenReadAnalysis } from '../liveCaddie/greenRead'
import { buildHillshade } from '../liveCaddie/hillshade'
import { minimapBasis, minimapFrame } from '../liveCaddie/minimapFrame'
import type {
  CourseContextKind,
  CourseHoleGeometry,
  CourseMapFeatureKind,
  CoursePointYds,
  CourseSurfaceKind,
} from '../courseGeometry/types'

/**
 * The Live Caddie shot map: the hole drawn like GSPro's minimap (ball at the
 * bottom, pin straight up) with the aim, expected finish, dispersion,
 * practice shots, risk tail and yardage-book numbers on top.
 */

const pointDistance = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(a[0] - b[0], a[1] - b[1])

const surfaceOrder: CourseSurfaceKind[] = [
  'rough',
  'deep-rough',
  'fairway',
  'tee',
  'green',
  'bunker',
  'penalty',
  'water',
]

const contextOrder: CourseContextKind[] = [
  'landcover-grass',
  'grass-context',
  'native-grass',
  'landcover-bare',
  'dune-sand',
  'landcover-scrub',
  'scrub',
  'landcover-woods',
  'woods',
]

const featureOrder: CourseMapFeatureKind[] = ['parking', 'building', 'road', 'cartpath']
const buildTacticalMapBounds = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  target: CoursePointYds,
  pinEstimate: CoursePointYds | null,
  candidate: AimCandidateEvaluation | null,
  provisionalTeeRadiusYds: number | null = null,
) => {
  const pinDistance = pinEstimate ? pointDistance(ball, pinEstimate) : Number.POSITIVE_INFINITY
  const includePin = Boolean(pinEstimate && pinDistance <= 285)
  const focusPoints: CoursePointYds[] = [ball, target]
  if (candidate) focusPoints.push(candidate.aimPoint, candidate.meanLanding)
  if (includePin && pinEstimate) focusPoints.push(pinEstimate)

  const maxCarryRadius = candidate?.probabilityContours.reduce(
    (maximum, contour) => Math.max(maximum, contour.carryRadiusYds),
    0,
  ) ?? 0
  const maxLateralRadius = candidate?.probabilityContours.reduce(
    (maximum, contour) => Math.max(maximum, contour.lateralRadiusYds),
    0,
  ) ?? 0

  const minY = ball[1] - Math.max(24, (provisionalTeeRadiusYds ?? 0) + 5)
  const furthestFocusY = Math.max(...focusPoints.map((point) => point[1]))
  const desiredMaxY = furthestFocusY + Math.max(115, maxCarryRadius + 70)
  const minimumForwardSpan = pinDistance < 180
    ? Math.max(130, pinDistance + 60)
    : 260
  const maxY = Math.max(
    minY + minimumForwardSpan,
    Math.min(desiredMaxY, ball[1] + 390),
  )

  let referenceMinX = Math.min(...focusPoints.map((point) => point[0])) - maxLateralRadius
  let referenceMaxX = Math.max(...focusPoints.map((point) => point[0])) + maxLateralRadius
  const surfaceWindowMinX = referenceMinX - 72
  const surfaceWindowMaxX = referenceMaxX + 72
  const surfaceWindowMinY = minY - 12
  const surfaceWindowMaxY = maxY + 12
  const framingKinds = new Set<CourseSurfaceKind>([
    'tee',
    'fairway',
    'green',
    'bunker',
    'water',
    'penalty',
  ])

  for (const surface of hole.surfaces) {
    if (!framingKinds.has(surface.kind)) continue
    for (const polygon of surface.polygons) {
      for (const [x, y] of polygon) {
        if (
          y < surfaceWindowMinY ||
          y > surfaceWindowMaxY ||
          x < surfaceWindowMinX ||
          x > surfaceWindowMaxX
        ) continue
        referenceMinX = Math.min(referenceMinX, x)
        referenceMaxX = Math.max(referenceMaxX, x)
      }
    }
  }

  const centerX = (referenceMinX + referenceMaxX) / 2
  const halfWidth = Math.min(
    96,
    Math.max(58, (referenceMaxX - referenceMinX) / 2 + 20),
  )

  return {
    minX: centerX - halfWidth,
    maxX: centerX + halfWidth,
    minY,
    maxY,
  }
}

export default function LiveCaddieMap({
  hole,
  ball,
  target,
  pinEstimate,
  candidate,
  strategyAimPoint,
  show95,
  showRiskTail,
  showPracticeShots,
  provisionalTeeRadiusYds,
  greenRead = null,
}: {
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  pinEstimate: CoursePointYds | null
  candidate: AimCandidateEvaluation | null
  strategyAimPoint: CoursePointYds | null
  show95: boolean
  showRiskTail: boolean
  showPracticeShots: boolean
  provisionalTeeRadiusYds: number | null
  /** Green read overlay (steepness colours, tiers/spines, tilt arrow); null hides it. */
  greenRead?: GreenReadAnalysis | null
}) {
  const viewSize = 100
  const pad = 4
  // Orient like GSPro's minimap: ball at the bottom, pin straight up, so the
  // two pictures (and an aim point on either) line up at a glance. Falls back
  // to the target when the hole has no pin.
  const viewFrame = useMemo(() => {
    const toView = minimapFrame(ball, pinEstimate ?? hole.markers.pin ?? target)
    const viewHole: CourseHoleGeometry = {
      ...hole,
      surfaces: hole.surfaces.map((surface) => ({
        ...surface,
        polygons: surface.polygons.map((polygon) => polygon.map(toView)),
      })),
    }
    return { toView, viewHole }
  }, [hole, ball, pinEstimate, target])
  const { toView, viewHole } = viewFrame
  const displayBounds = buildTacticalMapBounds(
    viewHole,
    toView(ball),
    toView(target),
    pinEstimate ? toView(pinEstimate) : null,
    candidate ? { ...candidate, aimPoint: toView(candidate.aimPoint), meanLanding: toView(candidate.meanLanding) } : null,
    provisionalTeeRadiusYds,
  )
  const spanX = Math.max(1, displayBounds.maxX - displayBounds.minX)
  const spanY = Math.max(1, displayBounds.maxY - displayBounds.minY)
  const scale = Math.min((viewSize - pad * 2) / spanX, (viewSize - pad * 2) / spanY)
  const usedWidth = spanX * scale
  const usedHeight = spanY * scale
  const offsetX = (viewSize - usedWidth) / 2
  const offsetY = (viewSize - usedHeight) / 2

  const projectView = ([x, y]: CoursePointYds): [number, number] => [
    offsetX + (x - displayBounds.minX) * scale,
    viewSize - (offsetY + (y - displayBounds.minY) * scale),
  ]
  const project = (point: CoursePointYds): [number, number] => projectView(toView(point))

  // Hole-local yards -> SVG as one affine matrix (for the hillshade image).
  const { up, right } = minimapBasis(ball, pinEstimate ?? hole.markers.pin ?? target)
  const [b0, b1] = project([0, 0])
  const holeToSvg = [
    scale * right[0], -scale * up[0],
    scale * right[1], -scale * up[1],
    b0, b1,
  ].map((n) => Number(n.toFixed(5)))
  const upKey = `${up[0].toFixed(3)},${up[1].toFixed(3)}`
  // Recomputed only when the hole or the map's orientation changes.
  const shade = useMemo(() => {
    if (!hole.terrain) return null
    const [u0, u1] = upKey.split(',').map(Number)
    return buildHillshade(hole.terrain, [u1, -u0], [u0, u1])
  }, [hole.terrain, upKey])

  // Green read: the height image (once per green) and, in view space, the
  // feature tags and an overall-tilt arrow placed just off the green.
  // Height (blue low -> red high), the way GSPro's minimap shows greens.
  const slopeImage = useMemo(() => (greenRead ? greenHeightImage(greenRead) : null), [greenRead])
  const greenPolys = viewHole.surfaces.filter((surface) => surface.kind === 'green').flatMap((surface) => surface.polygons)
  const greenOverlay = (() => {
    if (!greenRead || !greenPolys.length) return null
    const pts = greenPolys.flatMap((poly) => poly.map(projectView))
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
    if (box.maxX < 0 || box.minX > viewSize || box.maxY < 0 || box.minY > viewSize) return null
    // The two biggest features, never stacked on each other.
    const tags: { key: string; x: number; y: number; text: string }[] = []
    for (const [index, feature] of greenRead.features.entries()) {
      if (tags.length >= 2) break
      const [px, py] = project(feature.at)
      const x = Math.min(viewSize - 6, Math.max(6, px))
      const y = Math.min(viewSize - 2, Math.max(3, py))
      if (tags.some((t) => Math.abs(t.x - x) < 11 && Math.abs(t.y - y) < 3)) continue
      tags.push({
        key: `${feature.kind}-${index}`,
        x,
        y,
        text: feature.kind === 'tier' ? `tier \u2191${feature.riseFt.toFixed(1)} ft` : 'spine',
      })
    }
    let arrow: { x1: number; y1: number; x2: number; y2: number; lx: number; ly: number; text: string } | null = null
    if (greenRead.tiltDownhill && greenRead.tiltPercent >= 1) {
      const at = greenRead.features[0]?.at ?? hole.markers.pin ?? [0, 0]
      const [ax, ay] = project(at)
      const [bx, by] = project([at[0] + greenRead.tiltDownhill[0], at[1] + greenRead.tiltDownhill[1]])
      const len = Math.hypot(bx - ax, by - ay) || 1
      const ux = (bx - ax) / len
      const uy = (by - ay) / len
      const size = 6
      // Just outside the green's top-left corner (or top-right if no room).
      const cx = box.minX - 4 >= size / 2 + 1 ? box.minX - 4 : Math.min(viewSize - size / 2 - 1, box.maxX + 4)
      const cy = Math.min(viewSize - size / 2 - 1, Math.max(size / 2 + 3, box.minY + 2))
      arrow = {
        x1: cx - (ux * size) / 2, y1: cy - (uy * size) / 2, x2: cx + (ux * size) / 2, y2: cy + (uy * size) / 2,
        lx: cx, ly: cy + size / 2 + 2.6, text: `${greenRead.tiltPercent.toFixed(1)}%`,
      }
    }
    return { tags, arrow }
  })()

  // Yardage-book numbers: reach / carry for hazards in play on this shot, and
  // front / middle / back of the green on approaches.
  const yardages = useMemo(() => {
    const aimView = toView(candidate?.aimPoint ?? strategyAimPoint ?? target)
    const contours = candidate?.probabilityContours ?? []
    const lateral = contours.reduce((m, c) => Math.max(m, c.lateralRadiusYds), 0)
    const carry = contours.reduce((m, c) => Math.max(m, c.carryRadiusYds), 0)
    const finish = candidate ? Math.hypot(...toView(candidate.meanLanding)) : Math.hypot(...aimView)
    const hazards = viewHole.surfaces.flatMap((surface) =>
      surface.kind === 'bunker' || surface.kind === 'water' || surface.kind === 'penalty'
        ? [{ kind: surface.kind, polygons: surface.polygons }]
        : [])
    const labels = hazardYardages({
      hazards,
      aim: aimView,
      corridorHalfWidthYds: candidate ? lateral + 5 : 20,
      maxReachYds: finish + (candidate ? carry : 0) + 25,
      minReachYds: finish - carry - 40,
    })
    const pinDistance = pinEstimate ? Math.hypot(...toView(pinEstimate)) : Number.POSITIVE_INFINITY
    const green = pinDistance <= 300
      ? greenYardage(viewHole.surfaces.filter((s) => s.kind === 'green').flatMap((s) => s.polygons))
      : null
    return { labels, green }
  }, [toView, viewHole, candidate, strategyAimPoint, target, pinEstimate])

  const placedYardages: { x: number; y: number }[] = []
  const yardageLabels = yardages.labels.flatMap((label) => {
    const [ax, ay] = projectView(label.anchor)
    if (ax < 1 || ax > viewSize - 1 || ay < 1 || ay > viewSize - 1) return []
    const leftward = label.side === 'left' ? ax > 8 : ax > viewSize - 8
    const x = leftward ? ax - 1.2 : ax + 1.2
    const y = Math.min(viewSize - 1.5, ay + 0.7)
    if (placedYardages.some((p) => Math.abs(p.y - y) < 2.6 && Math.abs(p.x - x) < 6)) return []
    placedYardages.push({ x, y })
    return [{ key: `${label.kind}-${label.reachYds}-${label.carryYds}`, kind: label.kind, x, y, leftward, text: String(label.reachYds) }]
  })

  const ballSvg = project(ball)
  const targetSvg = project(target)
  const pinSvg = pinEstimate ? project(pinEstimate) : null
  const aimSvg = candidate ? project(candidate.aimPoint) : null
  const meanSvg = candidate ? project(candidate.meanLanding) : null
  const strategyAimSvg = strategyAimPoint ? project(strategyAimPoint) : null
  const shotDx = (aimSvg?.[0] ?? targetSvg[0]) - ballSvg[0]
  const shotDy = (aimSvg?.[1] ?? targetSvg[1]) - ballSvg[1]
  const shotAngle = (Math.atan2(shotDy, shotDx) * 180) / Math.PI + 90
  const visibleContours = candidate?.probabilityContours.filter(
    (contour) => contour.probability !== 0.95 || show95,
  ) ?? []
  const historical = candidate?.empiricalAllShots?.samples ?? []
  const historicalAverageWeight = historical.length > 0 ? 1 / historical.length : 1
  const tail = candidate?.riskProfile?.tailLandings ?? []
  const tailAverageWeight = candidate?.riskProfile && tail.length > 0
    ? candidate.riskProfile.tailProbability / tail.length
    : 1

  return (
    <div className="live-map-shell">
      <svg className="live-map" viewBox={`0 0 ${viewSize} ${viewSize}`}>
        <defs>
          {/* Tree canopy: deep green with a fine, low-contrast crown texture. */}
          <pattern id="liveWoodsPattern" width="3.2" height="3.2" patternUnits="userSpaceOnUse">
            <rect width="3.2" height="3.2" fill="#13291c" />
            <circle cx="0.8" cy="0.9" r="0.62" fill="#1b3826" />
            <circle cx="2.4" cy="0.6" r="0.5" fill="#1a3524" />
            <circle cx="1.7" cy="2.3" r="0.7" fill="#1c3a27" />
            <circle cx="0.4" cy="2.9" r="0.38" fill="#18321f" />
          </pattern>
          <pattern id="liveScrubPattern" width="3.6" height="3.6" patternUnits="userSpaceOnUse">
            <rect width="3.6" height="3.6" fill="#2b2f1d" />
            <circle cx="0.9" cy="1" r="0.42" fill="#3a3d25" />
            <circle cx="2.6" cy="2.5" r="0.5" fill="#363a23" />
          </pattern>
          <pattern id="liveNativePattern" width="4.8" height="4.8" patternUnits="userSpaceOnUse">
            <rect width="4.8" height="4.8" fill="#3c3d26" />
            <path d="M1 4.8 L1.35 2.15 M2.6 4.8 L2.35 2.75 M4 4.8 L4.25 2.35" stroke="#7d7748" strokeOpacity="0.5" strokeWidth="0.22" />
          </pattern>
          <pattern id="liveDunePattern" width="5.2" height="5.2" patternUnits="userSpaceOnUse">
            <rect width="5.2" height="5.2" fill="#4a4231" />
            <path d="M0 1.5 C1.3 1 2.6 2 5.2 1.35 M0 3.8 C1.7 3.25 3.1 4.2 5.2 3.55" fill="none" stroke="#7d6c4d" strokeOpacity="0.5" strokeWidth="0.22" />
          </pattern>
          {greenRead && greenPolys.length ? (
            <clipPath id="liveGreenClip">
              {greenPolys.map((polygon, index) => (
                <polygon key={index} points={polygon.map((point) => projectView(point).join(',')).join(' ')} />
              ))}
            </clipPath>
          ) : null}
          <marker id="liveTiltArrowHead" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#f3ecd6" />
          </marker>
        </defs>

        {/* Ground outside the hole first (open grass under scrub under trees), */}
        {contextOrder.flatMap((kind) =>
          (hole.contextLayers ?? []).filter((layer) => layer.kind === kind).flatMap((layer) =>
            layer.polygons.map((polygon, index) => (
              <polygon
                key={`${layer.id}-${index}`}
                className={`live-context context-${layer.kind}`}
                points={polygon.map((point) => project(point).join(',')).join(' ')}
              />
            )),
          ),
        )}
        {/* then the built environment, then the golf surfaces, */}
        {featureOrder.flatMap((kind) =>
          (hole.mapFeatures ?? []).filter((feature) => feature.kind === kind).flatMap((feature) => [
            ...(feature.polygons ?? []).map((polygon, index) => (
              <polygon
                key={`${feature.id}-polygon-${index}`}
                className={`live-map-feature map-${feature.kind}`}
                points={polygon.map((point) => project(point).join(',')).join(' ')}
              />
            )),
            ...(feature.lines ?? []).map((line, index) => (
              <polyline
                key={`${feature.id}-line-${index}`}
                className={`live-map-feature map-${feature.kind} map-line`}
                points={line.map((point) => project(point).join(',')).join(' ')}
              />
            )),
          ]),
        )}
        {surfaceOrder.flatMap((kind) =>
          hole.surfaces
            .filter((surface) => surface.kind === kind)
            .flatMap((surface) =>
              surface.polygons.map((polygon, index) => (
                <polygon
                  key={`${surface.id}-${index}`}
                  className={`live-surface surface-${kind}`}
                  points={polygon.map((point) => project(point).join(',')).join(' ')}
                />
              )),
            ),
        )}
        {/* and the terrain's light and shadow over all of it. */}
        {shade ? (
          <image className="live-hillshade" href={shade.dataUrl} x={shade.x} y={shade.y}
            width={shade.width} height={shade.height} preserveAspectRatio="none"
            transform={`matrix(${holeToSvg.join(' ')})`} />
        ) : null}
        {slopeImage && greenOverlay ? (
          <g clipPath="url(#liveGreenClip)">
            <image className="live-green-slope" href={slopeImage.dataUrl} x={slopeImage.x} y={slopeImage.y}
              width={slopeImage.width} height={slopeImage.height} preserveAspectRatio="none"
              transform={`matrix(${holeToSvg.join(' ')})`} />
          </g>
        ) : null}
        {hole.contours?.map((contour, index) => (
          <polyline
            key={`contour-${contour.elevationFt}-${index}`}
            className="live-terrain-contour"
            points={contour.points.map((point) => project(point).join(',')).join(' ')}
          />
        ))}

        {candidate && aimSvg && meanSvg ? (
          <>
            <line className="live-target-line" x1={ballSvg[0]} y1={ballSvg[1]} x2={meanSvg[0]} y2={meanSvg[1]} />
            <line className="live-aim-line" x1={ballSvg[0]} y1={ballSvg[1]} x2={aimSvg[0]} y2={aimSvg[1]} />
            {[...visibleContours].reverse().map((contour) => (
              <ellipse
                key={contour.probability}
                className={`live-probability probability-${Math.round(contour.probability * 100)}`}
                cx={meanSvg[0]}
                cy={meanSvg[1]}
                rx={Math.max(0.4, contour.lateralRadiusYds * scale)}
                ry={Math.max(0.4, contour.carryRadiusYds * scale)}
                transform={`rotate(${shotAngle} ${meanSvg[0]} ${meanSvg[1]})`}
              />
            ))}
            {showRiskTail && tail.map((sample, index) => {
              const point = project(sample.landing)
              return (
                <circle
                  key={`tail-${index}`}
                  className={`live-risk-dot risk-${sample.tier}`}
                  cx={point[0]}
                  cy={point[1]}
                  r={Math.max(0.28, Math.min(0.72, 0.38 * Math.sqrt(sample.weight / Math.max(1e-9, tailAverageWeight))))}
                />
              )
            })}
            {showPracticeShots && historical.map((sample, index) => {
              const point = project(sample.landing)
              return (
                <circle
                  key={`practice-${index}`}
                  className={`live-practice-dot sample-${sample.kind}`}
                  cx={point[0]}
                  cy={point[1]}
                  r={Math.max(0.25, Math.min(0.62, 0.34 * Math.sqrt(sample.weight / historicalAverageWeight))) }
                />
              )
            })}
            <circle className="live-mean-marker" cx={meanSvg[0]} cy={meanSvg[1]} r="1.05" />
            <circle className="live-aim-marker" cx={aimSvg[0]} cy={aimSvg[1]} r="0.82" />
          </>
        ) : null}
        {!candidate && strategyAimSvg ? (
          <>
            <line className="live-aim-line" x1={ballSvg[0]} y1={ballSvg[1]}
              x2={strategyAimSvg[0]} y2={strategyAimSvg[1]} />
            <circle className="live-aim-marker" cx={strategyAimSvg[0]} cy={strategyAimSvg[1]} r="0.9" />
          </>
        ) : null}
        {greenOverlay?.tags.map((tag) => (
          <text key={tag.key} className="live-green-tag" x={tag.x} y={tag.y} textAnchor="middle">{tag.text}</text>
        ))}
        {greenOverlay?.arrow ? (
          <g className="live-green-tilt">
            <line x1={greenOverlay.arrow.x1} y1={greenOverlay.arrow.y1} x2={greenOverlay.arrow.x2} y2={greenOverlay.arrow.y2}
              markerEnd="url(#liveTiltArrowHead)" />
            <text x={greenOverlay.arrow.lx} y={greenOverlay.arrow.ly} textAnchor="middle">{greenOverlay.arrow.text}</text>
          </g>
        ) : null}
        {yardageLabels.map((label) => (
          <text key={label.key} className={`live-map-yardage yardage-${label.kind}`}
            x={label.x} y={label.y} textAnchor={label.leftward ? 'end' : 'start'}>
            <tspan className="yardage-num">{label.text}</tspan>
          </text>
        ))}
        {pinSvg ? <circle className="live-pin-marker" cx={pinSvg[0]} cy={pinSvg[1]} r="0.78" /> : null}
        {provisionalTeeRadiusYds != null ? (
          <circle cx={ballSvg[0]} cy={ballSvg[1]} r={provisionalTeeRadiusYds * scale}
            fill="#dabb6c" fillOpacity={0.10} stroke="#f0c777"
            strokeOpacity={0.72} strokeDasharray="1.2 1" strokeWidth={0.27}/>
        ) : null}
        <circle className="live-ball-marker" cx={ballSvg[0]} cy={ballSvg[1]} r="1.2" />
      </svg>
      {yardages.green ? (
        <div className="live-map-green-yardage" aria-label="Green front, middle and back yardages">
          <span>Green</span>
          <b>F {yardages.green.frontYds}</b>
          <b>M {yardages.green.middleYds}</b>
          <b>B {yardages.green.backYds}</b>
        </div>
      ) : null}
    </div>
  )
}
