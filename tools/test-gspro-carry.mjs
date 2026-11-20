// GSPro's carry for a launch, from GSPro's measured carries.
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
  const { predictGsproCarry, gsproCarryRatio, fitGsproCarry, carryFromFit } = await load('/src/liveCaddie/gsproCarryModel.ts')
  const { GSPRO_CARRY_SHOTS } = await load('/src/liveCaddie/gsproCarryData.ts')
  assert.equal(GSPRO_CARRY_SHOTS.length, 67)

  // 1. It reproduces what was measured.
  for (const [ballSpeedMph, vlaDeg, totalSpinRpm, carry] of GSPRO_CARRY_SHOTS) {
    assert.ok(Math.abs(predictGsproCarry({ ballSpeedMph, vlaDeg, totalSpinRpm }) - carry) < 0.6, `${ballSpeedMph}/${vlaDeg}/${totalSpinRpm}`)
  }

  // 2. Held out of the fit, the bag's stock shots are still predicted to a few yards.
  const stock = [[143.8, 11.1, 2812], [134.2, 8.7, 4701], [123.5, 12, 5280], [113.1, 16.4, 6175], [102.9, 19.3, 7804], [94.4, 22.4, 8646], [78.6, 26.6, 9856]]
  let worst = 0
  for (const [speed, vla, spin] of stock) {
    const index = GSPRO_CARRY_SHOTS.findIndex((shot) => shot[0] === speed && shot[1] === vla && shot[2] === spin)
    assert.ok(index >= 0, `stock shot ${speed}/${vla}/${spin} is in the data`)
    const fit = fitGsproCarry(GSPRO_CARRY_SHOTS.filter((_, i) => i !== index))
    worst = Math.max(worst, Math.abs(carryFromFit(fit, { ballSpeedMph: speed, vlaDeg: vla, totalSpinRpm: spin }) - GSPRO_CARRY_SHOTS[index][3]))
  }
  assert.ok(worst < 4, `held-out stock shots within 4 yd: ${worst}`)

  // 3. A lie's penalty as a share of carry. A 3-hybrid from deep rough (64% speed, 55% spin, 98% launch) went
  //    92 to 113 yd in GSPro against 197 clean; a 7-iron from rough (94%, 80%) lost about 5%.
  const hybrid = { ballSpeedMph: 134.2, vlaDeg: 8.7, totalSpinRpm: 4701 }
  const deep = gsproCarryRatio(hybrid, { ballSpeedMph: 134.2 * 0.6437, vlaDeg: 8.7 * 0.98, totalSpinRpm: 4701 * 0.55 })
  assert.ok(deep > 0.36 && deep < 0.6, `hybrid from deep rough: ${deep}`)
  const seven = { ballSpeedMph: 113.1, vlaDeg: 16.4, totalSpinRpm: 6175 }
  const rough = gsproCarryRatio(seven, { ballSpeedMph: 113.1 * 0.94, vlaDeg: 16.4, totalSpinRpm: 6175 * 0.8 })
  assert.ok(rough > 0.92 && rough < 0.98, `7-iron from rough: ${rough}`)
  // More speed carries further; outside what was measured there is no answer.
  assert.ok(predictGsproCarry({ ...seven, ballSpeedMph: 118 }) > predictGsproCarry(seven))
  assert.equal(predictGsproCarry({ ballSpeedMph: 20, vlaDeg: 16, totalSpinRpm: 6000 }), null)
  assert.equal(predictGsproCarry({ ballSpeedMph: 113, vlaDeg: 2, totalSpinRpm: 6000 }), null)
  assert.equal(gsproCarryRatio(seven, null), null)
  console.log(`gspro carry ok (67 launches; held-out stock shots within ${worst.toFixed(1)} yd; hybrid from deep rough ${(deep * 100).toFixed(0)}%, 7i from rough ${(rough * 100).toFixed(0)}%)`)
} finally {
  await server?.close()
}
