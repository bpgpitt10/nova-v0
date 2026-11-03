// Yellow aim = GSPro click: on the aim line at the expected carry, never more
// than 5 yd past the pin (stays on GSPro's minimap).
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
  const { aimClickPoint } = await load('/src/liveCaddie/aimClickPoint.ts')
  // Driver on Valhalla 1 (368 yd): target capped at 220, carry 246, aim 10 yd right.
  const p = aimClickPoint([0, 0], [10, 220], [12, 246], [0, 368])
  assert.ok(Math.abs(Math.hypot(...p) - 246.2) < 1, String(p))
  assert.ok(Math.abs(p[0] / p[1] - 10 / 220) < 1e-9, 'same direction as the recommendation')
  // 8i short of a 174-yd pin: the click sits at the 162 carry, not at the pin.
  const q = aimClickPoint([0, 0], [7, 174], [5, 162], [0, 174])
  assert.ok(Math.abs(Math.hypot(...q) - 162) < 0.5)
  // Carry well past the pin: kept 5 yd past it.
  assert.equal(Math.round(aimClickPoint([0, 0], [0, 150], [0, 190], [0, 150])[1]), 155)
  // No carry known: the recommendation's own point.
  assert.deepEqual(aimClickPoint([0, 0], [3, 100], null, null), [3, 100])
  console.log('PASS: aim click point on the aim line at the expected carry.')
} finally {
  await server?.close()
}
