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
  // 5. Stimp (20 Nov): only the roll share of a release changes, as the putting model's friction.
  const { stimpReleaseFactor, releaseConditionFactor, puttRollFriction, greenReleaseShape, chipReleaseLevel11, APPROACH_SHAPE } =
    await load('/src/liveCaddie/greenReleaseModel.ts')
  const landing = { speedMph: 50, descentDeg: 44, spinRpm: 6000 }
  const bermuda = { courseType: 'medium', greenFirmness: 'medium' }
  const at11 = greenReleaseFromLanding(landing, bermuda)
  assert.equal(greenReleaseFromLanding(landing, { ...bermuda, stimp: 11 }), at11)
  assert.equal(greenReleaseFromLanding(landing, { ...bermuda, stimp: null }), at11)
  assert.ok(Math.abs(greenReleaseFromLanding(landing, { ...bermuda, stimp: 13 }) - at11 * stimpReleaseFactor(13)) < 1e-9)
  assert.ok(stimpReleaseFactor(13) > 1 && stimpReleaseFactor(13) < 13 / 11 + 0.15 && stimpReleaseFactor(8) < 1)
  assert.equal(stimpReleaseFactor(40), 1, 'a stimp no green plays at is ignored')
  assert.ok(Math.abs(puttRollFriction(11) - 0.032) < 0.0002)
  assert.equal(releaseConditionFactor(0, 13), 1, 'all skid: stimp does nothing')
  // Uphill takes more off a fast green's release than a slow one's (less friction to compare the slope with).
  assert.ok(greenReleaseOnSlope(10, 0.02, 13) / 10 < greenReleaseOnSlope(10, 0.02, 8) / 10)

  // 6. The 18 approach shots fired at stimp 8, 11 and 13 (20 Nov, Briarwood West, Bermuda medium): from the
  // stimp-11 shot, the model's stimp change lands each one within half a yard, 0.1 yd on average.
  const stimpShots = [  // name, then [release, grade where it rolled] at stimp 8, 11 and 13
    ['PW', [1.22, 0.0501], [1.29, 0.0495], [1.33, 0.0501]],
    ['PW less spin', [2.84, 0.0391], [3.13, 0.039], [3.41, 0.0391]],
    ['PW more spin', [-0.16, 0], [-0.94, 0.0059], [-1.91, 0.0175]],
    ['9i', [2.22, 0.0413], [2.39, 0.0407], [2.53, 0.0395]],
    ['9i less spin', [5.27, 0.0374], [6.33, 0.036], [7.09, 0.0341]],
    ['9i more spin', [0.82, 0.0711], [0.82, 0.0711], [0.82, 0.0711]],
  ]
  const stimpMiss = []
  for (const [, at8, [r11, g11], at13] of stimpShots) {
    const level11 = r11 / (greenReleaseOnSlope(Math.sign(r11), g11, 11) * Math.sign(r11))
    for (const [stimp, [measured, grade]] of [[8, at8], [13, at13]]) {
      stimpMiss.push(Math.abs(greenReleaseOnSlope(level11 * stimpReleaseFactor(stimp), grade, stimp) - measured))
    }
  }
  assert.ok(mean(stimpMiss) < 0.15 && Math.max(...stimpMiss) < 0.6, `stimp shots: mean ${mean(stimpMiss)}, worst ${Math.max(...stimpMiss)}`)

  // 7. Chips (20 Nov): landed and stayed on the green, every grass, firmness and stimp 8 to 13, 5 to 40 yd.
  const chips = JSON.parse(readFileSync(new URL('./fixtures/chip-release-2026-11-20.json', import.meta.url), 'utf8'))
  const chipMiss = { clean: [], rough: [], fairway: [] }
  const chipRelease = ([type, firmness, stimp, speedMph, descentDeg, spinRpm, grade]) => {
    const conditions = { courseType: NAME[type], greenFirmness: NAME[firmness], stimp }
    const chipLanding = { speedMph, descentDeg, spinRpm }
    return greenReleaseOnSlope(greenReleaseFromLanding(chipLanding, conditions), grade, stimp, greenReleaseShape(chipLanding, conditions))
  }
  for (const chip of chips.green) chipMiss[chip[8] ? 'rough' : 'clean'].push(Math.abs(chipRelease(chip) - chip[7]))
  // A chip that lands in the fairway releases about what it would on a green of the fairway's grass and firmness.
  for (const chip of chips.fairway) chipMiss.fairway.push(Math.abs(chipRelease(chip) - chip[7]))
  assert.equal(chips.green.length, 82)
  assert.ok(mean(chipMiss.clean) < 0.5, `chips: mean ${mean(chipMiss.clean)}`)
  assert.ok(mean(chipMiss.rough) < 0.7, `chips from the rough (not in the fit): mean ${mean(chipMiss.rough)}`)
  assert.ok(mean(chipMiss.fairway) < 1.3, `chips landing in the fairway (not in the fit): mean ${mean(chipMiss.fairway)}`)
  // The approach fit alone gave a 7 yd chip a third of its release; the chip fit is used below 39.3 mph.
  const sevenYardChip = { speedMph: 21.9, descentDeg: 17.9, spinRpm: 1617 }
  const sevenLevel = greenReleaseFromLanding(sevenYardChip, { ...bermuda, stimp: 11 })
  const sevenOnTheSlope = greenReleaseOnSlope(sevenLevel, 0.028, 11, greenReleaseShape(sevenYardChip, bermuda))
  assert.ok(Math.abs(sevenOnTheSlope - 10.03) < 1, `7 yd chip: ${sevenOnTheSlope}`)  // measured 10.03 yd up a 2.8% slope
  assert.equal(greenReleaseShape(landing, bermuda).chipWeight, 0)
  assert.deepEqual(greenReleaseShape(landing, bermuda), APPROACH_SHAPE)
  assert.ok(chipReleaseLevel11(sevenYardChip, bermuda).rollShare > 0.85)
  // More spin never makes a chip release further.
  assert.ok(chipReleaseLevel11({ speedMph: 35, descentDeg: 30, spinRpm: 5500 }, bermuda).releaseYds
    < chipReleaseLevel11({ speedMph: 35, descentDeg: 30, spinRpm: 3000 }, bermuda).releaseYds)

  console.log(`chips ok (${chips.green.length} on the green: ${mean(chipMiss.clean).toFixed(2)} yd; rough ${mean(chipMiss.rough).toFixed(2)}; `
    + `${chips.fairway.length} landing in the fairway ${mean(chipMiss.fairway).toFixed(2)}; approach stimp shots ${mean(stimpMiss).toFixed(2)})`)
  console.log(`green release ok (131 landings: ${mean(fromLanding).toFixed(2)} yd from landing numbers, ${mean(fromLaunch).toFixed(2)} yd from launch)`)
} finally {
  await server?.close()
}
