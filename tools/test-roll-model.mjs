// Roll by surface and slope at touchdown (spec: claude/spec-long-shot-engine.md, piece 5).
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
  const { makeRollLandingTransform, rollSlopeFactor } = await load('/src/liveCaddie/rollModel.ts')
  const { sampleModeledAimDistribution } = await load('/src/liveCaddie/aimOutcomeSampling.ts')
  const prov = { source: 'osm', confidence: 'high' }
  // Terrain: flat at x < 0; at x >= 0 a 10% upslope along +y starting at y = 200.
  const spacing = 2, minX = -60, minY = 0, width = 61, height = 201
  const values = new Uint16Array(width * height)
  for (let r = 0; r < height; r += 1) for (let c = 0; c < width; c += 1) {
    const x = minX + c * spacing, y = minY + r * spacing
    const ft = x >= 0 && y >= 200 ? (y - 200) * 3 * 0.10 : 0
    values[r * width + c] = Math.round(ft * 10)
  }
  const terrain = { source: 'lidar-dem', sourceResolutionMeters: 1, runtimeSpacingYds: spacing, interpolation: 'bilinear',
    minX, minY, width, height, elevationOffsetFt: 100, nodata: 65535, values }
  const hole = {
    holeNumber: 1, markers: { tee: [0, 0], pin: [0, 400] }, terrain,
    surfaces: [
      { id: 'fw-flat', kind: 'fairway', polygons: [[[-40, 150], [-10, 150], [-10, 300], [-40, 300]]], provenance: prov },
      { id: 'fw-slope', kind: 'fairway', polygons: [[[10, 150], [40, 150], [40, 300], [10, 300]]], provenance: prov },
      { id: 'rough', kind: 'rough', polygons: [[[-60, 150], [-40, 150], [-40, 300], [-60, 300]]], provenance: prov },
    ],
  }
  const roll = makeRollLandingTransform(hole)
  const rollAt = (x) => {
    const carry = [x, 230], baseline = [x, 248]
    const landed = roll(carry, baseline)
    return Math.hypot(landed[0] - carry[0], landed[1] - carry[1])
  }
  assert.ok(Math.abs(rollAt(-25) - 18) < 0.05, `fairway, flat: ${rollAt(-25)}`)
  assert.ok(Math.abs(rollAt(-50) - 6.3) < 0.05, `rough: ${rollAt(-50)}`)
  assert.ok(Math.abs(rollAt(25) - 10.8) < 0.3, `fairway, 10% upslope: ${rollAt(25)}`)
  // Downhill adds roll, capped at 1.6x; a wall stops it at 10%.
  assert.equal(rollSlopeFactor(-0.1).toFixed(2), '1.40')
  assert.equal(rollSlopeFactor(-1), 1.6)
  assert.equal(rollSlopeFactor(0.5), 0.1)
  // Inner transform (green rollout) receives the scaled baseline.
  let seen = null
  const wrapped = makeRollLandingTransform(hole, (c, b) => { seen = b; return b })
  wrapped([-50, 230], [-50, 248])
  assert.ok(Math.abs(seen[1] - (230 + 6.3)) < 0.05)

  // Through the sampler: the same shot rolls less when it lands in rough.
  const shot = (aimX) => sampleModeledAimDistribution({
    hole, ball: [aimX, 0], aimPoint: [aimX, 230], carryMeanYds: 230, totalMeanYds: 248, lateralMeanYds: 0,
    carrySigmaYds: 4, lateralSigmaYds: 2, pinLocalYds: [0, 400], landingTransform: roll,
  })
  const meanRoll = (s) => s.samples.reduce((a, q) => a + Math.hypot(q.landing[0] - q.carryLanding[0], q.landing[1] - q.carryLanding[1]), 0) / s.samples.length
  const fw = shot(-25), rough = shot(-50)
  assert.ok(meanRoll(fw) > 17 && meanRoll(fw) < 19, `fairway mean roll ${meanRoll(fw)}`)
  assert.ok(meanRoll(rough) < 8, `rough mean roll ${meanRoll(rough)}`)
  assert.ok(fw.samples.every((q) => Math.abs(q.stockRollYds - 18) < 1e-9), 'stock roll kept per sample')
  console.log('PASS: roll scaled by touchdown surface and slope (18 / 6.3 / 10.8 yd); stock roll kept for the tail.')
} finally {
  await server?.close()
}
