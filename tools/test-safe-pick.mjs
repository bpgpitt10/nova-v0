// The safe play: a second option under the arm button, shown only when the math pick carries
// real risk and a materially safer club or line costs little (claude/recommendation-model-review-2026-11-05.md §4).
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
  const { pickSafeAlternative, describeSafeAlternative, oneIn } = await load('/src/liveCaddie/safeAlternative.ts')

  const risk = (catastrophe, seriousTrouble, success = 0.6) => ({
    bySurface: {}, success, manageable: Math.max(0, 1 - success - seriousTrouble - catastrophe),
    seriousTrouble, catastrophe, unknown: 0, expectedSeverity: 0, coreProbability: 1, tailProbability: 0,
    mishitProbability: 0, severeMishitProbability: 0, coreSampleCount: 2048, tailSampleCount: 0, tailLandings: [],
  })
  const value = (ev) => ({ modelId: 'test', expectedFutureStrokes: ev, valuedProbability: 1, unresolvedProbability: 0,
    provisionalProbability: 0, meanDistanceToPinYds: null, coreContribution: ev, tailContribution: 0, byCondition: {} })
  const cand = (aimOffsetYds, cat, trouble, ev) => ({ aimOffsetYds, aimPoint: [aimOffsetYds, 200], riskProfile: risk(cat, trouble), stateValue: value(ev), modeledSamples: [] })
  const club = (name, rank, candidates, targetDistanceYds = 200) => ({
    club: name, decisionRank: rank, decisionReason: rank === 1 ? 'Lowest' : 'Alternative', targetDistanceYds,
    planningTarget: [0, targetDistanceYds], candidates, bestCandidate: candidates[0],
  })

  // 1. Par 3 over water: Driver-ish aggressive pick (8% water) vs a 6i to the front (2% water) for 0.12.
  {
    const evals = [
      club('5i', 1, [cand(0, 0.08, 0.10, 3.10), cand(6, 0.07, 0.12, 3.14)]),
      club('6i', 2, [cand(0, 0.02, 0.12, 3.22), cand(-6, 0.015, 0.14, 3.26)]),
      club('7i', 3, [cand(0, 0.01, 0.20, 3.45)]),
    ]
    const safe = pickSafeAlternative(evals)
    assert.ok(safe, 'a safe play shows over water')
    assert.equal(safe.club, '6i')
    assert.equal(safe.differsBy, 'club')
    assert.ok(Math.abs(safe.costStrokes - 0.12) < 1e-9)
    assert.equal(safe.mainlyCuts, 'catastrophe')
    assert.match(describeSafeAlternative(safe), /water or penalty 1 in 50 instead of 1 in 1[23]/)
  }
  // 2. Open hole: the math pick is already safe → nothing.
  assert.equal(pickSafeAlternative([
    club('Driver', 1, [cand(0, 0.01, 0.08, 2.90)]),
    club('3H', 2, [cand(0, 0.00, 0.05, 3.05)]),
  ]), null, 'no safe play on an open hole')
  // 3. Safer club costs too much (0.4) → nothing.
  assert.equal(pickSafeAlternative([
    club('Driver', 1, [cand(0, 0.09, 0.10, 2.90)]),
    club('7i', 2, [cand(0, 0.00, 0.05, 3.30)]),
  ]), null, 'a safe play that costs 0.4 strokes is not offered')
  // 4. Same club, aim 3 yd different: not a different play. 12 yd different, materially safer: it is.
  {
    const same = pickSafeAlternative([club('Driver', 1, [cand(0, 0.08, 0.1, 2.9), cand(3, 0.04, 0.1, 2.95)])])
    assert.equal(same, null, '3 yd of aim is not a safe play')
    const line = pickSafeAlternative([club('Driver', 1, [cand(0, 0.08, 0.1, 2.9), cand(12, 0.02, 0.1, 3.0)])])
    assert.ok(line && line.differsBy === 'line' && line.candidate.aimOffsetYds === 12)
  }
  // 5. Inside 150 the cost cap tightens: 0.2 is too much there, fine from 200.
  const near = (dist) => pickSafeAlternative([
    club('PW', 1, [cand(0, 0.07, 0.1, 2.8)], dist), club('GW', 2, [cand(0, 0.01, 0.05, 3.0)], dist),
  ])
  assert.equal(near(120), null)
  assert.ok(near(200))
  // 6. Trouble-only case (bunkers, no water): shows on trouble cut.
  {
    const safe = pickSafeAlternative([
      club('Driver', 1, [cand(0, 0.01, 0.30, 2.9)]),
      club('3H', 2, [cand(0, 0.005, 0.10, 3.05)]),
    ])
    assert.ok(safe && safe.mainlyCuts === 'trouble')
    assert.match(describeSafeAlternative(safe), /sand or deep rough 1 in 10 instead of 1 in 3/)
  }
  assert.equal(oneIn(0.5), '1 in 2'); assert.equal(oneIn(0), 'none')
  console.log('PASS: safe play shows over water/sand when it is materially safer and cheap, never on open holes, never for 3 yd of aim.')
} finally {
  await server?.close()
}
