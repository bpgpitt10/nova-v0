// When a companion sighting is saved on the account (once a day per browser, or when something new is seen).
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { connectionNeedsSaving } = await server.ssrLoadModule('/src/lib/companionConnections.ts')
  const sent = { user: 'u1', day: '2026-11-23', release: '1.2.0', gspro: false }
  assert.equal(connectionNeedsSaving(null, 'u1', '2026-11-23', '1.2.0', false), true, 'first sighting')
  assert.equal(connectionNeedsSaving(sent, 'u1', '2026-11-23', '1.2.0', false), false, 'same day, nothing new')
  assert.equal(connectionNeedsSaving(sent, 'u1', '2026-11-24', '1.2.0', false), true, 'a new day')
  assert.equal(connectionNeedsSaving(sent, 'u1', '2026-11-23', '1.2.1', false), true, 'a new release')
  assert.equal(connectionNeedsSaving(sent, 'u1', '2026-11-23', '1.2.0', true), true, 'GSPro seen for the first time')
  assert.equal(connectionNeedsSaving({ ...sent, gspro: true }, 'u1', '2026-11-23', '1.2.0', true), false)
  assert.equal(connectionNeedsSaving(sent, 'u2', '2026-11-23', '1.2.0', false), true, 'another account on this browser')
  console.log('companion connections ok')
} finally {
  await server.close()
}
