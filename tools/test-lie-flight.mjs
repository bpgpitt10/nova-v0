// Wind, elevation and the roll after landing follow the ball the lie sends, not the clean one
// (Brian, 21 Nov: a 3 wood out of deep rough to Shinnecock 9's raised green showed 135 carry and no roll).
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ root: process.cwd(), logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { modelShotContext } = await server.ssrLoadModule('/src/liveCaddie/shotContextModel.ts')
  const { estimateGreenRelease } = await server.ssrLoadModule('/src/liveCaddie/greenReleaseModel.ts')
  const threeWood = { club: '3W', stockCarryYds: 225, carrySigmaYds: 8, lateralBiasYds: 0, lateralSigmaYds: 10, launchBallSpeedMph: 150, launchVlaDeg: 11, launchSpinRpm: 3600 }
  const at = (surface, elevationDeltaFt) => modelShotContext(threeWood, { surface, elevationDeltaFt, targetDistanceYds: 148, windMph: 0 })

  // Clean: no lie flight, elevation as before.
  const clean = at('fairway', 34)
  assert.equal(clean.lieFlight, null)
  assert.ok(clean.appliedAdjustments.elevationYds < -10 && clean.appliedAdjustments.elevationYds > -25)

  // Deep rough on level ground: GSPro's measured penalty only; elevation adds nothing.
  const deepLevel = at('deep-rough', 0)
  assert.ok(deepLevel.lieFlight && deepLevel.lieFlight.ballSpeedMph < 110 && deepLevel.lieFlight.totalSpinRpm < 2300)
  assert.ok(Math.abs(deepLevel.appliedAdjustments.elevationYds) < 0.01)

  // Deep rough up 34 ft: the low, slow ball loses far more climbing than the clean one did.
  const deepUp = at('deep-rough', 34)
  assert.ok(deepUp.appliedAdjustments.elevationYds < clean.appliedAdjustments.elevationYds * 1.5,
    `deep rough climb ${deepUp.appliedAdjustments.elevationYds} vs clean ${clean.appliedAdjustments.elevationYds}`)
  assert.ok(deepUp.modeledCarryYds < deepLevel.modeledCarryYds - 20)

  // It comes in flatter, with less spin: it runs on a green where the clean one stops sooner.
  const calm = deepLevel.physicsPrior.baseline.landingAngleDeg
  const conditions = { courseType: 'medium', greenFirmness: 'soft', stimp: 11 }
  const cleanRelease = estimateGreenRelease({ arrival: { ballSpeedMph: 150, spinRpm: 3600, descentDeg: 42 }, stockRolloutYds: 12, conditions })
  const lieRelease = estimateGreenRelease({
    arrival: { ballSpeedMph: deepLevel.lieFlight.ballSpeedMph, spinRpm: deepLevel.lieFlight.totalSpinRpm, descentDeg: 42 },
    descentDeltaDeg: deepLevel.lieFlight.landedDeg - calm, stockRolloutYds: 12, conditions,
  })
  assert.ok(lieRelease.predictedYds > cleanRelease.predictedYds * 1.5, `${lieRelease.predictedYds} vs ${cleanRelease.predictedYds}`)

  // Rough (a small penalty) moves the elevation change only a little.
  const roughUp = at('rough', 34)
  assert.ok(Math.abs(roughUp.appliedAdjustments.elevationYds - clean.appliedAdjustments.elevationYds) < 10)
  console.log('lie flight ok', deepUp.appliedAdjustments.elevationYds.toFixed(1), clean.appliedAdjustments.elevationYds.toFixed(1), lieRelease.predictedYds.toFixed(1))
} finally {
  await server.close()
}
