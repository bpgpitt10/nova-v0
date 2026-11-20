// Slope of the lie: launch angle and start line, against GSPro's measured flights.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
try {
  const { buildSidehillLieResponse, buildUpDownLieResponse, upDownLieShare, sidehillLieShare } = await load('/src/liveCaddie/lieResponse.ts')
  const { shots } = JSON.parse(readFileSync(new URL('./fixtures/lie-slope-2026-11-18.json', import.meta.url), 'utf8'))
  assert.equal(shots.length, 122)

  // 1. Every measured sloped shot. (HUD "right" is a negative lieLeftRightDeg in Looper: + is GSPro Left.)
  let launchMiss = 0, lineMiss = 0, worstLaunch = 0, worstLine = 0
  for (const [vlaDeg, ballSpeedMph, upDeg, rightDeg, flownVla, startLine] of shots) {
    const upDown = buildUpDownLieResponse({ launch: { ballSpeedMph, vlaDeg, hlaDeg: 0, totalSpinRpm: 6000, spinAxisDeg: 0 }, lieUpDownDeg: upDeg, stockCarryYds: 150 })
    const side = buildSidehillLieResponse({ club: '7i', lieLeftRightDeg: -rightDeg, carryYds: 150, launchVlaDeg: vlaDeg })
    if (Math.abs(upDeg) <= 20) {
      const miss = Math.abs(upDown.appliedVlaDeltaDeg - (flownVla - vlaDeg)); launchMiss += miss; worstLaunch = Math.max(worstLaunch, miss)
    }
    const miss = Math.abs(side.appliedBiasDeg - startLine); lineMiss += miss; worstLine = Math.max(worstLine, miss)
  }
  const steepDown = shots.filter((shot) => Math.abs(shot[2]) > 20).length
  assert.ok(launchMiss / (shots.length - steepDown) < 0.35 && worstLaunch < 2.2, `launch: mean ${launchMiss / (shots.length - steepDown)}, worst ${worstLaunch}`)
  assert.ok(lineMiss / shots.length < 0.1 && worstLine < 0.8, `start line: mean ${lineMiss / shots.length}, worst ${worstLine}`)

  // 2. The share falls as the launch rises, for both.
  assert.ok(upDownLieShare(9) > upDownLieShare(16) && upDownLieShare(16) > upDownLieShare(28))
  assert.ok(sidehillLieShare(9) > 0.9 && sidehillLieShare(28) < 0.52)

  // 3. Direction and size: a 3-hybrid off a 9 degree downslope launches about 6 degrees lower and loses carry;
  //    a driver on an 8 degree GSPro "Right" lie finishes well right.
  const hybrid = { ballSpeedMph: 134.2, vlaDeg: 8.7, hlaDeg: 0, totalSpinRpm: 4701, spinAxisDeg: 0 }
  const down = buildUpDownLieResponse({ launch: hybrid, lieUpDownDeg: -9.1, stockCarryYds: 196 })
  assert.equal(down.status, 'ready')
  assert.ok(down.appliedVlaDeltaDeg < -5.5 && down.appliedVlaDeltaDeg > -7.5 && down.carryDeltaYds < -5, JSON.stringify(down))
  assert.ok(Math.abs(down.carryDeltaYds) <= 196 * 0.25 + 1e-9)
  const up = buildUpDownLieResponse({ launch: hybrid, lieUpDownDeg: 9, stockCarryYds: 196 })
  assert.ok(up.appliedVlaDeltaDeg > 5.5)
  const right = buildSidehillLieResponse({ club: 'Driver', lieLeftRightDeg: -8.2, carryYds: 212, launchVlaDeg: 11.1 })
  assert.ok(right.appliedBiasDeg > 6.5 && right.lateralDeltaYds > 24 && right.lateralDeltaYds < 34, JSON.stringify(right))
  const left = buildSidehillLieResponse({ club: 'PW', lieLeftRightDeg: 4, carryYds: 120 })   // no launch given: from loft
  assert.ok(left.status === 'ready' && left.lateralDeltaYds < -3 && left.lateralDeltaYds > -7)
  assert.equal(buildSidehillLieResponse({ club: 'PW', lieLeftRightDeg: null, carryYds: 120 }).status, 'unavailable')
  assert.equal(buildUpDownLieResponse({ launch: null, lieUpDownDeg: 4, stockCarryYds: 150 }).carryDeltaYds, 0)
  console.log(`lie slope ok (122 shots: launch ${(launchMiss / (shots.length - steepDown)).toFixed(2)} deg, start line ${(lineMiss / shots.length).toFixed(2)} deg)`)
} finally {
  await server?.close()
}
