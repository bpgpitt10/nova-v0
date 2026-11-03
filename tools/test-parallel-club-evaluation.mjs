// Splitting the bag across parallel workers must give exactly the same
// recommendation as evaluating every club in one worker.
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

const { evaluateAimLab, shortestSupportedModeledCarryYds } = await load('/src/liveCaddie/aimOptimization.ts')
const { rerankClubs } = await load('/src/liveCaddie/clubRerank.ts')
const { nextStateValueForAimCandidate } = await load('/src/liveCaddie/aimDecisionRanking.ts')
const { greywolfHole01Geometry: hole } = await load('/src/courseGeometry/greywolfHole01.ts')

const now = Date.parse('2026-10-13T13:00:00Z')
const bag = ['Driver', '3W', '5i', '7i', '9i', 'PW']
const carry = [247, 217, 186, 156, 132, 118]
const shots = bag.flatMap((club, k) => Array.from({ length: 11 }, (_, i) => ({
  id: club + '-' + i, club, included: true, enrichmentStatus: 'enriched', source: 'simread',
  capturedAt: new Date(now - (i + 1) * 1000).toISOString(),
  carryYards: carry[k] + ((i % 3) - 1) * 4, totalYards: carry[k] + 14 + ((i % 3) - 1) * 4,
  offlineYards: (i % 5) - 2, ballSpeedMph: [147, 133, 123, 113, 104, 98][k],
  launchAngleDeg: [13, 13, 14, 17, 21, 24][k], spinRpm: [2700, 3500, 5000, 6000, 7600, 8600][k],
})))
const sessions = [{ id: 'parallel-fixture', startedAt: new Date(now - 240000).toISOString(),
  endedAt: new Date(now - 1000).toISOString(), shots }]
const tee = hole.markers.tee
const target = [tee[0], tee[1] + 230]
const environment = { shotOrigin: 'tee', surfaceOverride: 'tee', windMph: 8, windRelativeDeg: 40 }

const summary = (evaluations) => evaluations.map((e) => ({
  club: e.club, rank: e.decisionRank, aim: e.bestCandidate?.aimOffsetYds ?? null,
  strokes: nextStateValueForAimCandidate(e.bestCandidate)?.expectedFutureStrokes ?? null,
  reason: e.decisionReason,
}))

const single = rerankClubs(evaluateAimLab(sessions, hole, tee, target, environment, now))
for (const parallelism of [2, 3, 4]) {
  const groups = Array.from({ length: parallelism }, (_, g) => bag.filter((_, i) => i % parallelism === g))
  const merged = rerankClubs(groups.flatMap((onlyClubs) =>
    evaluateAimLab(sessions, hole, tee, target, { ...environment, onlyClubs }, now)))
  assert.deepEqual(summary(merged), summary(single), `${parallelism} workers`)
}
assert.equal(single.length, bag.length)

// The bag-wide short-game check is the same number a full evaluation gives.
const full = evaluateAimLab(sessions, hole, tee, target, environment, now)
const expected = Math.min(...full.filter((e) => e.supportShots > 0).map((e) => e.modeledCarryYds))
assert.ok(Math.abs(shortestSupportedModeledCarryYds(sessions, hole, tee, target, environment, now) - expected) < 1e-9)

// Out of reach of the green: every club plans at the fairway centre at its own
// carry toward the pin (Driver deeper than 7i), parallel still identical.
const pin = hole.markers.pin
const layup = { ...environment, layupPin: pin }
const own = evaluateAimLab(sessions, hole, tee, target, layup, now)
const depth = (e) => Math.hypot(e.planningTarget[0] - tee[0], e.planningTarget[1] - tee[1])
const byClub = Object.fromEntries(own.map((e) => [e.club, e]))
assert.ok(Math.abs(depth(byClub.Driver) - Math.min(byClub.Driver.modeledCarryYds, Math.hypot(pin[0] - tee[0], pin[1] - tee[1]))) < 3,
  `Driver plans at its carry: ${depth(byClub.Driver)} vs ${byClub.Driver.modeledCarryYds}`)
assert.ok(depth(byClub.Driver) > depth(byClub['7i']) + 50, 'each club at its own depth')
// Inside reach of the green: clubs that get there keep the shared target, the
// rest lay up at their own carry.
const near = [tee[0] + (pin[0] - tee[0]) * 0.5, tee[1] + (pin[1] - tee[1]) * 0.5]
const nearDist = Math.hypot(pin[0] - near[0], pin[1] - near[1])
const nearEval = Object.fromEntries(evaluateAimLab(sessions, hole, near, pin, { ...environment, shotOrigin: 'fairway', surfaceOverride: 'fairway', layupPin: pin }, now).map((e) => [e.club, e]))
for (const e of Object.values(nearEval)) {
  const d = Math.hypot(e.planningTarget[0] - near[0], e.planningTarget[1] - near[1])
  if (e.modeledCarryYds >= nearDist - 25) assert.deepEqual(e.planningTarget, pin, `${e.club} goes for the green`)
  else assert.ok(Math.abs(d - e.modeledCarryYds) < 3, `${e.club} lays up at its carry: ${d} vs ${e.modeledCarryYds}`)
}
const ownSingle = rerankClubs(own)
const ownMerged = rerankClubs([['Driver', '5i', '9i'], ['3W', '7i', 'PW']].flatMap((onlyClubs) =>
  evaluateAimLab(sessions, hole, tee, target, { ...layup, onlyClubs }, now)))
assert.deepEqual(summary(ownMerged), summary(ownSingle), 'per-club targets, 2 workers')

if (server) await server.close()
console.log('parallel club evaluation: identical to one worker; per-club lay-up targets at each carry')
