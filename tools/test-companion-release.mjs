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
  const { compareReleases, companionUpdateState, companionUpdateNotice, parseLatest, COMPANION_DOWNLOAD_URL, COMPANION_LATEST_URL } = await load('/src/lib/companionRelease.ts')
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

  // The red box: only for a release marked important, or one Looper can't work without.
  assert.equal(companionUpdateNotice('1.1.0', latest), null, 'a small update stays a quiet chip')
  assert.equal(companionUpdateNotice('1.0.0', latest).level, 'required')
  assert.equal(companionUpdateNotice('1.1.0', null), null)
  const marked = parseLatest({
    release: '1.3.1', minRelease: '1.0.0', url: 'x', importantRelease: '1.3.0',
    bugFix: '  Fixes Auto Aim when the\nminimap is on the left ', feature: 'Voice arming', notes: 'long text stays on GitHub',
  })
  assert.equal(marked.bugFix, 'Fixes Auto Aim when the minimap is on the left')
  const behind = companionUpdateNotice('1.2.0', marked)
  assert.deepEqual(
    [behind.level, behind.release, behind.bugFix, behind.feature],
    ['important', '1.3.1', 'Fixes Auto Aim when the minimap is on the left', 'Voice arming'],
  )
  assert.equal(companionUpdateNotice('1.3.0', marked), null, 'has the fix; 1.3.1 is a small update')
  assert.equal(companionUpdateNotice('1.3.1', marked), null)
  assert.equal(companionUpdateNotice('courses.10', marked).level, 'required')
  assert.equal(companionUpdateNotice('0.9.0', marked).level, 'required')
  assert.equal(companionUpdateNotice('0.9.0', marked).bugFix, 'Fixes Auto Aim when the minimap is on the left')
  // Today's file has none of the new fields: nothing changes.
  const plain = parseLatest({ release: '1.0.7', minRelease: '1.0.0', url: 'x', notes: 'n' })
  assert.equal(plain.importantRelease, null)
  assert.equal(companionUpdateNotice('1.0.5', plain), null)
  // A typo that marks a release that doesn't exist yet shows nothing.
  assert.equal(companionUpdateNotice('1.0.7', parseLatest({ release: '1.0.7', minRelease: '1.0.0', url: 'x', importantRelease: '9.0.0' })), null)
  assert.equal(parseLatest({ release: '1', url: 'x', bugFix: 'a'.repeat(400) }).bugFix.length, 160)
  console.log('PASS: companion release ordering and update states.')
} finally {
  await server?.close()
}
