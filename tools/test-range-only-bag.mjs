// The bag (session history) is range data only: course rounds once copied in as
// "gspro-live-round-N" sessions are dropped on load; range sessions stay.
import assert from 'node:assert/strict'

const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  location: { hostname: 'localhost', href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '' },
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
}

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
try {
  const sessions = await load('/src/lib/sessions.ts')
  const { SESSION_HISTORY_STORAGE_KEY } = await load('/src/lib/localUserScope.ts')
  const shot = (id, club) => ({ id, club, included: true, capturedAt: '2026-11-03T15:00:00Z', carryYards: 220, source: 'simread' })
  store.set(SESSION_HISTORY_STORAGE_KEY, JSON.stringify([
    { id: 'gspro-live-round-273', startedAt: '2026-11-03T15:00:00Z', shots: [shot('gspro-live:273:a', '3W')] },
    { id: 'range-1', startedAt: '2026-11-01T15:00:00Z', shots: [shot('r1', '3W')] },
  ]))
  const loaded = sessions.loadSavedSessions()
  assert.deepEqual(loaded.map((s) => s.id), ['range-1'])
  assert.equal(sessions.isCourseRoundSession({ id: 'gspro-live-round-9' }), true)
  assert.equal(sessions.isCourseRoundSession({ id: 'range-1' }), false)
  console.log('PASS: course rounds stay out of the bag; range sessions kept.')
} finally {
  await server?.close()
}
