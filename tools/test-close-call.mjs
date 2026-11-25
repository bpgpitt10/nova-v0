// The close call: when the next club is as good as the pick within a few hundredths of a stroke,
// the card says so and offers it (Tobacco Road 14, 24 Nov: 7i over 8i by 0.01, shown as plain "7i").
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
  const { pickCloseCall, describeCloseCall, describeCloseCallPick, CLOSE_CALL_MAX_GAP_STROKES } = await load('/src/liveCaddie/closeCall.ts')
  const { pickSafeAlternative } = await load('/src/liveCaddie/safeAlternative.ts')

  const risk = (catastrophe, seriousTrouble, success = 0.6) => ({
    bySurface: {}, success, manageable: Math.max(0, 1 - success - seriousTrouble - catastrophe),
    seriousTrouble, catastrophe, unknown: 0, expectedSeverity: 0, coreProbability: 1, tailProbability: 0,
    mishitProbability: 0, severeMishitProbability: 0, coreSampleCount: 2048, tailSampleCount: 0, tailLandings: [],
  })
  const value = (ev) => ({ modelId: 'test', expectedFutureStrokes: ev, valuedProbability: 1, unresolvedProbability: 0,
    provisionalProbability: 0, meanDistanceToPinYds: null, coreContribution: ev, tailContribution: 0, byCondition: {} })
  const cand = (aimOffsetYds, cat, trouble, ev) => ({ aimOffsetYds, aimPoint: [aimOffsetYds, 160], riskProfile: risk(cat, trouble), stateValue: value(ev), modeledSamples: [] })
  const club = (name, rank, carry, candidate, extra = {}) => ({
    club: name, decisionRank: rank, decisionReason: rank === 1 ? 'Lowest' : 'Alternative', targetDistanceYds: 157.9,
    modeledCarryYds: carry, planningTarget: [0, 157.9], candidates: [candidate], bestCandidate: candidate, ...extra,
  })

  // 1. Tobacco Road 14: 7i 9 past (water/penalty 6%) vs 8i 2 short (18%), 0.01 strokes apart.
  {
    const evals = [
      club('7i', 1, 167.1, cand(-15.7, 0.0633, 0.05, 2.558)),
      club('8i', 2, 156.1, cand(-14.6, 0.1823, 0.05, 2.568)),
      club('6i', 3, 178.5, cand(-16.7, 0.064, 0.05, 2.713)),
    ]
    assert.equal(pickSafeAlternative(evals), null, 'the pick is already the safest: no safe play')
    const close = pickCloseCall(evals, null)
    assert.ok(close, 'a 0.01-stroke call is a close call')
    assert.equal(close.club, '8i')
    assert.equal(close.pick.club, '7i')
    assert.ok(Math.abs(close.gapStrokes - 0.01) < 1e-9)
    assert.equal(describeCloseCall(close), 'just as good (0.01 strokes behind) · lands 2 short · more water or penalty (1 in 5 vs 1 in 16)')
    assert.equal(describeCloseCallPick(close), 'lands 9 past · less water or penalty (1 in 16 vs 1 in 5)')
  }
  // 2. A clear pick (0.12 strokes) is not a close call.
  assert.equal(pickCloseCall([
    club('7i', 1, 160, cand(0, 0.02, 0.1, 2.50)),
    club('8i', 2, 150, cand(0, 0.02, 0.1, 2.62)),
  ]), null)
  assert.ok(CLOSE_CALL_MAX_GAP_STROKES >= 0.04 && CLOSE_CALL_MAX_GAP_STROKES <= 0.06)
  // 3. When the runner-up is also the safe play, the safe play says it: no close call.
  {
    const evals = [
      club('5i', 1, 190, cand(0, 0.08, 0.10, 3.10)),
      club('6i', 2, 178, cand(0, 0.02, 0.12, 3.14)),
    ]
    const safe = pickSafeAlternative(evals)
    assert.ok(safe && safe.club === '6i')
    assert.equal(pickCloseCall(evals, safe), null)
    assert.ok(pickCloseCall(evals, null), 'without the safe play it would be a close call')
  }
  // 4. A club the lie rules out (wood from sand) or a cold-start club is never offered.
  assert.equal(pickCloseCall([
    club('5i', 1, 170, cand(0, 0.02, 0.1, 2.9)),
    club('3W', 2, 200, cand(0, 0.02, 0.1, 2.91), { recommendable: false }),
  ]), null)
  assert.equal(pickCloseCall([
    club('5i', 1, 170, cand(0, 0.02, 0.1, 2.9)),
    club('4H', 2, 180, cand(0, 0.02, 0.1, 2.91), { decisionReason: 'cold-start: too few shots' }),
  ]), null)
  // 5. Close but nothing to trade (Driver vs 3W off a wide tee, same trouble): not worth the space.
  assert.equal(pickCloseCall([
    club('Driver', 1, 250, cand(0, 0.01, 0.10, 3.40)),
    club('3W', 2, 232, cand(0, 0.01, 0.12, 3.42)),
  ]), null, 'a close call must trade some trouble')
  // 6. Trading sand (not water): the line names sand.
  {
    const close = pickCloseCall([
      club('9i', 1, 150, cand(0, 0.01, 0.06, 2.40)),
      club('8i', 2, 160.4, cand(0, 0.01, 0.16, 2.42)),
    ])
    assert.equal(describeCloseCall(close), 'just as good (0.02 strokes behind) · lands 3 past · more sand or deep rough (1 in 6 vs 1 in 17)')
    assert.equal(describeCloseCallPick(close), 'lands 8 short · less sand or deep rough (1 in 17 vs 1 in 6)')
  }

  console.log('close call: ok')
} finally {
  await server?.close()
}
