// GSPro's penalty areas and OB (from the GKD) become Looper surfaces on the
// hole, through the registration; island greens keep their green.
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
  const { parseGkdLayout } = await load('/src/courseGeometry/nativeGkd.ts')
  const { gkdHazardSurfaces, outOfBoundsMode, ringWithHoles, withGkdHazards } = await load('/src/courseGeometry/nativeHazards.ts')
  const { classifyPoint, pointInPolygon } = await load('/src/courseGeometry/geometry.ts')

  // Registration: GSPro world metres == ground metres, hole 1 anchored at the
  // reference point heading north, so hole-local yards = world metres × 1.0936.
  const refLatLon = [37.4778, -77.0271]
  const registration = {
    schemaVersion: 'looper-native-registration-v1', courseId: 'test', gsproCourseKey: 'test_gsp',
    layoutFingerprint: '', sceneFingerprint: null, grade: 'A',
    reference: { latLon: refLatLon, worldXZ: [0, 0] }, worldYToElevationOffsetM: 0,
    holes: { 1: { anchorLatLon: refLatLon, headingDegreesTrue: 0 } },
  }
  const YD = 1.0936133
  const pos = (x, z, y = 10) => ({ x, y, z })
  const sq = (x0, z0, x1, z1) => ({ pointCount: 4, coords: [pos(x0, z0), pos(x1, z0), pos(x1, z1), pos(x0, z1)] })
  const gkd = {
    CourseName: 'Synthetic', Location: 'Nowhere, VA', CourseLat: 37.4778, CourseLong: -77.0271,
    Holes: [{
      HoleNumber: 1, Par: 4,
      Tees: [{ TeeType: 'White', Distance: 150, Position: pos(0, 0) }, { TeeType: 'GreenCenterPoint', Position: pos(0, 150) }],
      Pins: [{ Day: 'Thursday', Position: pos(0, 150) }],
    }],
    Hazards: [
      // Creek left of the fairway, hole 1.
      { ...sq(-40, 40, -30, 120), freeDrop: false, innerOOB: false, islandGreen: false, hasDZ: false },
      // Water around the green (island green): encloses the pin.
      { ...sq(-30, 120, 30, 180), freeDrop: false, innerOOB: false, islandGreen: true, hasDZ: false },
      // Internal OB (a road) far away on another hole: not on this hole.
      { ...sq(800, 800, 820, 900), freeDrop: false, innerOOB: true, islandGreen: false, hasDZ: false },
    ],
    pOOB: sq(-100, -50, 100, 400),
  }
  const layout = parseGkdLayout(JSON.stringify(gkd))
  assert.equal(layout.penaltyAreas.length, 3)
  assert.equal(layout.outOfBounds.length, 4)
  assert.deepEqual(layout.courseLatLon, [37.4778, -77.0271])
  assert.equal(layout.location, 'Nowhere, VA')
  assert.equal(outOfBoundsMode(layout), 'boundary', 'green centre inside pOOB: it is the course boundary')

  const green = [[-10 * YD, 140 * YD], [10 * YD, 140 * YD], [10 * YD, 160 * YD], [-10 * YD, 160 * YD]]
  const hole = {
    holeNumber: 1, courseId: 'test', bounds: { minX: -60, minY: -20, maxX: 60, maxY: 200 },
    viewBounds: { minX: -60, minY: -20, maxX: 60, maxY: 200 },
    surfaces: [
      { id: 'osm-green', kind: 'green', polygons: [green], provenance: { source: 'osm', confidence: 'high' } },
      { id: 'osm-fairway', kind: 'fairway', polygons: [[[-20, 20], [20, 20], [20, 130], [-20, 130]]], provenance: { source: 'osm', confidence: 'high' } },
    ],
  }
  const { surfaces, summary } = gkdHazardSurfaces(layout, registration, hole)
  assert.equal(summary.penaltyAreas, 2, 'creek and island water; the far road is not on this hole')
  assert.equal(summary.innerOob, 0)
  assert.equal(summary.obMode, 'boundary')
  assert.ok(summary.obOnHole)
  const merged = withGkdHazards(hole, surfaces)

  // The creek (world x -35, z 80 -> local yards) classifies as penalty, beating OSM fairway/rough.
  assert.equal(classifyPoint(merged, [-35 * YD, 80 * YD]).kind, 'penalty')
  // Fairway next to it is still fairway.
  assert.equal(classifyPoint(merged, [0, 80 * YD]).kind, 'fairway')
  // The island green: water around it is penalty, the green itself stays green.
  assert.equal(classifyPoint(merged, [20 * YD, 150 * YD]).kind, 'penalty')
  assert.equal(classifyPoint(merged, [0, 150 * YD]).kind, 'green')
  // Beyond the course boundary (x = 120 m) is OB (penalty); inside the boundary near the edge is not.
  assert.equal(classifyPoint(merged, [120 * YD, 50 * YD]).kind, 'penalty')
  assert.equal(classifyPoint(merged, [90 * YD, 50 * YD]).kind, 'unknown')
  assert.ok(merged.surfaces.find((s) => s.id === 'gkd-oob'))

  // ringWithHoles: outer minus hole under ray casting.
  const donut = ringWithHoles([[0, 0], [10, 0], [10, 10], [0, 10]], [[[4, 4], [6, 4], [6, 6], [4, 6]]])
  assert.equal(pointInPolygon([5, 5], donut), false)
  assert.equal(pointInPolygon([2, 2], donut), true)
  assert.equal(pointInPolygon([8, 8], donut), true)

  // pOOB drawn as an OB region (no green centre inside): inside = OB.
  const regionLayout = parseGkdLayout(JSON.stringify({ ...gkd, pOOB: sq(200, 200, 300, 300) }))
  assert.equal(outOfBoundsMode(regionLayout), 'region')

  console.log('PASS: GSPro penalty areas and OB placed on the hole; island greens keep their green.')
} finally {
  await server?.close()
}
