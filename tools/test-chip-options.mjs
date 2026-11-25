// Around-the-green chip options: sizing and the verdict rules (Brian, 21 Nov).
// Run: node tools/test-chip-options.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { chipOptions, chipFlight, levelCarryFor, defaultChip } = await server.ssrLoadModule('/src/liveCaddie/chipOptions.ts')
  const setting = { green: { courseType: 'medium', greenFirmness: 'medium', stimp: 11 }, fairway: { courseType: 'medium', fairwayFirmness: 'medium' }, fromRough: false }
  const line = (greenStarts, before, grade) => (carry) => ({ surface: carry < greenStarts ? before : 'green', gradeToHole: grade })
  const byType = (options) => Object.fromEntries(options.map((o) => [o.type, o]))

  // GSPro's own flights come back at the measured carries.
  assert.ok(Math.abs(chipFlight('pitch', 31.71).ballSpeedMph - 43.0) < 0.05)
  // Landing above the ball: a longer level carry (2.5 ft up on a 29 yd pitch, about 30.5); below: shorter.
  const pitchDescent = chipFlight('pitch', 29).landing.descentDeg
  const up = levelCarryFor(29, pitchDescent, 2.5)
  assert.ok(up > 30 && up < 31.2, `uphill landing ${up}`)
  assert.ok(levelCarryFor(29, pitchDescent, -2.5) < 29 - 0.8)
  assert.ok(levelCarryFor(29, pitchDescent, 15) > 38, 'five yards up is a much bigger swing')
  assert.equal(levelCarryFor(29, pitchDescent, null), 29)
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
  // Nothing lands on the green and stops (the green starts 3 yd short of the hole, up a slope): the
  // shot to show first is the highest one left, never a low one landing short of the green.
  const tight = chipOptions(26, line(23, 'fairway', 0.08), setting, 3)
  assert.ok(!tight.some((o) => o.verdict === 'good'), JSON.stringify(tight.map((o) => o.verdict)))
  const first = defaultChip(tight)
  assert.ok(first && first.verdict === 'short')
  assert.ok(tight.filter((o) => o.verdict === 'short').every((o) => o.flight.carryYds <= first.flight.carryYds + 1e-9),
    `default lands nearest the green (${first.type})`)
  assert.notEqual(first.type, 'bump')
  // With a pick, the pick comes first.
  assert.equal(defaultChip(Object.values(flat)).verdict, 'good')
  // A collar of rough in front of the green (Bellerive 4, 21 Nov): the flop has to land past it and
  // runs about 3 yd by. That still leaves a short putt, so it is Looper's pick, not "avoid".
  const collared = byType(chipOptions(23, (carry) => ({ surface: carry < 18 ? 'fairway' : carry < 21 ? 'rough' : 'green', gradeToHole: 0.048 }), { ...setting, green: { ...setting.green, greenFirmness: 'soft' } }, 2))
  assert.equal(collared.flop.verdict, 'good', JSON.stringify(collared.flop))
  assert.match(collared.flop.reason, /runs about \d yd past/)
  // Every option avoid (Bellerive 4: 8 yd to a pin on the edge of Looper's green): still one to show
  // and aim, the one finishing nearest the hole.
  const edge = chipOptions(8, (carry) => ({ surface: carry < 6 ? 'rough' : 'green', gradeToHole: 0.027 }), setting, 0.5)
  if (edge.every((o) => o.verdict === 'avoid')) {
    const near = defaultChip(edge, 8)
    assert.ok(near)
    for (const o of edge) assert.ok(Math.abs(near.flight.carryYds + near.runYds - 8) <= Math.abs(o.flight.carryYds + o.runYds - 8) + 1e-9)
  }
  assert.equal(defaultChip([], 8), null)

  // The player's own flights (24 Nov, 3s Greenville 7: armed Chip, swung his usual 25 deg pitch).
  const { fitPlayerShortGame, nearestFlight } = await server.ssrLoadModule('/src/liveCaddie/playerShortGame.ts')
  assert.equal(nearestFlight('chip', 25.2), 'pitch')
  assert.equal(nearestFlight('chip', 23.9), 'chip')
  assert.equal(nearestFlight('wedge', 29), 'standard')
  let n = 0
  const swing = (mph, launch, rpm, surface = 2, round = 'r') => ({ roundKey: round, shotKey: `${round}|${n += 1}`, startSurface: surface, ballSpeedMph: mph, launchDeg: launch, spinRpm: rpm })
  const pitches = Array.from({ length: 20 }, (_, i) => swing(16.0371 + i * 0.4, 27.013 + (i % 5), (16.0371 + i * 0.4) * 140))
  const flops = Array.from({ length: 4 }, (_, i) => swing(18.0213 + i, 36.071 + i, (18.0213 + i) * 120))
  // A lab shot fired three times (identical to the last digit), one typed in once (tenths only, saved
  // as single-precision floats), a shot off the tee and a putt: all left out.
  const lab = [swing(37.8, 27.7, 10856), swing(37.8, 27.7, 10856), swing(37.8, 27.7, 10856), swing(18.399999618530273, 29.0, 2300),
    // Not on tenths, but the same numbers turn up in another round: a lab shot fired again.
    swing(21.0371, 30.013, 2611, 2, 'r'), swing(21.0371, 30.013, 2611, 2, 'other')]
  // The same shot saved twice in its round (once as itself, once copied onto the next shot) counts once.
  const fit = fitPlayerShortGame([...pitches, ...flops, ...lab, swing(20, 20, 1500, 18), swing(6, 0, 0, 5), { ...pitches[0], shotKey: 'copy' }])
  assert.equal(fit.chip.total, 24, 'lab shots, tee shots and repeats are dropped')
  assert.ok(Math.abs(fit.chip.byType.pitch.launchDeg - 29.013) < 0.01)
  assert.ok(Math.abs(fit.chip.byType.pitch.spinPerMph - 140) < 0.01)
  assert.equal(fit.chip.byType.flop, undefined, 'four flops is not enough to replace the stock flop')
  assert.deepEqual([...fit.chip.rarely].sort(), ['bump', 'chip'])
  assert.equal(fit.wedge.total, 0)
  assert.deepEqual(fit.wedge.rarely, [])
  // Rough spin is after GSPro's penalty: launch counts, spin doesn't.
  const roughOnly = fitPlayerShortGame(Array.from({ length: 8 }, (_, i) => swing(20.013 + i, 28.031, 1500 + i, 1)))
  assert.ok(roughOnly.chip.byType.pitch && roughOnly.chip.byType.pitch.spinPerMph === null)

  // Same open green as above: GSPro's stock Chip is Looper's pick; for this player it's his Pitch,
  // at his launch, and the chip is marked as one he rarely hits.
  const mine = byType(chipOptions(18, line(4, 'fairway', 0.015), { ...setting, player: fit.chip }, 14))
  assert.equal(open.chip.verdict, 'good')
  assert.equal(mine.pitch.verdict, 'good')
  assert.equal(mine.pitch.launchDeg, 29)
  assert.ok(mine.pitch.ownFlight && !mine.chip.ownFlight && mine.chip.rarelyHit)
  assert.match(mine.chip.reason ?? '', /rarely hit/)
  for (const o of Object.values(mine)) assert.ok(Math.abs(o.flight.carryYds + o.runYds - 18) < 0.3, `${o.type} sized to 18 for the player`)
  // More spin per mph than GSPro's stock pitch (about 125): a little less run, so a longer carry.
  assert.ok(mine.pitch.flight.carryYds > open.pitch.flight.carryYds, `${mine.pitch.flight.carryYds} vs ${open.pitch.flight.carryYds}`)
  assert.ok(Math.abs(mine.pitch.flight.spinRpm / mine.pitch.flight.ballSpeedMph - 140) < 0.5)
  // A rarely hit flight is still the pick when nothing the player hits works.
  const onlyLow = byType(chipOptions(30, (carry) => ({ surface: carry < 3 ? 'fairway' : 'green', gradeToHole: -0.06 }), { ...setting, player: fit.chip }, 27))
  const lowPick = Object.values(onlyLow).find((o) => o.verdict === 'good')
  if (lowPick && lowPick.rarelyHit) assert.ok(!Object.values(onlyLow).some((o) => !o.rarelyHit && o.verdict === 'fine'))
  console.log('chip options ok', bumpBreak.toFixed(1), flopBreak.toFixed(1))
} finally {
  await server.close()
}
