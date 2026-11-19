// Fairway roll by GSPro course conditions: the interpolating model built from
// 324 measured shots, and how it joins the engine's roll step.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
try {
  const { predictFairwayRoll, estimateFairwayRoll } = await load('/src/liveCaddie/fairwayRollModel.ts')
  const { FAIRWAY_ROLL_SHOTS } = await load('/src/liveCaddie/fairwayRollData.ts')
  const { makeRollLandingTransform } = await load('/src/liveCaddie/rollModel.ts')
  const LEVELS = ['soft', 'medium', 'firm']

  // 1. Same answers as the reference fit (numpy, 18 Nov) on 81 arrivals.
  const reference = JSON.parse(readFileSync(new URL('./fixtures/fairway-roll-reference.json', import.meta.url), 'utf8'))
  for (const [courseType, fairwayFirmness, ballSpeedMph, spinRpm, descentDeg, want] of reference) {
    const got = predictFairwayRoll({ ballSpeedMph, spinRpm, descentDeg }, { courseType, fairwayFirmness })
    assert.ok(Math.abs(got - want) < 0.01, `${courseType}/${fairwayFirmness} ${ballSpeedMph} mph: ${got} vs ${want}`)
  }

  // 2. Close to every measured shot (36 launches x 9 settings); the widest gap is smoothing on the 55-yd roller.
  assert.equal(FAIRWAY_ROLL_SHOTS.length, 36)
  let worst = 0, sum = 0, count = 0
  for (const row of FAIRWAY_ROLL_SHOTS) for (let s = 0; s < 9; s += 1) {
    const got = predictFairwayRoll({ ballSpeedMph: row[0], spinRpm: row[1] * 1000, descentDeg: row[2] },
      { courseType: LEVELS[Math.floor(s / 3)], fairwayFirmness: LEVELS[s % 3] })
    worst = Math.max(worst, Math.abs(got - row[3 + s])); sum += Math.abs(got - row[3 + s]); count += 1
  }
  assert.ok(worst < 3.2 && sum / count < 0.4, `worst ${worst}, mean ${sum / count}`)

  // 3. The behaviour golfers expect.
  const driver = { ballSpeedMph: 143.8, spinRpm: 2812, descentDeg: 36.1 }
  const wedge = { ballSpeedMph: 94.4, spinRpm: 8646, descentDeg: 46.4 }
  const on = (arrival, courseType, fairwayFirmness) => predictFairwayRoll(arrival, { courseType, fairwayFirmness })
  for (const arrival of [driver, wedge]) {
    assert.ok(on(arrival, 'soft', 'soft') < on(arrival, 'medium', 'medium') && on(arrival, 'medium', 'medium') < on(arrival, 'firm', 'firm'))
    assert.ok(on(arrival, 'medium', 'soft') < on(arrival, 'medium', 'firm'), 'firmer fairways roll further')
  }
  assert.ok(on(driver, 'medium', 'medium') > 3 * on(wedge, 'medium', 'medium'))
  // Same speed and steepness, far more spin: much less roll (Brian's high-spin hybrid).
  assert.ok(on({ ballSpeedMph: 134, spinRpm: 7500, descentDeg: 40 }, 'medium', 'medium') < 0.7 * on({ ballSpeedMph: 134, spinRpm: 4000, descentDeg: 40 }, 'medium', 'medium'))
  // Into the wind the ball lands steeper: less roll.
  assert.ok(on({ ...driver, descentDeg: 42 }, 'medium', 'medium') < on(driver, 'medium', 'medium'))
  // A shot unlike anything measured stays sane, and missing inputs give nothing.
  const odd = on({ ballSpeedMph: 400, spinRpm: 50, descentDeg: 3 }, 'firm', 'firm')
  assert.ok(odd > 0 && odd < 120, `clamped: ${odd}`)
  assert.equal(predictFairwayRoll({ ballSpeedMph: 140, spinRpm: 2800 }, { courseType: 'firm', fairwayFirmness: 'firm' }), null)
  assert.equal(predictFairwayRoll(driver, null), null)

  // 4. The scale applied to a club's range rollout.
  const estimate = estimateFairwayRoll({ arrival: driver, stockRolloutYds: 16.2, conditions: { courseType: 'firm', fairwayFirmness: 'firm' } })
  assert.ok(Math.abs(estimate.predictedYds - 35.9) < 0.3 && Math.abs(estimate.scale - estimate.predictedYds / 16.2) < 1e-9)
  const windy = estimateFairwayRoll({ arrival: driver, descentDeltaDeg: 5, stockRolloutYds: 16.2, conditions: { courseType: 'firm', fairwayFirmness: 'firm' } })
  assert.ok(windy.descentDeg === 41.1 && windy.predictedYds < estimate.predictedYds)
  assert.equal(estimateFairwayRoll({ arrival: driver, stockRolloutYds: 0, conditions: { courseType: 'firm', fairwayFirmness: 'firm' } }), null, 'nothing to scale')
  assert.equal(estimateFairwayRoll({ arrival: driver, stockRolloutYds: 16.2, conditions: null }), null)
  assert.ok(estimateFairwayRoll({ arrival: wedge, stockRolloutYds: 0.3, conditions: { courseType: 'firm', fairwayFirmness: 'firm' } }).scale === 6, 'capped')

  // 5. In the engine's roll step: fairway and rough landings take the scale, green landings do not.
  const prov = { source: 'osm', confidence: 'high' }
  const hole = {
    holeNumber: 1, markers: { tee: [0, 0], pin: [0, 400] },
    surfaces: [
      { id: 'fw', kind: 'fairway', polygons: [[[-40, 150], [-10, 150], [-10, 300], [-40, 300]]], provenance: prov },
      { id: 'rough', kind: 'rough', polygons: [[[-60, 150], [-40, 150], [-40, 300], [-60, 300]]], provenance: prov },
      { id: 'green', kind: 'green', polygons: [[[10, 150], [40, 150], [40, 300], [10, 300]]], provenance: prov },
    ],
  }
  const rolled = (transform, x) => { const landed = transform([x, 230], [x, 248]); return Math.hypot(landed[0] - x, landed[1] - 230) }
  const plain = makeRollLandingTransform(hole)
  const firm = makeRollLandingTransform(hole, undefined, null, 2)
  assert.ok(Math.abs(rolled(plain, -25) - 18) < 0.05 && Math.abs(rolled(firm, -25) - 36) < 0.05, 'fairway: doubled')
  assert.ok(Math.abs(rolled(firm, -50) - 12.6) < 0.05, 'rough: doubled, then the rough factor')
  assert.ok(Math.abs(rolled(firm, 25) - 18) < 0.05, 'green: unchanged')
  console.log(`fairway roll ok (measured shots: mean ${(sum / count).toFixed(2)} yd, worst ${worst.toFixed(1)} yd)`)
} finally {
  await server?.close()
}
