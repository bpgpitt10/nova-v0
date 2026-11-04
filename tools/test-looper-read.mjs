// The Looper's Read (Club Detail): three lines from the club's own numbers. The
// wording must scale with the size of a change, so a 45-point drop never reads
// as "a touch".
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

const { buildLooperRead, changeWords } = await load('/src/lib/looperRead.ts')

// Brian's 5i on 3 Nov: direction 98, carry expectation 17 (down 45), 15% mishits all severe.
const fiveIron = buildLooperRead({
  clubLabel: '5i',
  call: 'Manage',
  factors: [
    { key: 'distanceWindow', value: 17, delta: -45 },
    { key: 'directionWindow', value: 98, delta: 0 },
    { key: 'flightQuality', value: 64 },
    { key: 'patternStability' },
  ],
  stockCarry: 188,
  carryLow: 182,
  carryHigh: 197,
  missOffline: -3.2,
  swings: 11,
  mishitRate: 0.15,
  severeRate: 0.15,
})
assert.equal(fiveIron.primary, '5i is playable but needs managing: it starts on line, but the distance is the problem.')
assert.equal(fiveIron.explanation, '8 of 10 swings carry 182–197, carry consistency is well below your usual and 15% come off as mishits, 15% severe.')
assert.equal(fiveIron.implication, 'Hit it when anything from 182 to 197 works and aim 3 yd right. With trouble short or long, it isn’t the club for that shot.')
assert.ok(!/a touch/.test(Object.values(fiveIron).join(' ')))

// Wording scales with the change.
assert.equal(changeWords(-45), 'well below your usual')
assert.equal(changeWords(-20), 'below your usual')
assert.equal(changeWords(-12), 'a little below your usual')
assert.equal(changeWords(6), null)
assert.equal(changeWords(31), 'well above your usual')

// A tight, trusted club gets a number; no aim without enough swings or a real miss.
const gapWedge = buildLooperRead({
  clubLabel: 'GW',
  call: 'Attack',
  factors: [
    { key: 'distanceWindow', value: 86, delta: 3 },
    { key: 'directionWindow', value: 82 },
    { key: 'flightQuality', value: 78 },
    { key: 'patternStability', value: 80 },
  ],
  stockCarry: 109,
  carryLow: 103,
  carryHigh: 113,
  missOffline: -2.4,
  swings: 22,
})
assert.equal(gapWedge.primary, 'GW is a green light: the distance is dependable and it starts on line.')
assert.equal(gapWedge.implication, 'Trust 109 carry.')

const fewSwings = buildLooperRead({
  clubLabel: '3W',
  call: 'Careful',
  factors: [{ key: 'distanceWindow', value: 40 }, { key: 'directionWindow', value: 72 }],
  carryLow: 210,
  carryHigh: 238,
  missOffline: -9,
  swings: 6,
})
assert.ok(!/aim/.test(fewSwings.implication), 'no aim suggestion under 8 swings')

const building = buildLooperRead({ clubLabel: 'LW', call: 'Insufficient Data', factors: [] })
assert.equal(building.primary, 'LW is still building its read.')
assert.equal(building.implication, 'Keep the target simple until a few more range swings settle the read.')

console.log('looper read ok:', fiveIron.primary)
await server?.close()
