// GSPro OB from the course file: valued as stroke and distance; the OB ring is
// clipped to the hole, fast to classify, and never covers the tee or green.
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
try {
  const { buildDecisionLandingState } = await load('/src/liveCaddie/decisionLandingState.ts')
  const { evaluateDecisionLandingStateValue } = await load('/src/liveCaddie/nextStateValue.ts')
  const { parseGkdLayout } = await load('/src/courseGeometry/nativeGkd.ts')
  const { gkdHazardSurfaces, withGkdHazards } = await load('/src/courseGeometry/nativeHazards.ts')
  const { classifyPoint } = await load('/src/courseGeometry/geometry.ts')
  const prov = { source: 'osm', confidence: 'high' }

  // 1. Valuation: a 250-yd drive OB on a 420-yd hole is replayed from the tee with a stroke.
  const hole = { holeNumber: 1, markers: { tee: [0, 0], pin: [0, 420] }, surfaces: [
    { id: 'tee', kind: 'tee', polygons: [[[-5, -5], [5, -5], [5, 5], [-5, 5]]], provenance: prov },
  ] }
  const ob = { kind: 'penalty', surfaceId: 'gkd-oob', confidence: 'high' }
  const state = buildDecisionLandingState(hole, [80, 250], ob, [0, 420], [0, 0])
  assert.equal(state.outOfBounds, true)
  assert.equal(Math.round(state.distanceToPinYds), 420)
  assert.equal(state.replaySurface, 'tee')
  const v = evaluateDecisionLandingStateValue(state)
  assert.equal(v.assumption, 'stroke-and-distance')
  const fairway420 = evaluateDecisionLandingStateValue(buildDecisionLandingState(hole, [0, 0], { kind: 'fairway', surfaceId: 'f', confidence: 'high' }, [0, 420]))
  assert.ok(Math.abs(v.expectedStrokes - (fairway420.expectedStrokes + 1)) < 1e-9, `${v.expectedStrokes} vs ${fairway420.expectedStrokes}`)
  // A penalty area (not OB) at the same spot is still relief at the crossing, cheaper.
  const water = evaluateDecisionLandingStateValue(buildDecisionLandingState(hole, [80, 250], { kind: 'penalty', surfaceId: 'gkd-penalty-3', confidence: 'high' }, [0, 420], [0, 0]))
  assert.equal(water.assumption, 'penalty-relief-at-landing-distance')
  assert.ok(v.expectedStrokes > water.expectedStrokes)

  // 2. Geometry: identity-like registration (as in test-gkd-hazards).
  const refLatLon = [37.4778, -77.0271]
  const registration = { schemaVersion: 'looper-native-registration-v1', courseId: 't', gsproCourseKey: 't_gsp',
    layoutFingerprint: '', sceneFingerprint: null, grade: 'A', reference: { latLon: refLatLon, worldXZ: [0, 0] },
    worldYToElevationOffsetM: 0, holes: { 1: { anchorLatLon: refLatLon, headingDegreesTrue: 0 } } }
  const M = 1 / 1.0936133
  const pos = (x, z) => ({ x: x * M, y: 10, z: z * M })
  const view = { minX: -60, minY: -20, maxX: 60, maxY: 420 }
  const geomHole = { holeNumber: 1, courseId: 't', markers: { tee: [0, 0], pin: [0, 400] }, bounds: view, viewBounds: view,
    surfaces: [{ id: 'fw', kind: 'fairway', polygons: [[[-20, 50], [20, 50], [20, 360], [-20, 360]]], provenance: prov }] }
  const layoutWith = (ring) => parseGkdLayout(JSON.stringify({
    Holes: [{ HoleNumber: 1, Par: 4, Tees: [{ TeeType: 'White', Distance: 1, Position: pos(0, 0) }, { TeeType: 'GreenCenterPoint', Position: pos(0, 400) }], Pins: [{ Day: 'D', Position: pos(0, 400) }] }],
    pOOB: { pointCount: ring.length, coords: ring.map(([x, z]) => pos(x, z)) },
  }))
  // Course boundary: a huge box whose right edge runs straight through the frame at x = 100 (no vertex in the frame).
  const boundary = [[-3000, -3000], [100, -3000], [100, 3000], [-3000, 3000]]
  const r = gkdHazardSurfaces(layoutWith(boundary), registration, geomHole)
  assert.equal(r.summary.obMode, 'boundary')
  assert.equal(r.summary.obOnHole, true, 'an edge crossing the frame with no vertex in it still gives OB')
  const merged = withGkdHazards(geomHole, r.surfaces)
  assert.equal(classifyPoint(merged, [120, 200]).kind, 'penalty')
  assert.equal(classifyPoint(merged, [0, 200]).kind, 'fairway')
  assert.ok(r.surfaces[0].polygons[0].length < 40, `clipped OB polygon is small: ${r.surfaces[0].polygons[0].length}`)
  // A boundary that would put the tee out of bounds is wrong for this hole: left off.
  const wrong = [[30, -3000], [3000, -3000], [3000, 3000], [30, 3000]]
  const layoutWrong = parseGkdLayout(JSON.stringify({
    Holes: [{ HoleNumber: 1, Par: 4, Tees: [{ TeeType: 'White', Distance: 1, Position: pos(0, 0) }, { TeeType: 'GreenCenterPoint', Position: pos(500, 400) }], Pins: [{ Day: 'D', Position: pos(500, 400) }] },
      { HoleNumber: 2, Par: 4, Tees: [], Pins: [{ Day: 'D', Position: pos(600, 400) }] }],
    pOOB: { pointCount: 4, coords: wrong.map(([x, z]) => pos(x, z)) },
  }))
  const w = gkdHazardSurfaces(layoutWrong, registration, geomHole)
  assert.equal(w.summary.obOnHole, false)
  assert.equal(w.summary.obSkipped, true)
  // Speed: a 1,500-vertex course boundary must not slow classification much.
  const ring = Array.from({ length: 1500 }, (_, i) => { const t = 2 * Math.PI * i / 1500; const rr = 1500 + 15 * Math.sin(37 * t); return [-1440 + rr * Math.cos(t), 200 + rr * Math.sin(t)] })
  const big = gkdHazardSurfaces(layoutWith(ring), registration, geomHole)
  const bigHole = withGkdHazards(geomHole, big.surfaces)
  const pts = Array.from({ length: 100_000 }, (_, i) => [((i * 7919) % 120) - 60, (i * 104729) % 420])
  const t0 = performance.now(); for (const p of pts) classifyPoint(geomHole, p); const base = performance.now() - t0
  const t1 = performance.now(); for (const p of pts) classifyPoint(bigHole, p); const withOb = performance.now() - t1
  assert.ok(withOb < base * 4 + 50, `OB classification ${withOb.toFixed(0)} ms vs ${base.toFixed(0)} ms`)
  console.log(`PASS: OB valued as stroke and distance; OB clipped (${r.surfaces[0].polygons[0].length} vertices), safe, fast (${withOb.toFixed(0)} vs ${base.toFixed(0)} ms / 100k).`)
} finally {
  await server?.close()
}
