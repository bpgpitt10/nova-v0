// Companion distribution: release ordering and the update state the home page shows.
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
  const { compareReleases, companionUpdateState, COMPANION_DOWNLOAD_URL, COMPANION_LATEST_URL } = await load('/src/lib/companionRelease.ts')
  assert.ok(compareReleases('1.0.0', '1.0.0') === 0)
  assert.ok(compareReleases('1.2.0', '1.10.0') < 0, 'numeric parts, not strings')
  assert.ok(compareReleases('v1.1', '1.0.9') > 0)
  assert.ok(compareReleases('courses.10', '1.0.0') < 0, 'old-style versions predate every numbered release')
  assert.ok(compareReleases(null, '1.0.0') < 0)
  const latest = { release: '1.2.0', minRelease: '1.1.0', url: 'x' }
  assert.equal(companionUpdateState('1.2.0', latest), 'current')
  assert.equal(companionUpdateState('1.1.0', latest), 'update-available')
  assert.equal(companionUpdateState('1.0.0', latest), 'needs-update')
  assert.equal(companionUpdateState('courses.10', latest), 'needs-update')
  assert.equal(companionUpdateState('1.1.0', null), 'unknown')
  assert.match(COMPANION_DOWNLOAD_URL, /releases\/latest\/download\/LooperCompanionSetup\.exe$/)
  assert.match(COMPANION_LATEST_URL, /raw\.githubusercontent\.com\/.*\/latest\.json$/)
  console.log('PASS: companion release ordering and update states.')
} finally {
  await server?.close()
}
