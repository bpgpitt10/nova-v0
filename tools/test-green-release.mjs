// Green release by course type and green firmness, against GSPro's measured landings.
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
  const { greenReleaseFromLanding, predictGreenRelease, greenReleaseOnSlope, estimateGreenRelease, landingFromLaunch } =
    await load('/src/liveCaddie/greenReleaseModel.ts')
  const { shots } = JSON.parse(readFileSync(new URL('./fixtures/green-release-2026-11-18.json', import.meta.url), 'utf8'))
  const NAME = ['soft', 'medium', 'firm']
  assert.equal(shots.length, 131)

  // 1. Every measured landing, from GSPro's landing numbers and from the launch as Looper uses it.
  const fromLanding = [], fromLaunch = []
  for (const [type, firmness, ballSpeedMph, spinRpm, descentDeg, landingSpeed, landingSpin, grade, release] of shots) {
    const conditions = { courseType: NAME[type], greenFirmness: NAME[firmness] }
    fromLanding.push(Math.abs(greenReleaseOnSlope(greenReleaseFromLanding({ speedMph: landingSpeed, descentDeg, spinRpm: landingSpin }, conditions), grade) - release))
    fromLaunch.push(Math.abs(greenReleaseOnSlope(predictGreenRelease({ ballSpeedMph, spinRpm, descentDeg }, conditions), grade) - release))
  }
  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length
  const p90 = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length * 0.9)]
  assert.ok(mean(fromLanding) < 0.85 && p90(fromLanding) < 1.8, `landing: mean ${mean(fromLanding)}, p90 ${p90(fromLanding)}`)
  assert.ok(mean(fromLaunch) < 0.95 && p90(fromLaunch) < 1.9, `launch: mean ${mean(fromLaunch)}, p90 ${p90(fromLaunch)}`)

  // 2. The pattern the tests showed: Bentgrass < Bermuda < Links, soft < medium < firm, less spin runs further.
  const nine = { ballSpeedMph: 95.1, spinRpm: 7804, descentDeg: 40.2 }
  const five = { ballSpeedMph: 121, spinRpm: 5280, descentDeg: 39.6 }
  for (const shot of [nine, five]) {
    for (const greenFirmness of NAME) {
      const [bent, bermuda, links] = NAME.map((courseType) => predictGreenRelease(shot, { courseType, greenFirmness }))
      assert.ok(bent < bermuda && bermuda < links, `${greenFirmness}: ${bent} ${bermuda} ${links}`)
    }
    for (const courseType of NAME) {
      const [soft, medium, firm] = NAME.map((greenFirmness) => predictGreenRelease(shot, { courseType, greenFirmness }))
      assert.ok(soft < medium && medium < firm, `${courseType}: ${soft} ${medium} ${firm}`)
    }
    const bermudaMedium = { courseType: 'medium', greenFirmness: 'medium' }
    assert.ok(predictGreenRelease({ ...shot, spinRpm: shot.spinRpm * 0.7 }, bermudaMedium) > predictGreenRelease(shot, bermudaMedium) + 1)
  }
  // A high-spin wedge comes back on soft Bentgrass and runs on firm Links.
  const wedge = { ballSpeedMph: 98.1, spinRpm: 10808, descentDeg: 47.1 }
  assert.ok(predictGreenRelease(wedge, { courseType: 'soft', greenFirmness: 'soft' }) < 0)
  assert.ok(predictGreenRelease(wedge, { courseType: 'firm', greenFirmness: 'firm' }) > 0)

  // 3. Slope: uphill shortens a release, and a ball spinning back down an upslope comes back further.
  assert.ok(greenReleaseOnSlope(6, 0.02) < 6 && greenReleaseOnSlope(6, -0.02) > 6)
  assert.ok(greenReleaseOnSlope(-3, 0.02) < -3)
  assert.equal(greenReleaseOnSlope(6, null), 6)
  assert.ok(greenReleaseOnSlope(6, -1) <= 24 && greenReleaseOnSlope(6, 1) >= 1.5)

  // 4. Odd input is held to what was measured, and missing input gives no answer.
  const wild = predictGreenRelease({ ballSpeedMph: 400, spinRpm: 100, descentDeg: 5 }, { courseType: 'firm', greenFirmness: 'firm' })
  assert.ok(wild <= 35 && wild >= -10)
  assert.equal(predictGreenRelease({ ballSpeedMph: 100, spinRpm: 7000 }, { courseType: 'medium', greenFirmness: 'medium' }), null)
  assert.equal(predictGreenRelease(nine, null), null)
  assert.ok(Math.abs(landingFromLaunch({ ballSpeedMph: 96.3, spinRpm: 8646, descentDeg: 45.15 }).speedMph - 50.4) < 1.5)
  const estimate = estimateGreenRelease({ arrival: nine, descentDeltaDeg: 3, stockRolloutYds: 5, conditions: { courseType: 'medium', greenFirmness: 'firm' } })
  assert.ok(estimate && estimate.descentDeg === 43.2 && estimate.stockYds === 5)
  assert.ok(estimate.predictedYds < predictGreenRelease(nine, { courseType: 'medium', greenFirmness: 'firm' }))  // steeper: less release
  console.log(`green release ok (131 landings: ${mean(fromLanding).toFixed(2)} yd from landing numbers, ${mean(fromLaunch).toFixed(2)} yd from launch)`)
} finally {
  await server?.close()
}
