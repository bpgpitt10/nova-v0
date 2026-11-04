// Start Round holds hole 1 until GSPro moves on (src/adapters/browserGsproCourseState.ts).
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
  const { releasesHoldOnHoleChange } = await load('/src/adapters/browserGsproCourseState.ts')
  // A conceded hole 1 before any shot (11/4 Pebble): GSPro goes 1 -> 2.
  assert.equal(releasesHoldOnHoleChange(1, 2), true)
  // A stale file from the last round (hole 18) while GSPro starts the new round on 1: keep holding.
  assert.equal(releasesHoldOnHoleChange(18, 1), false)
  // ... then the player concedes hole 1.
  assert.equal(releasesHoldOnHoleChange(1, 2), true)
  // Nothing changed, or nothing known: keep holding.
  assert.equal(releasesHoldOnHoleChange(7, 7), false)
  assert.equal(releasesHoldOnHoleChange(null, 2), false)
  assert.equal(releasesHoldOnHoleChange(1, null), false)
  console.log('concede release: GSPro moving to hole 2+ ends the hole-1 hold; stale or unchanged data does not.')
} finally {
  await server?.close()
}
