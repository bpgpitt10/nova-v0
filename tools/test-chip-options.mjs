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

  // Open green, gentle upslope (Briarwood): every option finishes at the hole. Landing on the green
  // comes first (Brian, 21 Nov): the chip is the lowest shot that lands on it and stops; the bump would
  // land on the edge; the flop isn't needed.
  const open = byType(chipOptions(18, line(4, 'fairway', 0.015), setting, 14))
  for (const o of Object.values(open)) assert.ok(Math.abs(o.flight.carryYds + o.runYds - 18) < 0.3, `${o.type} sized to 18`)
  assert.equal(open.chip.verdict, 'good')
  assert.equal(open.bump.verdict, 'short')
  assert.equal(open.pitch.verdict, 'fine')
  assert.equal(open.flop.verdict, 'not-needed')
  assert.ok(open.bump.flight.carryYds < open.chip.flight.carryYds && open.chip.flight.carryYds < open.pitch.flight.carryYds)
  // Steep downhill to the hole: nothing stops landed on the green; the low shots run past even landed short.
  const downhill = byType(chipOptions(18, line(4, 'fairway', -0.03), setting, 14))
  assert.equal(downhill.bump.verdict, 'avoid')
  assert.ok(!Object.values(downhill).some((o) => o.verdict === 'good'))
  // Rough up to the green: the bump and chip land on the green but run past; the pitch carries the rough and stops.
  const rough = byType(chipOptions(25, line(10, 'rough', 0.01), setting, 15))
  assert.equal(rough.bump.verdict, 'avoid')
  assert.equal(rough.pitch.verdict, 'good')
  assert.match(rough.pitch.reason, /Carries the rough/)
  // 31 yd, green from 15 (Brian's FarmLinks chip, 21 Nov): the pick lands on the green, not the apron.
  const farm = byType(chipOptions(31, line(15, 'fairway', 0.01), { ...setting, green: { ...setting.green, greenFirmness: 'soft' }, fairway: { courseType: 'medium', fairwayFirmness: 'soft' } }, 16))
  const pick = Object.values(farm).find((o) => o.verdict === 'good')
  assert.equal(pick?.landsOn, 'green')
  assert.ok(pick.flight.carryYds >= 15 + 2 - 0.25)
  // Bunker beside a short landing: avoid, not "short".
  const side = byType(chipOptions(31, (c) => ({ surface: c < 15 ? 'fairway' : 'green', gradeToHole: 0.01, sideTrouble: c < 15 ? 'bunker' : null }), setting, 16))
  assert.equal(side.bump.verdict, 'avoid')
  // Firm, Links fairway runs further: the bump flies shorter to finish at the same hole.
  const links = byType(chipOptions(18, line(12, 'fairway', 0), { ...setting, fairway: { courseType: 'firm', fairwayFirmness: 'firm' } }, 6))
  const bermuda = byType(chipOptions(18, line(12, 'fairway', 0), setting, 6))
  assert.ok(links.bump.flight.carryYds < bermuda.bump.flight.carryYds)
  // A bunker up to the green (Brian, 21 Nov: the first card landed on its lip): every chip that's
  // kept lands at least CLEAR_TROUBLE_YDS past the sand and says it carries it.
  const { CLEAR_TROUBLE_YDS } = await server.ssrLoadModule('/src/liveCaddie/chipOptions.ts')
  const sand = byType(chipOptions(22, line(8, 'bunker', 0.01), setting, 14))
  for (const o of Object.values(sand)) {
    if (o.verdict !== 'fine' && o.verdict !== 'good') continue
    assert.ok(o.flight.carryYds >= 8 + CLEAR_TROUBLE_YDS - 0.5, `${o.type} clears the bunker (${o.flight.carryYds})`)
    assert.equal(o.carries?.surface, 'bunker')
    assert.match(o.reason ?? '', /Carries the bunker/)
  }
  // From sand (Brian, 21 Nov): pitch or flop only, and the card says how big a swing it takes.
  const fromSand = byType(chipOptions(20, (c) => ({ surface: c < 4 ? 'bunker' : 'green', gradeToHole: 0.01 }), { ...setting, fromSand: true }, 16))
  assert.equal(fromSand.bump.verdict, 'avoid')
  assert.equal(fromSand.chip.verdict, 'avoid')
  assert.match(fromSand.chip.reason, /Not from sand/)
  const sandPick = Object.values(fromSand).find((o) => o.verdict === 'good')
  assert.ok(sandPick && (sandPick.type === 'pitch' || sandPick.type === 'flop'))
  assert.ok(sandPick.swingLikeYds > sandPick.flight.carryYds * 1.3, 'a bigger swing than the carry')
  // A side slope moves the aim the other way, more for the low shots.
  const { chipLieRead } = await server.ssrLoadModule('/src/liveCaddie/chipOptions.ts')
  const bumpAim = chipLieRead({ launchDeg: 12 }, 20, 4, -3)
  const flopAim = chipLieRead({ launchDeg: 40 }, 20, 4, -3)
  assert.ok(bumpAim.aimLeftFt < flopAim.aimLeftFt && flopAim.aimLeftFt < 0, 'starts left, so aim right; the bump most')
  assert.ok(bumpAim.launchDeltaDeg < 0)
  // Slope under the ball: off an upslope the same chip launches higher and runs less, so it's flown
  // further; off a downslope it runs more and is flown shorter.
  const flat = byType(chipOptions(25, line(8, 'fairway', 0), setting, 17))
  const upslope = byType(chipOptions(25, line(8, 'fairway', 0), { ...setting, lieUpDownDeg: 6 }, 17))
  const downslope = byType(chipOptions(25, line(8, 'fairway', 0), { ...setting, lieUpDownDeg: -6 }, 17))
  assert.ok(upslope.pitch.flight.carryYds > flat.pitch.flight.carryYds + 0.3, 'upslope: fly it further')
  assert.ok(downslope.pitch.flight.carryYds < flat.pitch.flight.carryYds - 0.3, 'downslope: fly it shorter')
  // Break: a green that climbs to the right (downhill is left) takes the run left, so the aim goes right;
  // the bump (more run) needs more than the flop; a level green needs none.
  const { chipBreakAimFt } = await server.ssrLoadModule('/src/liveCaddie/chipOptions.ts')
  const tilted = () => [0.03, 0]
  const level = () => [0, 0]
  const shot = (carry, run) => ({ flight: { carryYds: carry }, runYds: run })
  const bumpBreak = chipBreakAimFt(tilted, [0, 0], [0, 30], shot(10, 20), 11)
  const flopBreak = chipBreakAimFt(tilted, [0, 0], [0, 30], shot(25, 5), 11)
  assert.ok(bumpBreak < -2, `bump aims right (${bumpBreak})`)
  assert.ok(flopBreak < 0 && flopBreak > bumpBreak, `flop aims right, less (${flopBreak})`)
  assert.ok(Math.abs(chipBreakAimFt(level, [0, 0], [0, 30], shot(10, 20), 11)) < 0.3)
  console.log('chip options ok', bumpBreak.toFixed(1), flopBreak.toFixed(1))
} finally {
  await server.close()
}
