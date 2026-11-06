// Auto Aim with an estimated pin: the pin's uncertainty moves the click in proportion to
// target distance over pin distance, so a par-4 tee shot may still be aimed while a par 3
// to an unconfirmed pin asks for a hand aim.
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
  const { estimatedPinUncertainty, aimClickErrorYds, aimErrorToleranceYds, estimatedPinAim } =
    await load('/src/liveCaddie/pinUncertainty.ts')

  // A green 30 yd wide, 25 yd deep, centred 400 yd straight up the hole.
  const greenRing = []
  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * 2 * Math.PI
    greenRing.push([15 * Math.cos(a), 400 + 12.5 * Math.sin(a)])
  }
  const hole = { surfaces: [{ kind: 'green', polygons: [greenRing] }] }
  const ball = [0, 0]
  const pin = [0, 400]

  // Uncertainty from the green: half its width across, a couple of yards along.
  const fromGreen = estimatedPinUncertainty({ hole, ball, pin })
  assert.equal(fromGreen.source, 'green')
  assert.ok(Math.abs(fromGreen.acrossYds - 15) < 0.5, `green half-width ${fromGreen.acrossYds}`)
  assert.equal(fromGreen.alongYds, 2)

  // Without GSPro's distance the pin could be anywhere on the green along the line too.
  const noDistance = estimatedPinUncertainty({ hole, ball, pin, distanceKnown: false })
  assert.ok(noDistance.alongYds >= 12, `whole green depth when distance unknown: ${noDistance.alongYds}`)

  // GKD pin slots narrow it: three slots within 6 yd of each other across the line.
  const fromSlots = estimatedPinUncertainty({ hole, ball, pin, pinSlotsLocal: [[-6, 398], [0, 400], [4, 404]] })
  assert.equal(fromSlots.source, 'pin-slots')
  assert.ok(Math.abs(fromSlots.acrossYds - 6) < 1e-9, `slot spread ${fromSlots.acrossYds}`)

  // Par-4 tee: a 250 yd click against a 400 yd pin with 15 yd of pin uncertainty
  // (no GKD slots, green 30 yd wide) turns the frame 2° and moves the click 9.5 yd.
  const teeError = aimClickErrorYds({ ball, pin, target: [0, 250], uncertainty: fromGreen })
  assert.ok(Math.abs(teeError - (250 / 400) * Math.hypot(15, 2)) < 1e-9)
  assert.ok(teeError < 10 && teeError > 9, `par-4 tee error about 9.5 yd: ${teeError}`)

  // Tolerance is one aim step, whatever the club: 9.5 yd is three steps, so aim by hand.
  assert.equal(aimErrorToleranceYds(22), 3)
  const tee = estimatedPinAim({ hole, ball, pin, target: [0, 250] })
  assert.equal(tee.allowed, false, 'a pin anywhere on a 30 yd green is too loose even off the tee')
  // GKD slots within 4 yd of the estimate: 2.6 yd at the click, inside one step.
  const teeSlots = estimatedPinAim({ hole, ball, pin, target: [0, 250], pinSlotsLocal: [[-4, 398], [0, 400], [3, 404]] })
  assert.ok(teeSlots.errorYds < 3, `slot-bounded error ${teeSlots.errorYds}`)
  assert.equal(teeSlots.allowed, true, 'pin slots bound the error under one aim step')
  // Same slots on a par 3: every yard of pin error is a yard of click error, so 4.5 yd fails.
  const par3Slots = estimatedPinAim({ hole, ball: [0, 220], pin, target: pin, pinSlotsLocal: [[-4, 398], [0, 400], [3, 404]] })
  assert.equal(par3Slots.allowed, false, 'the same slots at the pin itself are more than a step')

  // Par 3 with only the green: the full 15 yd.
  const par3 = estimatedPinAim({ hole, ball: [0, 220], pin, target: pin })
  assert.ok(Math.abs(par3.errorYds - Math.hypot(15, 2)) < 1e-9)
  assert.equal(par3.allowed, false, 'a 7-iron at an unconfirmed pin is aimed by hand')
  // Kiawah 3 shape, 11/4: pin estimated 10 yd off on a 188 yd shot moved the click 10 yd.
  const kiawah = aimClickErrorYds({ ball: [0, 212], pin, target: pin, uncertainty: { acrossYds: 10, alongYds: 2, source: 'default' } })
  assert.ok(kiawah > 10 && kiawah < 10.5, `par-3 click error equals the pin error: ${kiawah}`)

  // Lay-up on a par 5 from 520 with nothing but the default 15 yd spread: 6.7 yd, aim by hand.
  const par5 = estimatedPinAim({ hole: { surfaces: [] }, ball: [0, -120], pin, target: [0, 110] })
  assert.equal(par5.uncertainty.source, 'default')
  assert.equal(par5.toleranceYds, 3)
  assert.ok(par5.errorYds > 6 && par5.allowed === false, 'a 15 yd default pin spread is too much at 230 yd')
  // Two GKD slots 3 yd apart across the line on that par 5: 1.5 yd at the click, aimed.
  const par5Slots = estimatedPinAim({ hole: { surfaces: [] }, ball: [0, -120], pin, target: [0, 110], pinSlotsLocal: [[-3, 400], [0, 400]] })
  assert.equal(par5Slots.allowed, true)

  // Degenerate: ball on the pin, no ruler at all.
  assert.equal(aimClickErrorYds({ ball: pin, pin, target: [0, 410], uncertainty: fromGreen }), Number.POSITIVE_INFINITY)

  console.log('aim with estimated pin: ok')
} finally {
  if (server) await server.close()
}
