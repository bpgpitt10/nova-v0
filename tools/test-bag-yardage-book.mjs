// Bag yardage book: every row must match what Club Detail shows for the same
// club + variant, variants stay separate, and mishit rates only count shots the
// classifier could actually call.
import assert from 'node:assert/strict'

// Custom variants live in localStorage; give the modules a minimal one.
const storage = new Map()
globalThis.window ??= {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  location: { hostname: 'localhost', pathname: '/', search: '', hash: '', origin: 'http://localhost' },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
}
window.localStorage.setItem(
  'nova-shot-variants',
  JSON.stringify([
    { id: 'three-quarter', name: '3/4' },
    { id: 'punch', name: 'Punch' },
  ]),
)

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

const book = await load('/src/lib/bagYardageBook.ts')
const { installMishitPlanningState } = await load('/src/lib/mishitPlanningPopulation.ts')
const { isShotIncludedInAnalysis, sessionHistoricalWeightForClub } = await load('/src/lib/historicalModel.ts')
const { buildShotProfilesForIdentity } = await load('/src/lib/shotProfiles.ts')
const { summarizeReviewClub } = await load('/src/lib/scoring.ts')
const { shotsForClubVariant } = await load('/src/lib/shotVariants.ts')

const DAY = 24 * 60 * 60 * 1000
const nowMs = Date.parse('2026-10-31T12:00:00Z')
let shotCounter = 0
const shot = (club, variant, daysAgo, carry, offline, ballSpeed) => {
  shotCounter += 1
  return {
    id: `s${shotCounter}`,
    club,
    shotVariantId: variant,
    included: true,
    capturedAt: new Date(nowMs - daysAgo * DAY + shotCounter * 1000).toISOString(),
    enrichmentStatus: 'raw_only',
    source: 'mock',
    carryYards: carry,
    totalYards: carry + 8,
    offlineYards: offline,
    ballSpeedMph: ballSpeed,
    verticalLaunchAngleDegrees: 17,
    totalSpinRpm: 6800,
  }
}
const wobble = (i, size) => ((i * 7) % 11 - 5) * (size / 5)

const recent = []
const older = []
for (let i = 0; i < 30; i += 1) recent.push(shot('7i', undefined, 1, 150 + wobble(i, 5), 2 + wobble(i, 3), 120 + wobble(i, 2)))
for (let i = 0; i < 10; i += 1) older.push(shot('7i', undefined, 5, 148 + wobble(i, 5), 1 + wobble(i, 3), 119 + wobble(i, 2)))
// Three obvious mishits on the full 7 iron.
recent.push(shot('7i', undefined, 1, 92, 26, 86), shot('7i', undefined, 1, 88, -24, 84), shot('7i', undefined, 1, 95, 22, 88))
for (let i = 0; i < 8; i += 1) recent.push(shot('7i', 'three-quarter', 1, 134 + wobble(i, 3), -1 + wobble(i, 2), 110))
recent.push(shot('7i', 'punch', 1, 120, 0, 100), shot('7i', 'punch', 1, 118, 1, 99))
for (let i = 0; i < 3; i += 1) recent.push(shot('PW', undefined, 1, 126 + i, 0, 100))

const sessions = [
  { id: 'recent', startedAt: new Date(nowMs - DAY - 3600e3).toISOString(), endedAt: new Date(nowMs - DAY).toISOString(), shots: recent },
  { id: 'older', startedAt: new Date(nowMs - 5 * DAY - 3600e3).toISOString(), endedAt: new Date(nowMs - 5 * DAY).toISOString(), shots: older },
]
installMishitPlanningState(sessions)

// What Club Detail computes, written out the way App.tsx does it.
const clubDetail = (club, variantId) => {
  const variantSessions = sessions.map((session) => ({
    ...session,
    shots: shotsForClubVariant(session.shots, club, variantId).filter(isShotIncludedInAnalysis),
  }))
  const shots = variantSessions.flatMap((session) => session.shots)
  const weights = new Map()
  sessions.forEach((session) => {
    const identity = shotsForClubVariant(session.shots, club, variantId).filter(isShotIncludedInAnalysis)
    const sessionWeight = sessionHistoricalWeightForClub(session, club, nowMs)
    const each = identity.length > 0 ? sessionWeight / identity.length : 0
    identity.forEach((s) => { if (!weights.has(s.id)) weights.set(s.id, each) })
  })
  return {
    profiles: buildShotProfilesForIdentity({ shots, club, shotWeightsById: weights }),
    summary: summarizeReviewClub(club, shots, variantSessions, null),
  }
}

const result = book.buildYardageBook(sessions, ['7i', 'PW'], nowMs)
const seven = result.clubs.find((entry) => entry.club === '7i')
const pw = result.clubs.find((entry) => entry.club === 'PW')

// 1. Stock, Pure and Trust match Club Detail exactly, for the full swing and a variant.
for (const [row, variantId] of [[seven.row, 'stock'], [seven.variants.find((r) => r.variantId === 'three-quarter'), 'three-quarter']]) {
  const expected = clubDetail('7i', variantId)
  assert.equal(row.stock.carry, expected.profiles.mostLikely.carry)
  assert.equal(row.stock.total, expected.profiles.mostLikely.total)
  assert.equal(row.pure.carry, expected.profiles.bestAvailable.carry)
  assert.equal(row.pure.total, expected.profiles.bestAvailable.total)
  assert.equal(row.missOffline, expected.profiles.mostLikely.offlineMean)
  assert.equal(row.trust.score, expected.summary.caddieScore)
  assert.equal(row.trust.call, expected.summary.caddieCall)
}

// 2. Variants stay separate: the full-swing row is not dragged down by 3/4 swings.
const threeQuarter = seven.variants.find((r) => r.variantId === 'three-quarter')
assert.ok(seven.row.stock.carry > 144, `full stock carry ${seven.row.stock.carry}`)
assert.ok(threeQuarter.stock.carry < 140, `3/4 stock carry ${threeQuarter.stock.carry}`)
assert.equal(threeQuarter.swings, 8)
assert.equal(seven.row.variantName, 'Full')
assert.deepEqual(seven.variants.map((r) => r.variantName), ['3/4', 'Punch'])

// 3. Mishits are excluded from the yardages and counted against classified shots only.
assert.equal(seven.row.swings, 40, 'the three mishits are not planning swings')
assert.equal(seven.row.mishits.classifiedShots, 43)
assert.ok(Math.abs(seven.row.mishits.rate - 3 / 43) < 1e-9, `mishit rate ${seven.row.mishits.rate}`)
assert.ok(seven.row.mishits.severeRate <= seven.row.mishits.rate)

// 4. Middle 50% sits around the stock carry and inside the real spread.
assert.ok(seven.row.middleHalf.low <= seven.row.stock.carry && seven.row.stock.carry <= seven.row.middleHalf.high)
assert.ok(seven.row.middleHalf.low >= 140 && seven.row.middleHalf.high <= 160)

// 5. Thin samples: flagged, and no fake 0% mishit rate before the classifier has a baseline.
const punch = seven.variants.find((r) => r.variantId === 'punch')
assert.equal(punch.needsData, true)
assert.equal(punch.swings, 2)
assert.equal(punch.mishits, null)
assert.equal(pw.row.needsData, true)
assert.equal(pw.row.mishits, null)
assert.deepEqual(pw.variants, [], 'variants with no shots for a club are not listed')

// 6. Header totals and miss formatting.
assert.equal(result.totalSwings, 40 + 8 + 2 + 3)
assert.equal(book.formatMiss(3.6), '4 R')
assert.equal(book.formatMiss(-2.4), '2 L')
assert.equal(book.formatMiss(0.3), 'Straight')
assert.equal(book.formatMiss(null), '–')

if (server) await server.close()
console.log('bag yardage book: ok')
