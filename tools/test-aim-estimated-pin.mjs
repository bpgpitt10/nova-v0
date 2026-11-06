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

  // Par-4 tee: a 250 yd click against a 400 yd pin with 15 yd of pin uncertainty.
  const teeError = aimClickErrorYds({ ball, pin, target: [0, 250], uncertainty: fromGreen })
  assert.ok(Math.abs(teeError - (250 / 400) * Math.hypot(15, 2)) < 1e-9)
  assert.ok(teeError < 10 && teeError > 9, `par-4 tee error about 9.5 yd: ${teeError}`)

  // Driver dispersion 22 yd: tolerance 11 yd, so the tee shot is aimed...
  assert.equal(aimErrorToleranceYds(22), 11)
  const tee = estimatedPinAim({ hole, ball, pin, target: [0, 250], lateralSigmaYds: 22 })
  assert.equal(tee.allowed, true, 'driver off the tee aims with an estimated pin')
  // ...and with GKD slots even a tighter driver would be.
  const teeSlots = estimatedPinAim({ hole, ball, pin, target: [0, 250], pinSlotsLocal: [[-6, 398], [0, 400], [4, 404]], lateralSigmaYds: 8 })
  assert.equal(teeSlots.allowed, true, 'pin slots bound the error well under one aim step')

  // Par 3: the target is the pin, so every yard of pin error is a yard of click error.
  const par3 = estimatedPinAim({ hole, ball: [0, 220], pin, target: pin, lateralSigmaYds: 9 })
  assert.ok(Math.abs(par3.errorYds - Math.hypot(15, 2)) < 1e-9)
  assert.equal(par3.allowed, false, 'a 7-iron at an unconfirmed pin is aimed by hand')
  // Kiawah 3 shape, 11/4: pin estimated 10 yd off on a 188 yd shot moved the click 10 yd.
  const kiawah = aimClickErrorYds({ ball: [0, 212], pin, target: pin, uncertainty: { acrossYds: 10, alongYds: 2, source: 'default' } })
  assert.ok(kiawah > 10 && kiawah < 10.5, `par-3 click error equals the pin error: ${kiawah}`)

  // Lay-up on a par 5 from 520: a 230 yd click against a 520 yd pin, wedge-tight tolerance floor still passes.
  const par5 = estimatedPinAim({ hole: { surfaces: [] }, ball: [0, -120], pin, target: [0, 110], lateralSigmaYds: null })
  assert.equal(par5.uncertainty.source, 'default')
  assert.equal(par5.toleranceYds, 4, 'no dispersion known: the 4 yd floor')
  assert.ok(par5.errorYds > 6 && par5.allowed === false, 'without a club model a 15 yd default pin spread is too much at 230 yd')
  const par5Driver = estimatedPinAim({ hole: { surfaces: [] }, ball: [0, -120], pin, target: [0, 110], lateralSigmaYds: 20 })
  assert.equal(par5Driver.allowed, true, 'a driver (σ 20) forgives a 6.7 yd aim error')

  // Degenerate: ball on the pin, no ruler at all.
  assert.equal(aimClickErrorYds({ ball: pin, pin, target: [0, 410], uncertainty: fromGreen }), Number.POSITIVE_INFINITY)

  console.log('aim with estimated pin: ok')
} finally {
  if (server) await server.close()
}
