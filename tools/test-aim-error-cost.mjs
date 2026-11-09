// An estimated pin's aim error is priced by the engine, not a fixed yardage (11/9).
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
  const { priceAimError, AIM_ERROR_MAX_COST_STROKES } = await load('/src/liveCaddie/aimErrorCost.ts')
  const cand = (offset, strokes, catastrophe = 0) => ({
    aimOffsetYds: offset, score: null, riskProfile: { catastrophe }, stateValue: { expectedFutureStrokes: strokes },
  })
  // A drive to a wide fairway: strokes barely move across 12 yd either side.
  const wide = [-15, -12, -9, -6, -3, 0, 3, 6, 9, 12, 15].map((o) => cand(o, 3.80 + Math.abs(o) * 0.001))
  const drive = priceAimError({ candidates: wide, chosenOffsetYds: 0, errorYds: 5 })
  assert.equal(drive.affordable, true, JSON.stringify(drive))
  assert.ok(drive.strokes < AIM_ERROR_MAX_COST_STROKES)
  // An approach with water left: 5 yd left costs a third of a stroke.
  const water = [-9, -6, -3, 0, 3, 6, 9].map((o) => cand(o, o < 0 ? 3.0 + (-o) * 0.08 : 3.0 + o * 0.005, o <= -6 ? 0.25 : 0))
  const approach = priceAimError({ candidates: water, chosenOffsetYds: 0, errorYds: 5 })
  assert.equal(approach.affordable, false)
  assert.equal(approach.reason, 'too-costly')
  assert.ok(Math.abs(approach.strokes - 0.4) < 1e-9, approach.strokes)
  // Catastrophe alone can refuse it, even when strokes look flat.
  const cliff = [-6, -3, 0, 3, 6].map((o) => cand(o, 3.0, o === -6 ? 0.05 : 0))
  assert.equal(priceAimError({ candidates: cliff, chosenOffsetYds: 0, errorYds: 6 }).affordable, false)
  // Beyond the aim grid there is nothing to price: refuse.
  assert.equal(priceAimError({ candidates: wide, chosenOffsetYds: 12, errorYds: 5 }).reason, 'off-the-grid')
  // Interpolation between grid points: 4.5 yd sits between the 3 and 6 columns.
  const ramp = [-6, -3, 0, 3, 6].map((o) => cand(o, 3.0 + Math.max(0, o) * 0.01))
  const mid = priceAimError({ candidates: ramp, chosenOffsetYds: 0, errorYds: 4.5 })
  assert.ok(Math.abs(mid.strokes - 0.045) < 1e-9, mid.strokes)
  console.log('aim error cost ok')
} finally {
  if (server) await server.close()
}
