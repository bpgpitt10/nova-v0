// Player-facing course and error text says what the player gets, never how Looper gets it
// (Brian, 11/8), and every state has a code we can decode.
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
try {
  const { courseStatusView, SCREEN_ONLY_STATUS, ERROR_TEXT, supportLine, ocrLetter } = await load('/src/lib/supportCodes.ts')

  const FORBIDDEN = /course file|gkd|openstreetmap|osm\b|lidar|grade|registr|match|fit\b|green layout|anchor|package|ocr|minimap/i
  const states = [
    { state: 'ready', courseKey: 'k', grade: 'B', courseName: 'X', layoutNames: [], via: 'companion' },
    { state: 'ready', courseKey: 'k', grade: 'C', courseName: 'X', layoutNames: [], via: 'companion', gsproOnly: true },
    { state: 'other-course', courseKey: 'a', expectedKey: 'b', grade: 'A' },
    { state: 'other-course', courseKey: 'a', expectedKey: 'b' },
    { state: 'layout-mismatch', courseKey: 'k' },
    { state: 'registration-failed', courseKey: 'k', reason: 'fit 3.1 m' },
    { state: 'error', message: 'boom' },
    { state: 'registering', courseKey: 'k' },
    { state: 'no-course' },
    { state: 'no-registration', courseName: 'X' },
    { state: 'no-folder' },
    { state: 'gkd-not-found', courseKey: 'k' },
    { state: 'needs-permission' },
    { state: 'off' },
  ]
  const expected = ['C1B', 'C3', 'C1A', 'C7', 'C2m', 'C2f', 'C2e', 'C5', 'C5', 'C6', 'C6', 'C8', 'C9', 'C0']
  states.forEach((status, i) => {
    const view = courseStatusView(status)
    assert.equal(view.code, expected[i], status.state)
    assert.ok(!FORBIDDEN.test(view.text), `${status.state}: "${view.text}"`)
    assert.ok(view.text.length > 5)
  })
  // Honest tiers: basic is not "ready" and says what's missing; full says what's there.
  assert.match(courseStatusView(states[1]).text, /^Basic course/)
  assert.match(courseStatusView(states[1]).text, /No fairways, bunkers or trees/)
  assert.equal(courseStatusView(states[1]).action, 'load-full-course')
  assert.match(courseStatusView(states[0]).text, /^Full course/)
  assert.match(courseStatusView(states[4]).text, /estimated/)
  assert.equal(SCREEN_ONLY_STATUS.code, 'C4')
  for (const [code, text] of Object.entries(ERROR_TEXT)) assert.ok(!FORBIDDEN.test(text), `${code}: "${text}"`)

  assert.equal(supportLine({ '': 'C1B', G: 'con', B: 'gkd', P: null, O: 'RRU', v: '1.0.1', H: 4 }), 'C1B · G con · B gkd · O RRU · v 1.0.1 · H 4')
  assert.equal(ocrLetter('READY') + ocrLetter('UNKNOWN') + ocrLetter('UNAVAILABLE') + ocrLetter(undefined), 'RUX-')

  console.log('support codes: ok')
} finally {
  if (server) await server.close()
}
