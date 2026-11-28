// Live Caddie's shot records label GSPro's surface codes from the same confirmed
// table as the rest of the app. The records had their own copy that still called
// code 3 (deep rough) sand: 19 deep-rough shots in 30 days were stored as sand.
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

const t = (m) => new Date(Date.UTC(2026, 10, 27, 22, m, 0)).toISOString()
const shot = (shotId, holeShot, startingSurfaceRaw, endingSurfaceRaw, observedAt) => ({
  key: `311:4:${shotId}`, roundId: 311, courseKey: 'ArcadiaBluffs_v1_gsp', shotId, holeNumber: 4, holeShot,
  globalShotNumber: holeShot, observedAt, startingSurfaceRaw, endingSurfaceRaw,
  distanceToPinYds: 120, ballSpeedMph: 95, carryYards: 120, totalYards: 125,
  verticalLaunchAngleDegrees: 22, horizontalLaunchAngleDegrees: 0, totalSpinRpm: 6000, spinAxisDegrees: 0,
  isHoled: false, isGimme: false,
  actualClub: '9i', recommendedClub: null, clubSource: 'user', includeInAnalysis: true, attributedAt: null,
  clubInference: null,
})

try {
  const { loadLiveCaddieLineageStore, startLiveCaddieShotLineage } = await load('/src/liveCaddie/shotLineageStore.ts')
  const { LIVE_CADDIE_START_ROUND_EVENT } = await load('/src/liveCaddie/roundRuntime.ts')

  storage.setItem('looper-live-gspro-round-archive-v1', JSON.stringify({ version: 1, rounds: [] }))
  const stop = startLiveCaddieShotLineage()
  target.dispatchEvent(new CustomEvent(LIVE_CADDIE_START_ROUND_EVENT, { detail: { startedAt: t(0) } }))

  // 3 deep rough, 11 sand, 16 pine straw (played as rough), 1 rough, 2 fairway.
  const shots = [
    shot('a', 2, 3, 11, t(1)),
    shot('b', 3, 11, 16, t(2)),
    shot('c', 4, 16, 1, t(3)),
    shot('d', 5, 1, 2, t(4)),
  ]
  storage.setItem('looper-live-gspro-round-archive-v1', JSON.stringify({
    version: 1,
    rounds: [{ id: 'r311', roundId: 311, courseKey: 'ArcadiaBluffs_v1_gsp', firstObservedAt: t(1), lastObservedAt: t(4), shots, schemaVersion: 1 }],
  }))
  await new Promise((resolve) => setTimeout(resolve, 1200)) // one reconcile pass

  const records = loadLiveCaddieLineageStore().records
  const attempt = (id) => records.find((r) => r.recordType === 'shot_attempt' && r.gsproShotId === id)
  const expected = { a: ['deep-rough', 'sand'], b: ['sand', 'rough'], c: ['rough', 'rough'], d: ['rough', 'fairway'] }
  for (const [id, [start, end]] of Object.entries(expected)) {
    const row = attempt(id)
    assert.ok(row, `shot ${id} recorded`)
    assert.equal(row.payload.gsproStartingSurface, start, `shot ${id} starting surface`)
    assert.equal(row.payload.gsproEndingSurface, end, `shot ${id} ending surface`)
    const pre = records.find((r) => r.id === row.stateId)
    assert.equal(pre.payload.surface, start, `shot ${id}: the spot built from GSPro's record has the same surface`)
    assert.equal(row.payload.modeledSurface, start)
  }
  assert.notEqual(attempt('a').payload.gsproStartingSurface, 'sand', 'deep rough is not sand')

  stop()
  console.warn = warn
  console.log('lineage surface codes: ok')
} finally {
  console.warn = warn
  await server?.close()
}
process.exit(0)
