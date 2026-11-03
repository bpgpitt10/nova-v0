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
  const hole = { surfaces: [{ kind: 'fairway', polygons: [fairway] }] }
  const ball = [0, 0]
  const pin = [60, 420]
  const driver = clubLayupTarget(hole, ball, pin, 250)
  const iron = clubLayupTarget(hole, ball, pin, 180)
  assert.ok(driver && iron)
  // Each target is at its club's depth, on that depth's fairway centre.
  assert.ok(Math.abs(driver[1] - 250 * 420 / Math.hypot(60, 420)) < 0.01, String(driver))
  assert.ok(driver[0] > 25, `driver target follows the dogleg right: ${driver}`)
  assert.ok(Math.abs(iron[0]) < 8, `iron target on the straight part: ${iron}`)
  // Never past the pin.
  const long = clubLayupTarget(hole, ball, [0, 230], 300)
  assert.ok(long[1] <= 230 + 1e-9)
  console.log('PASS: per-club lay-up targets follow the fairway at each club\'s carry.')
} finally {
  await server?.close()
}
