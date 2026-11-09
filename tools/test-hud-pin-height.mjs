// GSPro 4's pin height picks the pin slot that distance alone can't (Valhalla 2, 11/8).
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
  const { rankHudPinSlots } = await load('/src/liveCaddie/hudPin.ts')
  const yd = 0.9144
  const pinAt = (slot, distanceYds, acrossYds, heightM) => {
    // Straight down +z from the tee at the origin, `across` to the side, same distance from the tee.
    const r = distanceYds * yd
    const a = acrossYds * yd
    return { slot, label: null, x: a, y: heightM, z: Math.sqrt(r * r - a * a) }
  }
  const hole = {
    hole: 2, par: 4, aimPoints: [], greenCenter: null,
    tees: { Black: { name: 'Black', x: 0, y: 10, z: 0, distanceM: 0 } },
    // Three slots ~431 yd from the tee, 21 yd apart across the green, at different heights;
    // one more 25 yd deeper.
    pins: [pinAt(1, 431, -10, 9.2), pinAt(2, 431.5, 0, 8.8), pinAt(3, 430.5, 11, 9.9), pinAt(4, 456, 0, 8.8)],
  }
  const tee = { x: 0, z: 0 }
  // Distance alone: three slots fit within 6 m, none 3 m clear of the next.
  let { ranked } = rankHudPinSlots(hole, tee, 431)
  assert.equal(ranked.filter((r) => r.errorM <= 6).length, 3)
  // With GSPro's height (pin 4 ft below the ball: slot 2 is 1.2 m below the tee).
  ;({ ranked } = rankHudPinSlots(hole, tee, 431, -(1.2 * 3.28084)))
  assert.deepEqual(ranked.map((r) => r.pin.slot), [2])
  // A height no distance-fitting slot has: keep the distance ranking, never jump elsewhere.
  ;({ ranked } = rankHudPinSlots(hole, tee, 431, -40))
  assert.equal(ranked.length, 4)
  assert.equal(ranked[0].pin.slot === 4, false)
  // No height (older GSPro): unchanged.
  ;({ ranked } = rankHudPinSlots(hole, tee, 456))
  assert.equal(ranked[0].pin.slot, 4)
  console.log('hud pin height ok')
} finally {
  if (server) await server.close()
}
