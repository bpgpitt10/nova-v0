// Around-the-green chip options: sizing and the verdict rules (Brian, 21 Nov).
// Run: node tools/test-chip-options.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { chipOptions, chipFlight } = await server.ssrLoadModule('/src/liveCaddie/chipOptions.ts')
  const setting = { green: { courseType: 'medium', greenFirmness: 'medium', stimp: 11 }, fairway: { courseType: 'medium', fairwayFirmness: 'medium' }, fromRough: false }
  const line = (greenStarts, before, grade) => (carry) => ({ surface: carry < greenStarts ? before : 'green', gradeToHole: grade })
  const byType = (options) => Object.fromEntries(options.map((o) => [o.type, o]))

  // GSPro's own flights come back at the measured carries.
  assert.ok(Math.abs(chipFlight('pitch', 31.71).ballSpeedMph - 43.0) < 0.05)
  assert.ok(Math.abs(chipFlight('bump', 10.98).landing.descentDeg - 11.27) < 0.05)

  // Open green, gentle upslope (Briarwood): every option finishes at the hole; the flop isn't needed.
  const open = byType(chipOptions(18, line(4, 'fairway', 0.015), setting, 14))
  for (const o of Object.values(open)) assert.ok(Math.abs(o.flight.carryYds + o.runYds - 18) < 0.3, `${o.type} sized to 18`)
  assert.equal(open.flop.verdict, 'not-needed')
  assert.equal(open.chip.verdict, 'fine')
  assert.ok(open.bump.flight.carryYds < open.chip.flight.carryYds && open.chip.flight.carryYds < open.pitch.flight.carryYds)
  // Steep downhill to the hole: the lower shots run past even landed short; the flop is the shot.
  const downhill = byType(chipOptions(18, line(4, 'fairway', -0.03), setting, 14))
  assert.equal(downhill.flop.verdict, 'good')
  assert.equal(downhill.bump.verdict, 'avoid')
  // Rough up to the green: a bump would land in it or run past; chips that carry it are fine.
  const rough = byType(chipOptions(25, line(10, 'rough', 0.01), setting, 15))
  assert.equal(rough.bump.verdict, 'avoid')
  assert.equal(rough.chip.landsOn, 'green')
  // Firm, Links fairway runs further: the bump flies shorter to finish at the same hole.
  const links = byType(chipOptions(18, line(12, 'fairway', 0), { ...setting, fairway: { courseType: 'firm', fairwayFirmness: 'firm' } }, 6))
  const bermuda = byType(chipOptions(18, line(12, 'fairway', 0), setting, 6))
  assert.ok(links.bump.flight.carryYds < bermuda.bump.flight.carryYds)
  console.log('chip options ok')
} finally {
  await server.close()
}
