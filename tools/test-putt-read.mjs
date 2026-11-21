// The putt card's maths against the putting model's own numbers (claude/putting-model-2026-11-20.md).
// Run: node tools/test-putt-read.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { readPutt, puttRollFt, puttSpeedFor, runawayGrade, puttFriction, feetInches, rollOnGreen, aimPutt } = await server.ssrLoadModule('/src/liveCaddie/puttRead.ts')
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`)

  near(puttFriction(11), 0.0320, 0.0002, 'c0 at stimp 11')
  near(puttFriction(13), 0.0243, 0.0002, 'c0 at stimp 13')
  // A stimpmeter release (6 ft/s, flat) rolls the stimp number in feet.
  for (const stimp of [8, 10, 11, 12, 13]) near(puttRollFt(6, stimp), stimp, 0.06, `stimpmeter roll at ${stimp}`)
  // A putt sized for 20 ft at stimp 11 rolls 15.1 at 8 and 23.2 at 13.
  const v20 = puttSpeedFor(20, 11)
  near(puttRollFt(v20, 8), 15.1, 0.1, '20 ft stroke at stimp 8')
  near(puttRollFt(v20, 13), 23.2, 0.1, '20 ft stroke at stimp 13')
  // A 10 ft putt sized for flat at 11: 13.9 down a 2% slope, 7.8 up one.
  const v10 = puttSpeedFor(10, 11)
  near(puttRollFt(v10, 11, -0.02), 13.9, 0.1, 'down 2%')
  near(puttRollFt(v10, 11, 0.02), 7.8, 0.1, 'up 2%')
  // Runaway grades: 7.5% at 8, 4.7% at 11, 3.6% at 13.
  near(runawayGrade(8) * 100, 7.5, 0.05, 'runaway at 8')
  near(runawayGrade(11) * 100, 4.7, 0.05, 'runaway at 11')
  near(runawayGrade(13) * 100, 3.6, 0.05, 'runaway at 13')

  // The card: 10 ft, 3 in downhill at stimp 13 plays like 5.0 ft and is a 4.1 ft stroke at 11.
  const down = readPutt(10, -3, 13)
  near(down.playsLikeFt, 5.0, 0.1, 'downhill plays like')
  near(down.stimp11Ft, 4.1, 0.1, 'downhill stimp-11 stroke')
  const up = readPutt(10, 3, 13)
  near(up.playsLikeFt, 14.0, 0.1, 'uphill plays like')
  near(up.stimp11Ft, 11.8, 0.1, 'uphill stimp-11 stroke')
  // Flat at 11: everything is the putt itself.
  const flat = readPutt(18, 0, 11)
  near(flat.playsLikeFt, 18, 0.01, 'flat plays like')
  near(flat.stimp11Ft, 18, 0.01, 'flat stimp-11')
  // Too steep to stop: 4.5% downhill at stimp 13.
  const steep = readPutt(20, -0.045 * 20 * 12, 13)
  assert.equal(steep.runaway, true)
  assert.equal(steep.playsLikeFt, null)
  // A stimp the green can't have is read as 11.
  assert.equal(readPutt(10, 0, 40).stimp, 11)
  assert.equal(feetInches(-59), '4 ft 11 in')
  assert.equal(feetInches(7.4), '7 in')
  // Break on a plane: rolling across the slope matches the 1-D model along it, and a side slope bends it downhill.
  const flatGreen = () => [0, 0]
  const flatRoll = rollOnGreen(flatGreen, [0, 0], 0, puttSpeedFor(20, 11), 11)
  near(flatRoll.end[1] * 3, 20, 0.15, 'flat roll on the slope field')
  near(flatRoll.end[0], 0, 1e-6, 'flat roll stays straight')
  const downhill = () => [0, -0.02]
  near(rollOnGreen(downhill, [0, 0], 0, puttSpeedFor(10, 11), 11).end[1] * 3, 13.9, 0.2, 'down 2% on the field')
  // Green falls to the right (+x lower): a straight putt bends right, so the aim is left.
  const fallsRight = () => [-0.02, 0]
  const bent = rollOnGreen(fallsRight, [0, 0], 0, puttSpeedFor(15, 11), 11)
  assert.ok(bent.end[0] > 0.1, `side slope bends it downhill: ${bent.end[0]}`)
  const aim = aimPutt(fallsRight, [0, 0], [0, 5], 11)
  assert.ok(aim && aim.aimOffsetFt < -0.3, `aim left of the hole: ${aim?.aimOffsetFt}`)
  assert.ok(aim.roll.closestToHoleYds < 0.05, `the aimed putt goes over the hole: ${aim.roll.closestToHoleYds}`)
  const noBreak = aimPutt(flatGreen, [0, 0], [0, 5], 11)
  near(noBreak.aimOffsetFt, 0, 0.05, 'flat green, aim at the hole')
  console.log('putt read ok')
} finally {
  await server.close()
}
