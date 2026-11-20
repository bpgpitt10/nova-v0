// GSPro 4's Player.log -> the round's course type, firmness and altitude.
// Line formats copied from a real Player.log (sim PC, 2026-11-18).
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

const db = new Map()
const listeners = []
globalThis.window = {
  localStorage: { getItem: (k) => db.get(k) ?? null, setItem: (k, v) => db.set(k, String(v)), removeItem: (k) => db.delete(k) },
  dispatchEvent: (event) => { listeners.forEach((l) => l(event)); return true },
}
globalThis.CustomEvent ??= class { constructor(type, init) { this.type = type; this.detail = init?.detail } }

const shot = (green, fairway, type, altitude, extra = '') => [
  '* ------- Shot Fired! ------- *',
  'LaunchExt Vars: sp 94.4, el 22.4, az 0, ts 8646, sa 0, cy 0, id 132',
  `Physics Settings: Green Firmness ${green}     Fairway Firmness ${fairway}    Course Type ${type}`,
  'LaunchExt - Regular Mode',
  extra,
  'opt -matFriction count 1 :: SpinFriction 10.094, Mat tvgsand (instance)',
  altitude == null ? '' : `magnitude: 1.699225 | yForce 1.200074 | material TVGsand | SoundMultiplier 0.05385188 | SoundForceScale 0.1077038 | elevation ${altitude}`,
].join('\n') + '\n'

const file = (text) => ({
  size: text.length,
  lastModified: text.length,
  slice: (start) => ({ text: async () => text.slice(start) }),
})

try {
  const log = await load('/src/adapters/gsproLogConditions.ts')
  const core = await load('/src/adapters/browserGsproCourseStateCore.ts')

  // The parser: latest settings line and latest altitude.
  assert.equal(log.parseGsproLogConditions('nothing here'), null)
  const one = log.parseGsproLogConditions(shot(1, 2, 0, 2851))
  assert.deepEqual(
    [one.courseType, one.greenFirmness, one.fairwayFirmness, one.altitudeFt, one.shotCount],
    ['soft', 'medium', 'firm', 2851, 1],
  )
  const two = log.parseGsproLogConditions(shot(0, 0, 1, 482) + shot(2, 1, 2, 112))
  assert.deepEqual([two.courseType, two.greenFirmness, two.fairwayFirmness, two.altitudeFt, two.shotCount], ['firm', 'firm', 'medium', 112, 2])
  // Settings seen, ball still in the air: no altitude yet.
  assert.equal(log.parseGsproLogConditions(shot(1, 1, 1, null)).altitudeFt, null)
  // A value GSPro never uses is not guessed at.
  assert.equal(log.parseGsproLogConditions('Physics Settings: Green Firmness 7     Fairway Firmness 1    Course Type 0'), null)

  // Watching: what is already in the log when Looper first looks is an earlier
  // round, possibly on other settings, so it is not used.
  core.__resetPlayerLogWatchForTests()
  log.__resetGsproLogConditionsForTests()
  const earlier = shot(2, 2, 2, 20)
  await core.readPlayerLog(file(earlier))
  assert.equal(log.latestGsproLogConditions(), null, 'an earlier round is not this round')

  // The first shot of this round.
  const seen = []
  listeners.push((event) => seen.push(event.detail))
  const first = earlier + shot(0, 1, 1, null)
  await core.readPlayerLog(file(first))
  assert.deepEqual(
    [log.latestGsproLogConditions().courseType, log.latestGsproLogConditions().greenFirmness, log.latestGsproLogConditions().fairwayFirmness],
    ['medium', 'soft', 'medium'],
  )
  assert.equal(log.latestGsproLogConditions().altitudeFt, null)
  assert.equal(seen.length, 1)

  // It lands: the altitude arrives in a later read, which only holds new text.
  const landed = first + 'magnitude: 1.6 | yForce 1.2 | material TVGfairway | SoundMultiplier 0.05 | SoundForceScale 0.1 | elevation 2851\n'
  await core.readPlayerLog(file(landed))
  assert.equal(log.latestGsproLogConditions().altitudeFt, 2851)
  assert.equal(log.latestGsproLogConditions().courseType, 'medium')

  // More log with no shot in it changes nothing and tells nobody.
  const told = seen.length
  await core.readPlayerLog(file(landed + 'UnloadTime: 2.1 ms\n'.repeat(400)))
  assert.equal(seen.length, told)
  assert.equal(log.latestGsproLogConditions().altitudeFt, 2851)

  // A lie penalty in the new log is learned from.
  const penalties = await load('/src/adapters/gsproPenaltyLog.ts')
  const before = penalties.loadPenaltySamples().length
  const withPenalty = landed + 'UnloadTime: 2.1 ms\n'.repeat(400)
    + shot(0, 1, 1, 2851, 'Penalty Surface TVGdeeprough, Spin53%, Speed 79%, VLA 98%\n ... corrected type 3')
  await core.readPlayerLog(file(withPenalty))
  assert.equal(penalties.loadPenaltySamples().length, before + 1)

  // GSPro reopened: the log starts again, and it is all this session's.
  await core.readPlayerLog(file(shot(2, 2, 0, 358)))
  assert.deepEqual(
    [log.latestGsproLogConditions().courseType, log.latestGsproLogConditions().greenFirmness, log.latestGsproLogConditions().altitudeFt],
    ['soft', 'firm', 358],
  )

  // The active round takes GSPro's settings and keeps the picked stimp.
  const rounds = await load('/src/liveCaddie/roundRuntime.ts')
  assert.equal(rounds.applyGsproConditionsToActiveRound({ courseType: 'soft', greenFirmness: 'firm', fairwayFirmness: 'firm', altitudeFt: 358 }), null, 'no round, nothing to change')
  const stored = {
    schemaVersion: 'looper-live-caddie-round-v1', id: 'r1', courseId: 'course', teeSet: 'Blue', normalizedTeeSet: 'blue',
    startedAt: new Date().toISOString(), phase: 'armed', startHoleNumber: 1, startShotNumber: 1,
    assumedTeeLocalYds: null, teeEvidence: 'assumed',
    conditions: { courseType: 'medium', greenFirmness: 'medium', fairwayFirmness: 'medium', stimp: 11 },
  }
  db.set('looper.live-caddie.active-round.v1', JSON.stringify(stored))
  if (rounds.loadActiveLiveCaddieRound()) {
    const next = rounds.applyGsproConditionsToActiveRound({ courseType: 'soft', greenFirmness: 'firm', fairwayFirmness: 'firm', altitudeFt: 358 })
    assert.deepEqual(next.conditions, { courseType: 'soft', greenFirmness: 'firm', fairwayFirmness: 'firm', stimp: 11 })
    assert.equal(next.conditionsFromGspro, true)
    assert.equal(next.gsproAltitudeFt, 358)
    assert.equal(rounds.loadActiveLiveCaddieRound().conditions.courseType, 'soft')
    // The next shot is still in the air: the altitude already known stays.
    assert.equal(rounds.applyGsproConditionsToActiveRound({ courseType: 'soft', greenFirmness: 'firm', fairwayFirmness: 'firm', altitudeFt: null }).gsproAltitudeFt, 358)
  } else {
    assert.fail('the test could not store an active round')
  }

  console.log('GSPro log conditions: ok')
} finally {
  await server?.close()
}
