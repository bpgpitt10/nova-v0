// Where the descending ball meets the terrain (spec: claude/spec-long-shot-engine.md, piece 4).
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
  const { descentTouchdown, makeRollLandingTransform } = await load('/src/liveCaddie/rollModel.ts')
  const prov = { source: 'osm', confidence: 'high' }
  const grid = (heightFt) => {
    const spacing = 1, minX = -20, minY = 0, width = 41, height = 301
    const values = new Uint16Array(width * height)
    for (let r = 0; r < height; r += 1) for (let c = 0; c < width; c += 1) values[r * width + c] = Math.round((100 + heightFt(minY + r * spacing)) * 10)
    return { source: 'lidar-dem', sourceResolutionMeters: 1, runtimeSpacingYds: spacing, interpolation: 'bilinear', minX, minY, width, height, elevationOffsetFt: 0, nodata: 65535, values }
  }
  const fairway = { id: 'fw', kind: 'fairway', polygons: [[[-20, 0], [20, 0], [20, 300], [-20, 300]]], provenance: prov }
  const C = 230
  // Flat: the ball comes down at its carry.
  {
    const hole = { holeNumber: 1, terrain: grid(() => 0), surfaces: [fairway] }
    const t = descentTouchdown(hole, [0, C], { ball: [0, 0], descentDeg: 45, refElevationFt: 100 })
    assert.deepEqual(t.point, [0, C])
    assert.equal(t.intoSlope, false)
  }
  // A 25% face rising from 12 yd short of the carry: at 45° the ball meets it ~2.4 yd short, into the slope.
  const face = (y) => (y > C - 12 ? 0.25 * (y - (C - 12)) * 3 : 0)
  {
    const hole = { holeNumber: 1, terrain: grid(face), surfaces: [fairway] }
    const t = descentTouchdown(hole, [0, C], { ball: [0, 0], descentDeg: 45, refElevationFt: 100 })
    assert.ok(t.shortenedYds >= 2 && t.shortenedYds <= 3, `shortened ${t.shortenedYds}`)
    assert.equal(t.intoSlope, true)
    // A shallower Driver descent meets the face a little earlier.
    const driver = descentTouchdown(hole, [0, C], { ball: [0, 0], descentDeg: 35, refElevationFt: 100 })
    assert.ok(driver.shortenedYds >= t.shortenedYds, `${driver.shortenedYds} vs ${t.shortenedYds}`)
    // Into the slope: roll is 10% of stock (18 -> 1.8) from the touchdown.
    const roll = makeRollLandingTransform(hole, undefined, { ball: [0, 0], descentDeg: 45, refElevationFt: 100 })
    const rest = roll([0, C], [0, C + 18])
    assert.ok(rest[1] < C, `comes to rest short of the carry point: ${rest}`)
    assert.ok(Math.abs(rest[1] - (t.point[1] + 1.8)) < 0.05, String(rest))
  }
  // No descent angle: carry point, normal roll.
  {
    const hole = { holeNumber: 1, terrain: grid(face), surfaces: [fairway] }
    assert.deepEqual(descentTouchdown(hole, [0, C], null).point, [0, C])
  }
  // Ground below the modeled landing (downhill beyond): never lengthened in v1.
  {
    const hole = { holeNumber: 1, terrain: grid((y) => (y > 200 ? -(y - 200) * 0.3 : 0)), surfaces: [fairway] }
    const t = descentTouchdown(hole, [0, C], { ball: [0, 0], descentDeg: 40, refElevationFt: 100 })
    assert.deepEqual(t.point, [0, C])
  }
  console.log('PASS: descent meets the terrain: hill faces stop the ball short, into the slope; flat and downhill unchanged.')
} finally {
  await server?.close()
}
