// Start a Round: GSPro course conditions, and which GSPro round they are saved on.
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
  const { normalizeRoundConditions, hasRoundConditions, NO_ROUND_CONDITIONS } = await load('/src/liveCaddie/roundConditions.ts')
  const { roundSettingsFor } = await load('/src/lib/roundSettings.ts')

  // Picks come from <select> values: strings, with '' / null for "Not sure".
  assert.deepEqual(normalizeRoundConditions({ courseType: 'medium', greenFirmness: 'soft', fairwayFirmness: 'firm', stimp: '11' }),
    { courseType: 'medium', greenFirmness: 'soft', fairwayFirmness: 'firm', stimp: 11 })
  assert.deepEqual(normalizeRoundConditions({ courseType: 'bermuda', stimp: null }), NO_ROUND_CONDITIONS)
  assert.deepEqual(normalizeRoundConditions({ stimp: 40 }), NO_ROUND_CONDITIONS)
  assert.deepEqual(normalizeRoundConditions(null), NO_ROUND_CONDITIONS)
  assert.equal(hasRoundConditions(NO_ROUND_CONDITIONS), false)
  assert.equal(hasRoundConditions({ ...NO_ROUND_CONDITIONS, stimp: 11 }), true)

  const active = {
    id: 'a', teeSet: 'Yellow', pinDay: 'Thursday', startedAt: '2026-11-18T23:00:00.000Z',
    conditions: { courseType: 'medium', greenFirmness: 'soft', fairwayFirmness: 'soft', stimp: 11 },
  }
  const now = Date.parse('2026-11-19T00:30:00.000Z')
  // A GSPro round first seen after Start Round gets the settings.
  assert.deepEqual(roundSettingsFor(active, '2026-11-18T23:05:00.000Z', now), {
    schema: 'looper-round-settings-v1', source: 'start-round', recordedAt: active.startedAt, teeSet: 'Yellow', pinDay: 'Thursday',
    courseType: 'medium', greenFirmness: 'soft', fairwayFirmness: 'soft', stimp: 11,
  })
  // A round already under way before Start Round (yesterday's file) does not.
  assert.equal(roundSettingsFor(active, '2026-11-18T20:00:00.000Z', now), null)
  // Nothing picked, no active round, or a Start Round from another day: nothing to save.
  assert.equal(roundSettingsFor({ ...active, conditions: NO_ROUND_CONDITIONS }, '2026-11-18T23:05:00.000Z', now), null)
  assert.equal(roundSettingsFor(null, '2026-11-18T23:05:00.000Z', now), null)
  assert.equal(roundSettingsFor(active, '2026-11-19T13:00:00.000Z', Date.parse('2026-11-19T13:01:00.000Z')), null)
  console.log('round settings ok')
} finally {
  await server?.close()
}
