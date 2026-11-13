// Screen-only caddie: the stand-in hole plus the real engine move the club and aim the right way
// for elevation, wind, lie and a tee shot, with no map at all.
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
  const { evaluateAimLab } = await load('/src/liveCaddie/aimOptimization.ts')
  const { buildQuickBagPrior } = await load('/src/lib/quickBag.ts')
  const { screenOnlyHole, screenOnlyAdvice, CLOSE_CALL_STROKES } = await load('/src/liveCaddie/screenOnlyHole.ts')
  const { classifyPoint } = await load('/src/courseGeometry/geometry.ts')

  const clubs = ['Driver', '3W', '4H', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW', 'SW', 'LW']
  const prior = buildQuickBagPrior({
    version: 1, handicap: 10, clubs, handed: 'right', savedAt: '2026-11-07T00:00:00Z',
    anchors: { Driver: { carryYds: 240, shape: 'fade' }, '7i': { carryYds: 160, shape: 'neutral' }, PW: { carryYds: 125, shape: 'neutral' } },
  })
  const order = (club) => clubs.indexOf(club) // lower index = longer club

  // --- the stand-in hole
  const hole = screenOnlyHole({ distanceToPinYds: 150 })
  assert.deepEqual(hole.markers.pin, [0, 150])
  assert.equal(classifyPoint(hole, [0, 150]).kind, 'green')
  assert.equal(classifyPoint(hole, [0, 100]).kind, 'fairway')
  assert.equal(classifyPoint(hole, [40, 100]).kind, 'rough')
  assert.equal(classifyPoint(hole, [0, 190]).kind, 'rough', 'long of the green is rough')
  assert.ok(!hole.surfaces.some((s) => ['water', 'bunker', 'penalty'].includes(s.kind)), 'no invented hazards')
  assert.equal(screenOnlyHole({ distanceToPinYds: 40 }).surfaces.some((s) => s.kind === 'fairway'), true)

  const run = (d, env, onTee = false) => {
    const h = screenOnlyHole({ distanceToPinYds: d, onTee })
    const evals = evaluateAimLab([], h, [0, 0], h.markers.pin,
      { quickBag: prior, exactPinLocalYds: h.markers.pin, shotOrigin: onTee ? 'tee' : 'non-tee', ...env },
      Date.parse('2026-11-07T12:00:00Z'))
    const ranked = evals.filter((e) => e.decisionRank != null).sort((a, b) => a.decisionRank - b.decisionRank)
    return screenOnlyAdvice({ distanceToPinYds: d, elevationFt: env.elevationDeltaFt ?? null,
      windMph: env.windMph ?? null, surface: env.surfaceOverride ?? null }, ranked[0], ranked[1])
  }

  const flat = run(150, { surfaceOverride: 'fairway' })
  assert.ok(['8i', '9i'].includes(flat.club), `150 flat: ${flat.club}`)
  assert.equal(flat.playsLikeYds, 150)
  assert.equal(flat.aimOffsetYds, 0)

  const up = run(150, { surfaceOverride: 'fairway', elevationDeltaFt: 20 })
  assert.ok(up.playsLikeYds > 150 && order(up.club) <= order(flat.club), `uphill: ${up.club} plays ${up.playsLikeYds}`)
  assert.ok(up.adjustments.some((a) => a.label === 'elevation' && a.yds > 0))

  const down = run(150, { surfaceOverride: 'fairway', elevationDeltaFt: -20 })
  assert.ok(down.playsLikeYds < 150 && order(down.club) >= order(up.club), `downhill: ${down.club} plays ${down.playsLikeYds}`)

  const into = run(150, { surfaceOverride: 'fairway', windMph: 12, windRelativeDeg: 0 })
  assert.ok(into.playsLikeYds >= 160 && order(into.club) < order(flat.club), `into: ${into.club} plays ${into.playsLikeYds}`)

  const fromRight = run(150, { surfaceOverride: 'fairway', windMph: 12, windRelativeDeg: 90 })
  assert.ok(fromRight.aimOffsetYds >= 5, `wind from the right: aim right, got ${fromRight.aimOffsetYds}`)
  assert.match(fromRight.aimText, /right of the pin/)

  const rough = run(150, { surfaceOverride: 'rough' })
  assert.ok(rough.playsLikeYds > 150 && rough.adjustments.some((a) => a.label === 'lie' && a.yds > 0), `rough: ${JSON.stringify(rough.adjustments)}`)

  const tee = run(410, { surfaceOverride: 'tee' }, true)
  assert.equal(tee.club, 'Driver')
  assert.ok(tee.aimOffsetYds < -5, `a fade driver aims left: ${tee.aimOffsetYds}`)
  assert.match(tee.aimText, /line to the pin/)

  // --- close calls and missing inputs
  const pick = { club: '9i', stockCarryYds: 138, modeledCarryYds: 138, bestCandidate: { aimOffsetYds: 0 }, decisionValue: { expectedFutureStrokes: 2.068 } }
  const near = { ...pick, club: '8i', decisionValue: { expectedFutureStrokes: 2.068 + CLOSE_CALL_STROKES - 0.001 } }
  const far = { ...pick, club: '8i', decisionValue: { expectedFutureStrokes: 2.2 } }
  assert.equal(screenOnlyAdvice({ distanceToPinYds: 150 }, pick, near).closeClub, '8i')
  assert.equal(screenOnlyAdvice({ distanceToPinYds: 150 }, pick, far).closeClub, null)
  assert.deepEqual([...screenOnlyAdvice({ distanceToPinYds: 150 }, pick).missing], ['elevation', 'wind', 'lie'])
  assert.equal(screenOnlyAdvice({ distanceToPinYds: null }, pick), null)

  console.log('screen-only caddie: ok')
} finally {
  if (server) await server.close()
}
