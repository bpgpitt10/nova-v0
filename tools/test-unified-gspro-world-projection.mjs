import assert from 'node:assert/strict'
import { createServer } from 'vite'

// Actual FarmLinks White H1 completed shot is preserved as numeric evidence.
// OSM course heading is independent of GSPro world coordinates and GSPro's
// separately displayed Offline(raw) 3.9 yd crosschecks the lateral sign.
const vite = await createServer({
  appType: 'custom', logLevel: 'silent', server: { middlewareMode: true },
})
const cache = new Map()
globalThis.window = {
  localStorage: {
    getItem: key => cache.get(key) ?? null,
    setItem: (key, val) => cache.set(key, String(val)),
    removeItem: key => cache.delete(key),
  },
  dispatchEvent: () => true,
}
globalThis.CustomEvent ??= class CustomEvent {
  constructor(type, opts = {}) { this.type = type; this.detail = opts.detail }
}
try {
  const { gsproWorldDeltaToHoleLocal, projectGsproWorldPointToHole } =
    await vite.ssrLoadModule('/src/courseGeometry/gsproWorldCourseProjection.ts')
  const { saveLiveTeeSessionAnchor, loadLiveTeeSessionAnchor } =
    await vite.ssrLoadModule('/src/courseGeometry/liveTeeSessionAnchor.ts')
  const { startLiveCaddieRound } =
    await vite.ssrLoadModule('/src/liveCaddie/roundRuntime.ts')
  const from = { x: 1184.93384, z: 764.004639 }
  const to = { x: 1165.77637, z: 970.815369 }
  const actual = gsproWorldDeltaToHoleLocal(from, to, 353.715216)
  assert.ok(actual)
  assert.ok(Math.abs(actual[0] - 3.9341) < .06, 'independent GSPro offline 3.9yd')
  assert.ok(Math.abs(actual[1] - 227.1052) < .06, 'GSPro total 227.1yd')
  assert.ok(Math.abs(Math.hypot(...actual) - 227.1) < .1)
  const expected = [-37.351 + actual[0], 78.434 + actual[1]]
  const local = projectGsproWorldPointToHole([-37.351, 78.434], from, to, 353.715216)
  assert.ok(local)
  assert.ok(Math.hypot(local[0]-expected[0], local[1]-expected[1]) < .001)
  assert.equal(gsproWorldDeltaToHoleLocal(from, to, Number.NaN), null)
  assert.equal(gsproWorldDeltaToHoleLocal(from, to, 353, 35), null)
  assert.equal(projectGsproWorldPointToHole([Number.NaN, 0], from, to, 353), null)

  const round = startLiveCaddieRound({ courseId: 'farmlinks-pursell-farms-sylacauga-al', teeSet: 'White' })
  assert.ok(round)
  const hypothesis = saveLiveTeeSessionAnchor(round, {
    holeNumber: 1,
    point: [-37.351, 78.434],
    measuredStraightToPinYds: 489,
    uncertaintyRadiusYds: 25,
    source: 'native-distance-matched-osm-tee',
  })
  assert.ok(hypothesis)
  assert.deepEqual(loadLiveTeeSessionAnchor(round, 1)?.point, [-37.351,78.434])
  assert.equal(loadLiveTeeSessionAnchor(round, 2), null)
  assert.equal(loadLiveTeeSessionAnchor(round, 1, Date.parse(hypothesis.observedAt)+3*3600000+1), null)
  const anotherRound = startLiveCaddieRound({ courseId: 'farmlinks-pursell-farms-sylacauga-al', teeSet: 'White' })
  assert.notEqual(anotherRound.id, round.id)
  assert.equal(loadLiveTeeSessionAnchor(anotherRound, 1), null)
  console.log('PASS: FarmLinks physical 227.1yd / 3.9yd-right projection, invalid frame safety and per-round native tee anchor isolation.')
} finally { await vite.close() }
