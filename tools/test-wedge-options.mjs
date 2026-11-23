// Partial-wedge flights (40 yd to the shortest full club): sizing and the verdict rules (Brian, 23 Nov).
// Run: node tools/test-wedge-options.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { chipOptions, chipFlight, defaultChip, WEDGE_TYPES } = await server.ssrLoadModule('/src/liveCaddie/chipOptions.ts')
  const setting = (courseType, firmness) => ({
    green: { courseType, greenFirmness: firmness, stimp: 11 }, fairway: { courseType, fairwayFirmness: firmness }, fromRough: false,
  })
  const line = (greenStarts) => (carry) => ({ surface: carry < greenStarts ? 'fairway' : 'green', gradeToHole: 0 })
  const byType = (options) => Object.fromEntries(options.map((o) => [o.type, o]))
  const wedges = (distance, pinOn, courseType = 'medium', firmness = 'medium') =>
    chipOptions(distance, line(distance - pinOn), setting(courseType, firmness), pinOn, 'wedge')

  // The measured flights come back at the measured carries; past the last one they carry on.
  assert.ok(Math.abs(chipFlight('standard', 54.58).ballSpeedMph - 55.3) < 0.05)
  assert.ok(chipFlight('high', 65).landing.descentDeg > chipFlight('standard', 65).landing.descentDeg + 5)
  assert.ok(chipFlight('standard', 95).ballSpeedMph > chipFlight('standard', 88).ballSpeedMph)

  // Four flights, low to high, each sized to finish at the hole.
  const open = wedges(65, 12)
  assert.deepEqual(open.map((o) => o.type), [...WEDGE_TYPES])
  for (const o of open) assert.ok(Math.abs(o.flight.carryYds + o.runYds - 65) < 0.3, `${o.type} sized to 65`)
  const o65 = byType(open)
  // The lower the flight, the more it runs.
  assert.ok(o65.runner.runYds > o65.flighted.runYds && o65.flighted.runYds > o65.standard.runYds && o65.standard.runYds > o65.high.runYds)
  // Room on the green: the stock flight is the pick, and the runner isn't needed.
  assert.equal(o65.standard.verdict, 'good')
  assert.equal(o65.runner.verdict, 'not-needed')
  assert.equal(defaultChip(open, 65).type, 'standard')

  // Pin 4 yd on, medium Bermuda: nothing lands on the green and stops. Best guess is the highest flight.
  const front = wedges(65, 4)
  assert.ok(front.every((o) => o.verdict === 'short'))
  assert.equal(defaultChip(front, 65).type, 'high')
  // Soft Bentgrass holds it: the standard flight is fine to a front pin.
  assert.equal(byType(wedges(65, 4, 'soft', 'soft')).standard.verdict, 'good')
  // Firm links: everything runs more.
  assert.ok(byType(wedges(65, 22, 'firm', 'firm')).standard.runYds > o65.standard.runYds + 3)

  // Every distance in the zone gets a pick when there is green to land on.
  for (const d of [45, 55, 65, 75, 85, 95]) {
    const pick = defaultChip(wedges(d, 22), d)
    assert.ok(pick && pick.verdict === 'good', `a pick at ${d}`)
  }
  // The chips are untouched by the wedge family.
  assert.deepEqual(chipOptions(18, line(4), setting('medium', 'medium'), 14).map((o) => o.type), ['bump', 'chip', 'pitch', 'flop'])
  console.log('wedge options ok')
} finally {
  await server.close()
}
