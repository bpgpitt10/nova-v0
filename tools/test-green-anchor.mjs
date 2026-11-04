// Green anchored to GSPro's green (spec: claude/spec-green-anchored-to-gkd.md).
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
  const { anchorGreenToGkd, clipToConvex, circleRing, greenAnchorLine } = await load('/src/courseGeometry/nativeGreenAnchor.ts')
  const { classifyPoint, pointInPolygon } = await load('/src/courseGeometry/geometry.ts')

  // Identity-like registration (as in test-gkd-hazards): local yards = world metres × 1.0936.
  const refLatLon = [37.4778, -77.0271]
  const registration = {
    schemaVersion: 'looper-native-registration-v1', courseId: 'test', gsproCourseKey: 'test_gsp',
    layoutFingerprint: '', sceneFingerprint: null, grade: 'A',
    reference: { latLon: refLatLon, worldXZ: [0, 0] }, worldYToElevationOffsetM: 0,
    holes: { 1: { anchorLatLon: refLatLon, headingDegreesTrue: 0 } },
  }
  const YD = 1.0936133
  const M = 1 / YD
  const pos = (xYd, zYd) => ({ x: xYd * M, y: 10, z: zYd * M })
  const layoutWith = (centre, pins) => parseGkdLayout(JSON.stringify({
    CourseName: 'Synthetic',
    Holes: [{
      HoleNumber: 1, Par: 3,
      Tees: [{ TeeType: 'White', Distance: 150, Position: pos(0, 0) },
        ...(centre ? [{ TeeType: 'GreenCenterPoint', Position: pos(...centre) }] : [])],
      Pins: pins.map((p, i) => ({ Day: `D${i}`, Position: pos(...p) })),
    }],
  }))
  // RNK 3-like OSM green: 26 yd wide, 56 yd deep (144–200), apron included.
  const osmGreen = [[-13, 144], [13, 144], [13, 200], [-13, 200]]
  const holeWith = (green) => ({
    holeNumber: 1, courseId: 'test', bounds: { minX: -60, minY: -20, maxX: 60, maxY: 230 },
    surfaces: [
      { id: 'osm-green', kind: 'green', polygons: [green], provenance: { source: 'osm', confidence: 'high' } },
      { id: 'osm-fairway', kind: 'fairway', polygons: [[[-20, 60], [20, 60], [20, 140], [-20, 140]]], provenance: { source: 'osm', confidence: 'high' } },
    ],
  })
  const ringDepth = (ring) => Math.max(...ring.map((p) => p[1])) - Math.min(...ring.map((p) => p[1]))
  const greenOf = (surfaces) => surfaces.find((s) => s.kind === 'green').polygons[0]

  // 1. GSPro centre 10 yd off the OSM centroid (172 → 162), 4 pins within 11 yd.
  {
    const pins = [[0, 152], [6, 160], [-5, 168], [3, 171]]
    const r = anchorGreenToGkd(holeWith(osmGreen), layoutWith([0, 162], pins), registration)
    assert.equal(r.summary.status, 'anchored')
    assert.ok(Math.abs(r.summary.shiftYds - 10) < 0.6, `shift ${r.summary.shiftYds}`)
    const g = greenOf(r.surfaces)
    for (const p of pins) assert.ok(pointInPolygon(p, g), `pin ${p} on the green`)
    assert.ok(ringDepth(g) <= 2 * r.summary.radiusYds + 0.1 && ringDepth(g) < 45, `depth ${ringDepth(g)}`)
    assert.ok(r.surfaces.some((s) => s.id === 'green-apron-1' && s.kind === 'fairway'), 'apron kept as fairway')
    const hole = { ...holeWith(osmGreen), surfaces: r.surfaces }
    assert.equal(classifyPoint(hole, [0, 162]).kind, 'green')
    // Old OSM front edge (translated: 134 + a bit) is apron now, not green.
    assert.equal(classifyPoint(hole, [0, 137]).kind, 'fairway')
    assert.match(greenAnchorLine(r.summary), /anchored to GSPro \(shift 10 yd/)
  }
  // 2. Centre 2 yd off: no translation, only the clip.
  {
    const r = anchorGreenToGkd(holeWith(osmGreen), layoutWith([0, 170], [[0, 165], [4, 175]]), registration)
    assert.equal(r.summary.status, 'anchored')
    assert.equal(r.summary.shiftYds, 0)
    assert.ok(ringDepth(greenOf(r.surfaces)) < ringDepth(osmGreen))
  }
  // 3. Centre 40 yd away: left alone, flagged.
  {
    const r = anchorGreenToGkd(holeWith(osmGreen), layoutWith([0, 212], [[0, 212]]), registration)
    assert.equal(r.summary.status, 'unanchored')
    assert.equal(r.surfaces, null)
    assert.match(greenAnchorLine(r.summary), /check the registration/)
  }
  // 4. A pin 20 yd from the centre: the radius grows until it's on the green.
  {
    const pins = [[0, 172], [0, 192]]
    const r = anchorGreenToGkd(holeWith(osmGreen), layoutWith([0, 172], pins), registration)
    assert.equal(r.summary.status, 'anchored')
    for (const p of pins) {
      const g = greenOf(r.surfaces)
      const near = pointInPolygon(p, g) || g.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 3)
      assert.ok(near, `pin ${p} kept`)
    }
    assert.ok(r.summary.radiusYds >= 20)
  }
  // 5. No OSM green: nothing changes.
  {
    const hole = { ...holeWith(osmGreen), surfaces: holeWith(osmGreen).surfaces.filter((s) => s.kind !== 'green') }
    const r = anchorGreenToGkd(hole, layoutWith([0, 170], [[0, 170]]), registration)
    assert.equal(r.summary.status, 'no-osm-green')
    assert.equal(r.surfaces, null)
  }
  // No green centre in the GKD: the pins' centroid stands in.
  {
    const r = anchorGreenToGkd(holeWith(osmGreen), layoutWith(null, [[0, 160], [4, 166]]), registration)
    assert.equal(r.summary.status, 'anchored')
  }
  // A small, legitimate OSM green fully inside the disk is kept as drawn (not swapped for a disk).
  {
    const small = [[-8, 160], [8, 160], [8, 180], [-8, 180]]
    const r = anchorGreenToGkd(holeWith(small), layoutWith([0, 170], [[0, 165], [3, 174]]), registration)
    assert.equal(r.summary.disk, false)
    assert.equal(r.surfaces.some((s) => s.id === 'green-apron-1'), false, 'nothing trimmed, no apron')
  }
  // Clipper sanity: a square clipped to a circle inside it is the circle.
  {
    const c = clipToConvex([[-50, -50], [50, -50], [50, 50], [-50, 50]], circleRing([0, 0], 10))
    assert.equal(c.length, 48)
  }
  console.log('PASS: OSM green anchored to GSPro green centre and pins; apron kept; far/missing cases left alone.')
} finally {
  await server?.close()
}
