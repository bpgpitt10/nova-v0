import assert from 'node:assert/strict'
import { createServer } from 'vite'

// Club guessing off penalized lies and on putts (overnight fix, 26 Nov 2026).
const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { inferClubForGsproShot, lieCutLaunchSpeed } = await vite.ssrLoadModule('/src/lib/liveClubAttribution.ts')
  const now = Date.parse('2026-11-20T13:00:00Z')
  // A player's stock numbers: club -> [carry, total, ball speed, launch, spin].
  const stock = {
    '5i': [182, 192, 126, 14, 5000],
    '6i': [172, 182, 120, 15.5, 5600],
    '7i': [163, 172, 115, 17, 6200],
    '8i': [153, 161, 110, 19, 6900],
    '9i': [141, 148, 104, 22, 7600],
    PW: [124, 129, 95, 25, 8400],
    GW: [110, 114, 89, 27, 9000],
    SW: [80, 83, 70, 31, 9500],
  }
  const shots = Object.entries(stock).flatMap(([club, [carry, total, bs, vla, spin]]) =>
    Array.from({ length: 12 }, (_, i) => ({
      id: `${club}-${i}`, club, included: true, enrichmentStatus: 'enriched', source: 'simread',
      capturedAt: new Date(now - (i + 1) * 1000).toISOString(),
      carryYards: carry + ((i % 3) - 1) * 3,
      totalYards: total + ((i % 3) - 1) * 3,
      offlineYards: (i % 5) - 2,
      ballSpeedMph: bs + ((i % 3) - 1),
      launchAngleDeg: vla,
      spinRpm: spin,
    })))
  const sessions = [{ id: 'lie-fixture', startedAt: new Date(now - 60000).toISOString(), endedAt: new Date(now).toISOString(), shots }]

  const gsproShot = (over) => ({
    key: 'k', player: { key: 'p', name: null, guid: null }, roundId: 1, holeNumber: 1, holeShot: 2,
    globalShotNumber: 2, shotId: 's', courseKey: 'c', startingSurfaceRaw: 2, endingSurfaceRaw: 2,
    distanceToPinYds: 10, isHoled: false, isGimme: false, ballSpeedMph: null, carryYards: null,
    totalYards: null, verticalLaunchAngleDegrees: null, horizontalLaunchAngleDegrees: 0, totalSpinRpm: null,
    spinAxisDegrees: 0, backSpinRpm: null, sideSpinRpm: null, gsproClubIndex: null, rawMetrics: {}, ...over,
  })

  // Clean fairway 7-iron: unchanged behavior, every metric used.
  const clean = inferClubForGsproShot(sessions, gsproShot({
    ballSpeedMph: 115, carryYards: 163, totalYards: 172, verticalLaunchAngleDegrees: 17, totalSpinRpm: 6200,
    rawMetrics: { ballSpeedRaw: 115 },
  }))
  assert.equal(clean.predictedClub, '7i')
  assert.ok(clean.metricsUsed.includes('carry') && clean.metricsUsed.includes('spin'))

  // Real deep-rough shot (26 Nov data): 6-iron swung at 114.3 mph, GSPro left 90.4 mph and a 121 yd carry.
  // Before the fix this was guessed PW.
  const deep6 = gsproShot({
    startingSurfaceRaw: 3, ballSpeedMph: 90.4, carryYards: 121.2, totalYards: 125, verticalLaunchAngleDegrees: 15.2,
    totalSpinRpm: 2900, rawMetrics: { ballSpeedRaw: 114.3 },
  })
  assert.equal(lieCutLaunchSpeed(deep6), 114.3)
  const deep = inferClubForGsproShot(sessions, deep6)
  assert.ok(['6i', '7i'].includes(deep.predictedClub), `deep rough 6i guessed ${deep.predictedClub}`)
  assert.notEqual(deep.predictedClub, 'PW')
  assert.deepEqual([...deep.metricsUsed].sort(), ['ball_speed', 'launch'], 'carry, total and spin are left out off a cut lie')

  // Fairway bunker 9-iron: 104 mph swing, GSPro kept 93% (96.7 mph), 122 yd carry. Was guessed GW.
  const sand = inferClubForGsproShot(sessions, gsproShot({
    startingSurfaceRaw: 11, ballSpeedMph: 96.7, carryYards: 122.2, totalYards: 126, verticalLaunchAngleDegrees: 22,
    totalSpinRpm: 6000, rawMetrics: { ballSpeedRaw: 104 },
  }))
  assert.equal(sand.predictedClub, '9i')

  // Semi-rough keeps 98.5% of the speed: treated as a clean lie, all metrics used.
  const semi = gsproShot({ startingSurfaceRaw: 12, ballSpeedMph: 113.3, carryYards: 161, totalYards: 170,
    verticalLaunchAngleDegrees: 17, totalSpinRpm: 5900, rawMetrics: { ballSpeedRaw: 115 } })
  assert.equal(lieCutLaunchSpeed(semi), null)
  assert.ok(inferClubForGsproShot(sessions, semi).metricsUsed.includes('carry'))

  // No raw speed recorded (older rows): unchanged.
  assert.equal(lieCutLaunchSpeed(gsproShot({ ballSpeedMph: 90 })), null)

  // A putt carrying the previous swing's numbers: no club guessed (it was a wedge every time).
  const putt = inferClubForGsproShot(sessions, gsproShot({
    startingSurfaceRaw: 5, ballSpeedMph: 114.1, carryYards: 2.3, totalYards: 181, verticalLaunchAngleDegrees: 18,
    totalSpinRpm: 6266, rawMetrics: { ballSpeedRaw: 114.1, putt: { isPutt: true } },
  }))
  assert.equal(putt.predictedClub, null)
  assert.equal(putt.confidence, null)
  assert.deepEqual(putt.alternatives, [])

  console.log('club inference off lies and on putts: ok')
} finally {
  await vite.close()
}
