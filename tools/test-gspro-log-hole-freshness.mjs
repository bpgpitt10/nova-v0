// A hole marker in GSPro's log only counts when it was written after the
// latest shot. Regression for 15 Nov: the log still said hole 18 from an
// earlier round, so Live Caddie waited on a tee while holes 1-5 were played.
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
  const { advanceLogHoleBoundary, logHoleMarkerIsFresh } = await load('/src/adapters/gsproLogHoleFreshness.ts')

  // The player's case: Looper opens with a 500 kB log whose last marker
  // (hole 18) sits at byte 420,000, left by the previous round.
  let boundary = advanceLogHoleBoundary(null, null, 500_000)
  assert.equal(logHoleMarkerIsFresh(boundary, 340_000, 80_000), false, 'a marker already in the log at connect is stale')

  // He hits the first tee shot of the new round; the log has grown a little
  // but has no new marker. The old one must still be ignored.
  boundary = advanceLogHoleBoundary(boundary, 'shot-1', 512_000)
  assert.equal(boundary.staleBeforeOffset, 512_000)
  assert.equal(logHoleMarkerIsFresh(boundary, 352_000, 68_000), false, 'still the old hole-18 marker')

  // More shots, same stale marker, for the whole round.
  for (const [shot, size] of [['shot-2', 530_000], ['shot-3', 541_000], ['shot-9', 600_000]]) {
    boundary = advanceLogHoleBoundary(boundary, shot, size)
    assert.equal(logHoleMarkerIsFresh(boundary, size - 160_000, 420_000 - (size - 160_000)), false, shot)
  }

  // A marker GSPro writes AFTER the latest shot is the real "next tee" signal.
  boundary = advanceLogHoleBoundary(boundary, 'shot-9', 606_000) // same shot, log grew
  assert.equal(boundary.staleBeforeOffset, 600_000, 'the boundary only moves when a new shot appears')
  assert.equal(logHoleMarkerIsFresh(boundary, 446_000, 158_500), true, 'written at byte 604,500, after shot 9')

  // The next shot makes that marker old news too.
  boundary = advanceLogHoleBoundary(boundary, 'shot-10', 620_000)
  assert.equal(logHoleMarkerIsFresh(boundary, 460_000, 144_500), false)

  // GSPro restarted: a new, smaller log. Nothing in it predates this session.
  boundary = advanceLogHoleBoundary(boundary, 'shot-10', 4_000)
  assert.equal(boundary.staleBeforeOffset, 0)
  assert.equal(logHoleMarkerIsFresh(boundary, 0, 1_200), true)

  // No marker at all (the usual case on GSPro stable) is never fresh.
  assert.equal(logHoleMarkerIsFresh(boundary, 0, null), false)
  assert.equal(logHoleMarkerIsFresh(boundary, 0, -1), false)

  console.log('PASS gspro log hole freshness')
} finally {
  await server?.close()
}
