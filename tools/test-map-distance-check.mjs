// node tools/test-map-distance-check.mjs
import assert from 'node:assert/strict'
let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
const { mapDistanceDisagrees: off } = await load('/src/liveCaddie/mapDistanceCheck.ts')
// Purbeck: GSPro's par 3 distances against a map distance near 300.
for (const gspro of [158, 124, 169, 156]) assert.equal(off(300, gspro), true)
// Agreement, and small differences (pin slot, rounding).
assert.equal(off(158, 157.8), false)
assert.equal(off(170, 158), false)
assert.equal(off(492, 497), false)
// Dogleg: GSPro's route distance is longer than the straight line.
assert.equal(off(342, 371), false)
// Map far shorter than GSPro: wrong tee the other way.
assert.equal(off(250, 420), true)
// Just past the limit either way.
assert.equal(off(158 + 25, 158), true)
assert.equal(off(400 + 61, 400), true)
assert.equal(off(400 + 59, 400), false)
// Nothing to compare, or a chip-length distance: never holds the pick.
assert.equal(off(null, 158), false)
assert.equal(off(158, null), false)
assert.equal(off(120, 30), false)
console.log('map distance check ok')
await server?.close()
