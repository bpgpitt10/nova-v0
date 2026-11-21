// Live Caddie records survive a full browser (Andrew, 14 to 20 Nov: none were saved),
// and a shot hit without arming a club still records what Looper recommended.
import assert from 'node:assert/strict'

// A browser whose storage takes at most `quota` characters in total, like a full one.
class QuotaStorage {
  constructor(quota) { this.quota = quota; this.map = new Map(); this.refused = 0 }
  get length() { return this.map.size }
  key(index) { return [...this.map.keys()][index] ?? null }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  removeItem(key) { this.map.delete(key) }
  clear() { this.map.clear() }
  used(except) { let n = 0; for (const [k, v] of this.map) if (k !== except) n += k.length + v.length; return n }
  setItem(key, value) {
    if (this.used(key) + key.length + String(value).length > this.quota) {
      this.refused += 1
      const error = new Error('The quota has been exceeded.')
      error.name = 'QuotaExceededError'
      throw error
    }
    this.map.set(key, String(value))
  }
}

const target = new EventTarget()
const storage = new QuotaStorage(Infinity)
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

try {
  const attribution = await load('/src/lib/liveClubAttribution.ts')
  const { shownRecommendationBefore, noteShownRecommendation, SHOWN_MAX_AGE_MS } = attribution

  // --- What was on screen just before the shot ---
  const t = (s) => new Date(Date.UTC(2026, 10, 20, 19, 0, s)).toISOString()
  const samples = [
    { recommendedClub: '6i', intent: null, seenAt: t(0) }, // the previous spot
    { recommendedClub: '8i', intent: null, seenAt: t(10) },
    { recommendedClub: '8i', intent: null, seenAt: t(12) },
    { recommendedClub: 'PW', intent: null, seenAt: t(20) }, // after the shot: the next spot
  ]
  assert.equal(shownRecommendationBefore(t(13), null, samples)?.recommendedClub, '8i')
  assert.equal(shownRecommendationBefore(t(13), t(5), samples)?.seenAt, t(12))
  assert.equal(shownRecommendationBefore(t(4), t(5), samples), null, 'only the previous spot was on screen')
  assert.equal(shownRecommendationBefore(t(20 + SHOWN_MAX_AGE_MS / 1000 + 1), null, samples), null, 'page not showing it any more')
  assert.equal(shownRecommendationBefore('not a time', null, samples), null)

  // --- Records when the browser's storage is full ---
  const { loadLiveCaddieLineageStore, startLiveCaddieShotLineage } = await load('/src/liveCaddie/shotLineageStore.ts')
  const { LIVE_CADDIE_START_ROUND_EVENT, LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT } = await load('/src/liveCaddie/roundRuntime.ts')
  const stop = startLiveCaddieShotLineage()
  const state = (n) => target.dispatchEvent(new CustomEvent(LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT, {
    detail: { key: `302:${n}:1:none`, courseKey: 'georgiacc_v2_gsp', roundId: 302, holeNumber: n, nextShotNumber: 1, source: 'gspro' },
  }))

  target.dispatchEvent(new CustomEvent(LIVE_CADDIE_START_ROUND_EVENT, { detail: { startedAt: t(0) } }))
  state(1)
  assert.equal(loadLiveCaddieLineageStore().records.filter((r) => r.recordType === 'state').length, 1)

  // Fill the browser: nothing more fits.
  storage.quota = storage.used()
  state(2)
  state(3)
  const full = loadLiveCaddieLineageStore()
  assert.ok(storage.refused > 0, 'the browser refused the save')
  assert.equal(full.records.filter((r) => r.recordType === 'state').length, 3,
    'records made while the browser is full are kept (and linked) in the page')
  assert.ok(full.activeRoundId, 'the round carries on')

  // Room again (another page freed some): the next save goes to the browser, trimmed if need be.
  storage.quota = Infinity
  state(4)
  const raw = JSON.parse(storage.getItem('looper-live-caddie-lineage-v1'))
  assert.equal(raw.records.filter((r) => r.recordType === 'state').length, 4, 'saved to the browser again')

  // A store too big for the browser is trimmed to the newest records, not dropped.
  const big = loadLiveCaddieLineageStore()
  const pad = 'x'.repeat(2000)
  for (let i = 0; i < 1300; i += 1) {
    big.records.push({ ...big.records[0], id: `old-${i}`, recordType: 'state', payload: { shotStateKey: `old-${i}`, pad } })
  }
  storage.setItem('looper-live-caddie-lineage-v1', JSON.stringify(big))
  storage.quota = 1_000_000 // about 400 padded records
  state(5)
  const trimmed = JSON.parse(storage.getItem('looper-live-caddie-lineage-v1'))
  assert.ok(trimmed.records.length <= 300 && trimmed.records.length > 0, `trimmed to ${trimmed.records.length}`)
  assert.equal(trimmed.records.at(-1).payload.shotStateKey, '302:5:1:none', 'the newest record survives the trim')

  // An armed club survives a full browser too.
  storage.quota = storage.used()
  const before = storage.refused
  attribution.armLiveClub('7i', '8i', null)
  assert.ok(storage.refused > before)
  assert.equal(attribution.loadArmedLiveClub()?.club, '7i', 'armed club kept in the page')
  attribution.clearArmedLiveClub()
  assert.equal(attribution.loadArmedLiveClub(), null)
  noteShownRecommendation({ recommendedClub: '9i', intent: null, seenAt: new Date().toISOString() })
  assert.equal(shownRecommendationBefore(new Date(Date.now() + 1000).toISOString())?.recommendedClub, '9i')

  stop()
  console.warn = warn
  console.log('lineage durable: ok')
} finally {
  console.warn = warn
  await server?.close()
}
process.exit(0)
