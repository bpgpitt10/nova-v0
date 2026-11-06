// Caddie vs you: the engine's expected strokes ride along with the Arm, so a club change can be
// priced in strokes, not just named.
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
  const { decisionOptions, serializeDecisionOptions, parseDecisionOptions, paperCostStrokes, DECISION_OPTIONS_MAX } =
    await load('/src/liveCaddie/decisionOptions.ts')

  const evaluation = (club, rank, ev, extra = {}) => ({
    club, decisionRank: rank, modeledCarryYds: 150 + rank,
    bestCandidate: { aimOffsetYds: -3 },
    decisionValue: ev == null ? null : {
      expectedFutureStrokes: ev, confidenceAdjustedStrokes: ev + 0.02, catastropheProbability: 0.0123,
      modelConfidence: 0.8, evDeltaToRawBest: 0, decisionStrength: 'clear',
    },
    ...extra,
  })
  const evaluations = [
    evaluation('7i', 1, 2.901), evaluation('6i', 2, 2.955), evaluation('8i', 3, 3.012),
    evaluation('5i', 4, 3.1), evaluation('4i', 5, 3.2), evaluation('PW', 6, 3.4), evaluation('Dr', null, null),
  ]

  // Top four by rank, in rank order.
  const top = decisionOptions(evaluations, null)
  assert.deepEqual(top.map((o) => o.club), ['7i', '6i', '8i', '5i'])
  assert.equal(top.length, DECISION_OPTIONS_MAX)
  assert.equal(top[0].expectedStrokes, 2.901)
  assert.equal(top[0].adjustedStrokes, 2.921)
  assert.equal(top[0].catastrophe, 0.0123)
  assert.equal(top[0].aimOffsetYds, -3)

  // The club the player is looking at comes along even when it isn't in the top four.
  const withViewed = decisionOptions(evaluations, 'PW')
  assert.deepEqual(withViewed.map((o) => o.club), ['7i', '6i', '8i', '5i', 'PW'])
  // ...unless it has no value at all: then it still comes, with nulls, so the arm is recorded.
  const noValue = decisionOptions(evaluations, 'Dr')
  assert.equal(noValue.at(-1).club, 'Dr')
  assert.equal(noValue.at(-1).expectedStrokes, null)

  // Round trip through the DOM dataset string.
  const json = serializeDecisionOptions(evaluations, 'PW')
  assert.ok(json.length < 900, `stays small: ${json.length} bytes`)
  const parsed = parseDecisionOptions(json)
  assert.deepEqual(parsed.map((o) => o.club), ['7i', '6i', '8i', '5i', 'PW'])
  assert.equal(parsed[1].expectedStrokes, 2.955)
  assert.equal(parseDecisionOptions('{not json'), null)
  assert.equal(parseDecisionOptions([{ nope: 1 }]), null)
  assert.equal(serializeDecisionOptions([], null), null)

  // Pricing the change: armed − recommended.
  assert.equal(paperCostStrokes(parsed, '6i', '7i'), 0.054, 'taking 6i over the 7i pick costs 0.054 on paper')
  assert.equal(paperCostStrokes(parsed, '7i', '7i'), 0)
  assert.equal(paperCostStrokes(parsed, 'Dr', '7i'), null, 'no value for the armed club: no price')
  assert.equal(paperCostStrokes(null, '6i', '7i'), null)

  console.log('decision options: ok')
} finally {
  if (server) await server.close()
}
