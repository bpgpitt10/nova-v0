// Core shot shape from the player's own good shots (src/liveCaddie/empiricalShotCore.ts),
// with the yardage-book Pure used only to explain (pureFinish / pureFinishRead).
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { buildEmpiricalShotCore, EMPIRICAL_CORE_MIN_SHOTS } = await vite.ssrLoadModule('/src/liveCaddie/empiricalShotCore.ts')
  const { evaluateAimLab } = await vite.ssrLoadModule('/src/liveCaddie/aimOptimization.ts')
  const { pureFinishRead } = await vite.ssrLoadModule('/src/liveCaddie/pureFinishRead.ts')

  // A lopsided club: tight body at 150, 5 flushed (+9/+10, straight, little roll), 4 thin.
  const STOCK = 150
  const pattern = (stock, roll) => {
    const out = []
    ;[-4, -3, -2, -2, -1, -1, 0, 0, 0, 1, 1, 2, 2, 3, -5, -6].forEach((d, i) => out.push([stock + d, stock + d + roll, ((i % 5) - 2) * 2]))
    for (let i = 0; i < 5; i += 1) out.push([stock + 9 + (i % 2), stock + 9 + (i % 2) + 1, (i % 3) - 1])
    for (let i = 0; i < 4; i += 1) out.push([stock - 10 - i, stock - 10 - i + roll + 3, i % 2 ? 6 : -6])
    return out
  }
  const raw = pattern(STOCK, 4).map(([carryYds, totalYds, offlineYds]) => ({ carryYds, totalYds, offlineYds, weight: 1 }))
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
  const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) }

  // 1. Too few shots → bell curve (null core).
  assert.equal(buildEmpiricalShotCore({ shots: raw.slice(0, EMPIRICAL_CORE_MIN_SHOTS - 1), carryAdjustmentYds: 0, lateralAdjustmentYds: 0, stockRolloutYds: 4 }), null)

  // 2. Same center and spread as the shots; live conditions translate it exactly.
  const core = buildEmpiricalShotCore({ shots: raw, carryAdjustmentYds: 0, lateralAdjustmentYds: 0, stockRolloutYds: 4 })
  assert.equal(core.draws.length, 2048)
  const carries = core.draws.map((d) => d.carryYds)
  const dataCarries = raw.map((s) => s.carryYds)
  assert.ok(Math.abs(mean(carries) - mean(dataCarries)) < 0.15, `${mean(carries)} vs ${mean(dataCarries)}`)
  assert.ok(Math.abs(sd(carries) / sd(dataCarries) - 1) < 0.05, `spread ${sd(carries)} vs ${sd(dataCarries)}`)
  const windy = buildEmpiricalShotCore({ shots: raw, carryAdjustmentYds: -7, lateralAdjustmentYds: 3, stockRolloutYds: 4 })
  assert.ok(Math.abs(mean(windy.draws.map((d) => d.carryYds)) - (mean(carries) - 7)) < 1e-6)
  assert.ok(Math.abs(mean(windy.draws.map((d) => d.offlineYds)) - (mean(core.draws.map((d) => d.offlineYds)) + 3)) < 1e-6)

  // 3. Real shape: flushed shots at their real frequency; a ceiling on the long side.
  const flushedShare = raw.filter((s) => s.carryYds >= STOCK + 9).length / raw.length // 20%
  const nearFlush = carries.filter((c) => c >= STOCK + 7).length / carries.length
  assert.ok(Math.abs(nearFlush - flushedShare) < 0.04, `draws near the flush ${nearFlush} vs real ${flushedShare}`)
  const ceiling = Math.max(...dataCarries) + 2 * core.carryBlurYds
  assert.ok(carries.filter((c) => c > ceiling).length / carries.length < 0.01, 'almost nothing past the longest real shot + blur')

  // 4. Each shot keeps its own rollout (the flushed ones roll ~1, the body ~4).
  const flushedDraws = core.draws.filter((d) => d.carryYds >= STOCK + 8)
  const bodyDraws = core.draws.filter((d) => Math.abs(d.carryYds - STOCK) <= 2)
  assert.ok(mean(flushedDraws.map((d) => d.totalYds - d.carryYds)) < mean(bodyDraws.map((d) => d.totalYds - d.carryYds)) - 1.5)

  // 5. The back-bunker decision. 150-yd par 3; green to 158.5, bunker right behind it.
  //    7i Stock finishes back-middle but its flushes carry into the bunker; the 8i's flushes stay on.
  //    The bell curve said 7i ("Clear"); the real shot shape says 8i.
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  const surface = (id, kind, polygons) => ({ id, kind, polygons, provenance: { source: 'manual', confidence: 'high' } })
  const hole = {
    courseId: 'test', holeNumber: 1, par: 3, markers: { tee: [0, 0], pin: [0, 150] },
    surfaces: [
      surface('t', 'tee', [rect(-5, -5, 5, 5)]), surface('fw', 'fairway', [rect(-25, 5, 25, 132)]),
      surface('g', 'green', [rect(-14, 132, 14, 158.5)]), surface('bb', 'bunker', [rect(-16, 158.5, 16, 170)]),
      surface('r', 'rough', [rect(-60, -10, 60, 200)]),
    ],
    availability: { tee: 'available', fairway: 'available', rough: 'available', 'deep-rough': 'unavailable', green: 'available', bunker: 'available', water: 'unavailable', penalty: 'unavailable' },
  }
  const NOW = Date.parse('2026-11-03T12:00:00Z')
  const shotsFor = (club, stock, speed, launch, spin, count = 25) => pattern(stock, 4).slice(0, count).map(([c, t, o], i) => ({
    id: `${club}-${i}`, club, included: true, enrichmentStatus: 'enriched', source: 'simread',
    capturedAt: new Date(NOW - 86400000 * (1 + (i % 3)) + i * 1000).toISOString(),
    carryYards: c, totalYards: t, offlineYards: o, ballSpeedMph: speed, launchAngleDeg: launch, spinRpm: spin,
  }))
  const sessionsFrom = (shots) => [0, 1, 2].map((k) => ({
    id: `s${k}`, startedAt: new Date(NOW - 86400000 * (1 + k)).toISOString(),
    endedAt: new Date(NOW - 86400000 * (1 + k) + 3600000).toISOString(), shots: shots.filter((_, i) => i % 3 === k),
  }))
  const evaluate = (shots) => evaluateAimLab(sessionsFrom(shots), hole, [0, 0], [0, 150],
    { shotOrigin: 'tee', surfaceOverride: 'tee', exactPinLocalYds: [0, 150] }, NOW)

  const evals = evaluate([...shotsFor('7i', 150, 112, 18, 6300), ...shotsFor('8i', 140, 106, 20, 7200)])
  const seven = evals.find((e) => e.club === '7i')
  const eight = evals.find((e) => e.club === '8i')
  assert.deepEqual(seven.shotShape, { source: 'your-shots', shotCount: 25 })
  assert.equal(evals.find((e) => e.decisionRank === 1).club, '8i', '8i: its flushes stay on the green')
  assert.ok(seven.bestCandidate.riskProfile.bySurface.bunker > 0.10, `7i finds the back bunker when flushed (${seven.bestCandidate.riskProfile.bySurface.bunker})`)
  assert.equal(seven.bestCandidate.pureFinish.kind, 'bunker')
  assert.equal(eight.bestCandidate.pureFinish.kind, 'green')
  assert.match(pureFinishRead({ club: '7i', pureFinish: seven.bestCandidate.pureFinish }), /^Flush it \(your Pure 7i, \d+ carry\) and it finishes in a bunker\.$/)
  assert.equal(pureFinishRead({ club: '8i', pureFinish: eight.bestCandidate.pureFinish }), null, 'no line when flushed is fine')

  // 6. A thin club (under the minimum) stays on the bell curve and says so.
  const thin = evaluate([...shotsFor('7i', 150, 112, 18, 6300, 12), ...shotsFor('8i', 140, 106, 20, 7200)])
  assert.equal(thin.find((e) => e.club === '7i').shotShape.source, 'bell-curve')
  assert.ok(thin.find((e) => e.club === '7i').notes.some((n) => /bell curve/.test(n)))

  console.log(`PASS: your-shot core keeps center/spread (σ ratio ${(sd(carries) / sd(dataCarries)).toFixed(3)}), flushed share ${(nearFlush * 100).toFixed(0)}% vs real ${(flushedShare * 100).toFixed(0)}%, long-side ceiling, own rollout; back-bunker par 3 flips 7i → 8i; Flushed line; bell-curve fallback under ${EMPIRICAL_CORE_MIN_SHOTS} shots.`)
} finally {
  await vite.close()
}
