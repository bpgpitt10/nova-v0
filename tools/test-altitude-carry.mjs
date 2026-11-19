// Altitude and carry: GSPro's measured effect (50 range shots at 2,500 and 5,000 ft).
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
  const { gsproAltitudeCarryFraction, buildAirAltitudeAdjustment } = await load('/src/liveCaddie/airAltitudeAdjustment.ts')
  const { shots } = JSON.parse(readFileSync(new URL('./fixtures/altitude-carry-2026-11-18.json', import.meta.url), 'utf8'))
  assert.equal(shots.length, 50)

  // 1. Against every measured shot: the carry change in yards.
  let sum = 0, worst = 0
  for (const [ballSpeedMph, vlaDeg, totalSpinRpm, altitudeFt, seaLevel, measured] of shots) {
    const predicted = seaLevel * gsproAltitudeCarryFraction({ ballSpeedMph, vlaDeg, totalSpinRpm }, altitudeFt)
    const miss = Math.abs(predicted - (measured - seaLevel))
    sum += miss; worst = Math.max(worst, miss)
  }
  assert.ok(sum / shots.length < 0.8 && worst < 3, `mean ${sum / shots.length}, worst ${worst}`)

  // 2. Golf shots: about 1% per 1,000 ft, linear in altitude, more for irons than for the driver.
  const driver = { ballSpeedMph: 143.8, vlaDeg: 11.1, totalSpinRpm: 2812 }
  const seven = { ballSpeedMph: 113.1, vlaDeg: 16.4, totalSpinRpm: 6175 }
  const per1000 = (launch) => gsproAltitudeCarryFraction(launch, 1000)
  assert.ok(per1000(driver) > 0.006 && per1000(driver) < 0.010, `driver ${per1000(driver)}`)
  assert.ok(per1000(seven) > 0.010 && per1000(seven) < 0.014, `7i ${per1000(seven)}`)
  assert.ok(Math.abs(gsproAltitudeCarryFraction(seven, 5000) - 5 * per1000(seven)) < 1e-12)
  assert.equal(gsproAltitudeCarryFraction(seven, 0), 0)
  // A launch outside what was measured is held to the measured range.
  assert.equal(gsproAltitudeCarryFraction({ ballSpeedMph: 300, vlaDeg: 60, totalSpinRpm: 20000 }, 1000),
    gsproAltitudeCarryFraction({ ballSpeedMph: 165, vlaDeg: 30, totalSpinRpm: 10200 }, 1000))

  // 3. Through the adjustment Live Caddie uses: a 7-iron at 1,391 ft (Payne's Valley) flies 2-3 yd further.
  const paynes = buildAirAltitudeAdjustment(seven, 1391)
  assert.equal(paynes.status, 'ready')
  assert.ok(paynes.carryDeltaYds > 2 && paynes.carryDeltaYds < 3.5, `7i at 1,391 ft: ${paynes.carryDeltaYds}`)
  assert.equal(buildAirAltitudeAdjustment(null, 1391).carryDeltaYds, 0)
  assert.equal(buildAirAltitudeAdjustment(seven, null).carryDeltaYds, 0)
  console.log(`altitude carry ok (50 measured shots: mean ${(sum / shots.length).toFixed(2)} yd, worst ${worst.toFixed(1)} yd)`)
} finally {
  await server?.close()
}
