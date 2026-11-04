// Out of reach of the green, each club plans around the fairway centre at its
// own carry (not one shared min(220, 65%) spot).
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
  const { clubLayupTarget } = await load('/src/liveCaddie/aimOptimization.ts')
  // Dogleg right: fairway runs straight to 200 yd, then bends right.
  const fairway = [[-15, 150], [15, 150], [20, 200], [45, 240], [70, 280], [40, 290], [15, 250], [-10, 205]]
  const hole = { surfaces: [{ id: 'fw', kind: 'fairway', polygons: [fairway], provenance: { source: 'osm', confidence: 'high' } }] }
  const ball = [0, 0]
  const pin = [60, 420]
  const driver = clubLayupTarget(hole, ball, pin, 250)
  const iron = clubLayupTarget(hole, ball, pin, 180)
  assert.ok(driver && iron)
  // Each target is at its club's carry from the ball (on the carry circle), on fairway.
  assert.ok(Math.abs(Math.hypot(...driver) - 250) < 0.01, String(driver))
  assert.ok(Math.abs(Math.hypot(...iron) - 180) < 0.01, String(iron))
  assert.ok(driver[0] > 25, `driver target follows the dogleg right: ${driver}`)
  assert.ok(Math.abs(iron[0]) < 10, `iron target on the straight part, off the edge: ${iron}`)
  // Never past the pin.
  const long = clubLayupTarget(hole, ball, [0, 230], 300)
  assert.ok(Math.hypot(...long) <= 230 + 1e-9)

  // RNK 2: straight down the pin line at 220 is woods; the fairway arc at that
  // distance is 25° right. The old forward-slice rule returned the woods.
  {
    const r = 220
    const arc = []
    for (let deg = 12; deg <= 38; deg += 2) arc.push([Math.sin(deg * Math.PI / 180) * (r - 15), Math.cos(deg * Math.PI / 180) * (r - 15)])
    for (let deg = 38; deg >= 12; deg -= 2) arc.push([Math.sin(deg * Math.PI / 180) * (r + 15), Math.cos(deg * Math.PI / 180) * (r + 15)])
    const woods = [[-30, 150], [30, 150], [30, 260], [-30, 260]]
    const dogleg = {
      surfaces: [{ id: 'fw', kind: 'fairway', polygons: [arc], provenance: { source: 'osm', confidence: 'high' } }],
      contextLayers: [{ id: 'w', kind: 'woods', polygons: [woods], provenance: { source: 'osm', confidence: 'high' } }],
    }
    const target = clubLayupTarget(dogleg, [0, 0], [0, 500], r)
    const deg = Math.atan2(target[0], target[1]) * 180 / Math.PI
    assert.ok(deg > 14 && deg < 36, `target on the fairway arc, ${deg.toFixed(1)}° right: ${target}`)
    assert.ok(Math.abs(Math.hypot(...target) - r) < 0.01)
  }
  console.log('PASS: per-club lay-up targets on the carry circle, on fairway, off its edge; doglegs find the fairway arc.')
} finally {
  await server?.close()
}
