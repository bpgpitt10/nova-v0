// Before Shot 1 GSPro's player-box distance beats a stale pin (RNK 3, 11/3).
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
  const { reconcilePinWithHud } = await load('/src/liveCaddie/pinReconcile.ts')
  const ball = [0, 0]
  // Agrees within 5 yd: keep Looper's pin.
  let r = reconcilePinWithHud({ snapshotPin: [2, 147], ball, hudYds: 145, hudPin: null })
  assert.deepEqual(r.pin, [2, 147]); assert.equal(r.overridden, false)
  // RNK 3: Looper's pin 15 yd deeper, a course-file pin at 145 exists -> use it.
  r = reconcilePinWithHud({ snapshotPin: [0, 160], ball, hudYds: 145, hudPin: [-3, 144.5] })
  assert.deepEqual(r.pin, [-3, 144.5]); assert.equal(r.overridden, true)
  assert.match(r.note, /15 yd deeper than GSPro's 145/)
  // Disagrees and no course-file pin matches: drop it, estimate from GSPro.
  r = reconcilePinWithHud({ snapshotPin: [0, 160], ball, hudYds: 145, hudPin: null })
  assert.equal(r.pin, null); assert.equal(r.overridden, true)
  // A HUD pin that itself doesn't match the distance is not trusted.
  r = reconcilePinWithHud({ snapshotPin: [0, 160], ball, hudYds: 145, hudPin: [0, 170] })
  assert.equal(r.pin, null)
  // Wildly off with no matching pin: a misread box (45 for 145), keep Looper's pin.
  r = reconcilePinWithHud({ snapshotPin: [0, 145], ball, hudYds: 45, hudPin: null })
  assert.deepEqual(r.pin, [0, 145]); assert.equal(r.overridden, false)
  // No HUD reading (after Shot 1, or companion missing): unchanged.
  r = reconcilePinWithHud({ snapshotPin: [0, 160], ball, hudYds: null, hudPin: null })
  assert.deepEqual(r.pin, [0, 160])
  // No Looper pin yet, HUD pin found: use it, not an override.
  r = reconcilePinWithHud({ snapshotPin: null, ball, hudYds: 145, hudPin: [1, 145] })
  assert.deepEqual(r.pin, [1, 145]); assert.equal(r.overridden, false)
  // Dogleg (RNK 4): GSPro's 371 follows tee -> aim point -> pin; the straight line is ~342.
  // The correct pin must be kept, not "29 yd off".
  {
    const aim = [0, 250]
    const pin = [-110, 357]
    const route = Math.hypot(...aim) + Math.hypot(pin[0] - aim[0], pin[1] - aim[1])
    r = reconcilePinWithHud({ snapshotPin: pin, ball, hudYds: route, hudPin: pin, aimPoints: [aim] })
    assert.deepEqual(r.pin, pin); assert.equal(r.overridden, false, 'route distance matches')
    // Same reading before the course-file lookup (with the aim route) has finished: keep Looper's pin.
    r = reconcilePinWithHud({ snapshotPin: pin, ball, hudYds: route, hudPin: null, aimPoints: [], hudLookupDone: false })
    assert.deepEqual(r.pin, pin); assert.equal(r.overridden, false)
    // A genuinely wrong pin on the dogleg is still replaced by the one at GSPro's route distance.
    const deep = [-110, 380]
    r = reconcilePinWithHud({ snapshotPin: deep, ball, hudYds: route, hudPin: pin, aimPoints: [aim] })
    assert.deepEqual(r.pin, pin); assert.equal(r.overridden, true)
  }
  console.log('PASS: GSPro distance overrides a stale pin before Shot 1; doglegs use the aim route.')
} finally {
  await server?.close()
}
