// Which rounds a stats page looks at: last 6 months (no cap), last 5, last 15, all.
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
  const { roundsInWindow, defaultRoundWindow, describeRoundWindow } = await load('/src/lib/roundWindow.ts')
  const now = new Date('2026-11-18T12:00:00Z')
  const round = (id, playedAt, extra = {}) => ({ roundId: id, playedAt, counts: true, completeHoles: 18, ...extra })
  // 20 rounds, one a week back from 15 Nov; then three from over six months ago.
  const weekly = [...Array(20)].map((_, i) => round(i + 1, new Date(Date.UTC(2026, 10, 15) - i * 7 * 86400000).toISOString()))
  const old = [round(101, '2026-05-17T12:00:00Z'), round(102, '2026-03-01T12:00:00Z'), round(103, '2025-11-01T12:00:00Z')]
  const all = [...old, ...weekly]

  assert.equal(roundsInWindow(all, 'recent', now).length, 20, 'six months has no cap on rounds')
  assert.equal(roundsInWindow(all, 'all', now).length, 23)
  assert.deepEqual(roundsInWindow(all, 'five', now).map((r) => r.roundId), [1, 2, 3, 4, 5], 'newest first')
  assert.equal(roundsInWindow(all, 'fifteen', now).length, 15)
  // The cutoff is six calendar months back: 18 May counts, 17 May does not.
  assert.equal(roundsInWindow([round(1, '2026-05-18T13:00:00Z'), round(2, '2026-05-17T12:00:00Z')], 'recent', now).length, 1)
  // Rounds that don't count, or have no finished hole or no date, never appear in "recent".
  assert.equal(roundsInWindow([round(1, '2026-11-01T00:00:00Z', { counts: false }), round(2, '2026-11-01T00:00:00Z', { completeHoles: 0 }), round(3, null)], 'recent', now).length, 0)
  assert.equal(roundsInWindow([round(3, null)], 'all', now).length, 1)
  // A page can narrow what it uses: last 5 of the rounds it can say something about.
  assert.deepEqual(roundsInWindow(all, 'five', now, (r) => r.roundId % 2 === 0).map((r) => r.roundId), [2, 4, 6, 8, 10])
  // Opens on the last six months; with nothing that recent, on everything.
  assert.equal(defaultRoundWindow(all, now), 'recent')
  assert.equal(defaultRoundWindow(old.slice(1), now), 'all')
  assert.equal(defaultRoundWindow([], now), 'all')
  assert.equal(describeRoundWindow('recent', 3), '3 rounds in the last 6 months')
  assert.equal(describeRoundWindow('five', 5), 'your last 5 rounds')
  assert.equal(describeRoundWindow('all', 22), 'all 22 rounds')
  assert.equal(describeRoundWindow('fifteen', 1), 'your last round')
  console.log('round window ok')
} finally {
  await server?.close()
}
