// The three aim-line pills on the shot map: Best, 2nd best (6+ yd away), Safest.
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
  const { pickAimLineOptions } = await load('/src/liveCaddie/aimLineOptions.ts')
  const cand = (aimOffsetYds, strokes, catastrophe = 0, seriousTrouble = 0.1) => ({
    aimOffsetYds, modeledSamples: [], riskProfile: { catastrophe, seriousTrouble, unknown: 0 },
    stateValue: { expectedFutureStrokes: strokes },
  })
  const keys = (options) => options.map((o) => `${o.key}${o.alsoSafest ? '+safe' : ''}@${o.aimOffsetYds}`)

  // 1. 2nd best is the next-lowest strokes at least 6 yd away, not the neighbour 3 yd over.
  {
    const c = [cand(-6, 3.10), cand(-3, 3.02), cand(0, 3.00), cand(3, 3.01), cand(6, 3.05), cand(9, 3.20)]
    const options = pickAimLineOptions(c, c[2])
    assert.deepEqual(keys(options), ['best+safe@0', 'second@6'])
    assert.ok(Math.abs(options[1].costStrokes - 0.05) < 1e-9)
  }
  // 2. Water right: safest is the line that takes water out, even though it costs more.
  {
    const c = [cand(-12, 3.30, 0.00), cand(-6, 3.12, 0.03), cand(0, 3.00, 0.08), cand(6, 3.06, 0.14)]
    assert.deepEqual(keys(pickAimLineOptions(c, c[2])), ['best@0', 'second@6', 'safest+safe@-12'])
  }
  // 3. One line is both 2nd best and safest: shown once.
  {
    const c = [cand(-6, 3.04, 0.01), cand(0, 3.00, 0.08), cand(6, 3.30, 0.15)]
    assert.deepEqual(keys(pickAimLineOptions(c, c[1])), ['best@0', 'second+safe@-6'])
  }
  // 4. No water anywhere: a line with clearly less serious trouble is the safe one.
  {
    const c = [cand(-9, 3.08, 0, 0.05), cand(0, 3.00, 0, 0.20), cand(9, 3.04, 0, 0.22)]
    assert.deepEqual(keys(pickAimLineOptions(c, c[1])), ['best@0', 'second@9', 'safest+safe@-9'])
  }
  // 5. Less trouble but more water is not "safest".
  {
    const c = [cand(-9, 3.08, 0.06, 0.02), cand(0, 3.00, 0.02, 0.20)]
    assert.deepEqual(keys(pickAimLineOptions(c, c[1])), ['best+safe@0', 'second@-9'])
  }
  // 6. Nothing 6 yd away, or no best: just Best, or nothing.
  {
    const c = [cand(0, 3.00), cand(3, 3.01)]
    assert.deepEqual(keys(pickAimLineOptions(c, c[0])), ['best+safe@0'])
    assert.deepEqual(pickAimLineOptions(c, null), [])
    assert.deepEqual(pickAimLineOptions([{ aimOffsetYds: 0, modeledSamples: [], riskProfile: null }], { aimOffsetYds: 0 }), [])
  }
  console.log('aim line options: ok')
} finally {
  await server?.close()
}
