// "Installed but not running" vs "never installed": the browser only sees silence, so we remember
// when a companion has answered here.
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
  const store = new Map()
  globalThis.window = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    addEventListener() {}, removeEventListener() {}, setInterval: () => 0, clearInterval() {},
  }
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, configurable: true })
  const { companionSeenBefore, markCompanionSeen } = await load('/src/lib/companionPresence.ts')
  assert.equal(companionSeenBefore(), null, 'nothing remembered at first')
  markCompanionSeen('1.0.0')
  assert.equal(companionSeenBefore()?.release, '1.0.0')
  store.set('looper.companion-seen.v1', '{broken')
  assert.equal(companionSeenBefore(), null, 'a corrupt entry reads as never seen')
  console.log('PASS: companion seen-before memory.')
} finally {
  await server?.close()
}
