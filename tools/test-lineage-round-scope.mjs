// One Live Caddie session can run across several GSPro rounds (27 Nov: Wildwood
// Green, Arcadia Bluffs, Cabot Cliffs, then the range). Hole and shot numbers
// repeat in every round, so a shot in a later round must not pick up an earlier
// round's spot, locked-in club or record. On 27 Nov a LW pick on Wildwood hole 11
// was attached to four Cabot Cliffs hole 11 shots and a range shot, and 157 of
// 380 shots were tied to another round's spot.
import assert from 'node:assert/strict'

class MemoryStorage {
  constructor() { this.map = new Map() }
  get length() { return this.map.size }
  key(index) { return [...this.map.keys()][index] ?? null }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
  clear() { this.map.clear() }
}

const target = new EventTarget()
const storage = new MemoryStorage()
globalThis.window = Object.assign(target, {
  localStorage: storage,
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clearTimeout,
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t },
  clearInterval,
  location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/' },
})
globalThis.localStorage = storage
const warn = console.warn
console.warn = () => undefined // the cloud is unreachable here; its retries warn

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

const LINEAGE_KEY = 'looper-live-caddie-lineage-v1'
const ARCHIVE_KEY = 'looper-live-gspro-round-archive-v1'
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const t = (m) => new Date(Date.UTC(2026, 10, 27, 21, m, 0)).toISOString()

const shot = (roundId, courseKey, shotId, holeNumber, holeShot, observedAt, extra = {}) => ({
  key: `${roundId}:${holeNumber}:${shotId}`,
  roundId, courseKey, shotId, holeNumber, holeShot, globalShotNumber: holeShot,
  observedAt,
  startingSurfaceRaw: 2, endingSurfaceRaw: 5,
  distanceToPinYds: 8, ballSpeedMph: 55, carryYards: 45, totalYards: 48,
  verticalLaunchAngleDegrees: 30, horizontalLaunchAngleDegrees: 0, totalSpinRpm: 7000, spinAxisDegrees: 0,
  isHoled: false, isGimme: false,
  actualClub: null, recommendedClub: null, clubSource: null, includeInAnalysis: true, attributedAt: null,
  clubInference: { predictedClub: 'GW', confidence: 0.6, alternatives: [], modelVersion: 'test', evaluatedAt: observedAt, metricsUsed: [] },
  ...extra,
})

const writeArchive = (rounds) => storage.setItem(ARCHIVE_KEY, JSON.stringify({ version: 1, rounds }))
const round = (roundId, courseKey, shots) => ({
  id: `r${roundId}`, roundId, courseKey, firstObservedAt: shots[0]?.observedAt ?? t(0),
  lastObservedAt: shots.at(-1)?.observedAt ?? t(0), shots, schemaVersion: 1,
})

try {
  const { loadLiveCaddieLineageStore, startLiveCaddieShotLineage } = await load('/src/liveCaddie/shotLineageStore.ts')
  const { LIVE_CADDIE_START_ROUND_EVENT, LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT } = await load('/src/liveCaddie/roundRuntime.ts')

  writeArchive([])
  const stop = startLiveCaddieShotLineage()
  target.dispatchEvent(new CustomEvent(LIVE_CADDIE_START_ROUND_EVENT, { detail: { startedAt: t(0) } }))

  // Wildwood Green (round 310), hole 11, second shot: Live Caddie sees the spot.
  target.dispatchEvent(new CustomEvent(LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT, {
    detail: {
      key: '310:11:2:ww', courseKey: 'WildwoodGreen_GSP', roundId: 310, holeNumber: 11, nextShotNumber: 2,
      distanceToPinYds: 49, surface: 'fairway', surfaceSource: 'currentRound', source: 'gspro', latestShotKey: '310:11:tee',
    },
  }))
  await settle()

  // The player locks in LW there.
  const store = JSON.parse(storage.getItem(LINEAGE_KEY))
  const wildwoodState = store.records.find((r) => r.recordType === 'state' && r.gsproRoundId === 310)
  assert.ok(wildwoodState, 'Wildwood spot recorded')
  store.records.push({
    id: 'spec-ww-11', lineageRoundId: store.activeRoundId, recordType: 'shot_spec', createdAt: t(1),
    supersedesId: null, stateId: wildwoodState.id, decisionId: null, shotSpecId: 'spec-ww-11',
    attemptId: null, outcomeId: null, gsproRoundId: null, gsproShotId: null,
    payload: { club: 'LW', recommendedClub: 'LW', status: 'armed', modeledSurface: 'fairway', modeledSurfaceSource: 'currentRound' },
  })
  storage.setItem(LINEAGE_KEY, JSON.stringify(store))

  // The LW is hit on Wildwood: it links to that pick.
  const wildwoodShot = shot(310, 'WildwoodGreen_GSP', 'ww-11-2', 11, 2, t(2), { actualClub: 'LW', clubSource: 'user' })
  writeArchive([round(310, 'WildwoodGreen_GSP', [wildwoodShot])])
  await new Promise((resolve) => setTimeout(resolve, 1200)) // one reconcile pass
  let records = loadLiveCaddieLineageStore().records
  const wildwoodAttempt = records.find((r) => r.recordType === 'shot_attempt' && r.gsproShotId === 'ww-11-2')
  assert.ok(wildwoodAttempt, 'Wildwood shot recorded')
  assert.equal(wildwoodAttempt.shotSpecId, 'spec-ww-11', 'the Wildwood shot links to its pick')
  assert.equal(wildwoodAttempt.stateId, wildwoodState.id)

  // An hour later, still the same Live Caddie session: Cabot Cliffs (round 312),
  // hole 11 shot 2, with no live spot from GSPro. And a range shot GSPro also
  // numbers hole 11.
  const cabotShot = shot(312, 'cabotcliffs_gsp', 'cc-11-2', 11, 2, t(60))
  const rangeShot = shot(-1, 'Sequoyah_GM_GSP', 'range-1', 11, 2, t(120))
  writeArchive([
    round(310, 'WildwoodGreen_GSP', [wildwoodShot]),
    round(312, 'cabotcliffs_gsp', [cabotShot]),
    round(-1, 'Sequoyah_GM_GSP', [rangeShot]),
  ])
  await new Promise((resolve) => setTimeout(resolve, 1200))
  records = loadLiveCaddieLineageStore().records

  for (const [label, shotId, roundId] of [['Cabot Cliffs', 'cc-11-2', 312], ['range', 'range-1', -1]]) {
    const attempt = records.find((r) => r.recordType === 'shot_attempt' && r.gsproShotId === shotId)
    assert.ok(attempt, `${label} shot recorded`)
    assert.equal(attempt.shotSpecId, null, `${label} shot does not pick up the Wildwood LW pick`)
    assert.equal(attempt.payload.actualClub, null, `${label} shot is not tagged LW from the old pick`)
    assert.equal(attempt.payload.clubAttributionSource, 'inferred')
    assert.notEqual(attempt.stateId, wildwoodState.id, `${label} shot is not tied to the Wildwood spot`)
    const pre = records.find((r) => r.id === attempt.stateId)
    assert.equal(pre?.gsproRoundId, roundId, `${label} shot's spot is from its own round`)
    assert.equal(attempt.supersedesId, null, `${label} shot does not replace another round's record`)
  }

  // The Wildwood record is still the current one for its shot.
  const replacing = records.filter((r) => r.supersedesId === wildwoodAttempt.id)
  assert.equal(replacing.length, 0, 'nothing replaced the Wildwood shot')

  // Re-hit in the same round and slot still replaces, as before.
  const cabotRetry = shot(312, 'cabotcliffs_gsp', 'cc-11-2b', 11, 2, t(61))
  writeArchive([
    round(310, 'WildwoodGreen_GSP', [wildwoodShot]),
    round(312, 'cabotcliffs_gsp', [cabotShot, cabotRetry]),
    round(-1, 'Sequoyah_GM_GSP', [rangeShot]),
  ])
  await new Promise((resolve) => setTimeout(resolve, 1200))
  records = loadLiveCaddieLineageStore().records
  const retry = records.find((r) => r.recordType === 'shot_attempt' && r.gsproShotId === 'cc-11-2b')
  const firstCabot = records.find((r) => r.recordType === 'shot_attempt' && r.gsproShotId === 'cc-11-2')
  assert.equal(retry?.supersedesId, firstCabot.id, 'a retake in the same round still replaces the earlier one')

  stop()
  console.warn = warn
  console.log('lineage round scope: ok')
} finally {
  console.warn = warn
  await server?.close()
}
process.exit(0)
