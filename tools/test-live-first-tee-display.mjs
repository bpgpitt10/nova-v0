import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { resolveLiveFirstTeeDisplay } = await server.ssrLoadModule('/src/courseGeometry/liveFirstUseTeeState.ts')
  // Reproduce the exact 2026-10-13 FarmLinks field failure:
  // browser/manual start still had 572yd and the back-tee (0,0) despite
  // native 445/253 waypoint ruler matching ~493yd OSM Tee 3.
  const backTee = {
    holeNumber: 1, nextShotNumber: 1, teePlacement: 'provisional',
    ballLocalYds: [0, 0], distanceToPinYds: 572,
  }
  const measurement = {
    point: [-37.351, 78.434], distanceYds: 493,
    uncertaintyYds: 25, source: 'distance-matched-osm-tee',
  }
  const initial = resolveLiveFirstTeeDisplay(backTee, 1, null, null)
  assert.deepEqual(initial.ball, [0,0])
  assert.equal(initial.distanceToPinYds, 572)
  const afterOcr = resolveLiveFirstTeeDisplay(backTee, 1, measurement, null)
  assert.deepEqual(afterOcr.ball, [-37.351,78.434], 'Native tee must outrank stale manual back tee')
  assert.equal(afterOcr.distanceToPinYds, 493, 'Header must use same native tee ruler')
  assert.equal(afterOcr.measured.uncertaintyYds, 25)
  // Later unchanged/currentRound updates must preserve the same tee geometry.
  const refreshedBackTee = { ...backTee, ballLocalYds: [0,0], distanceToPinYds: 572 }
  const stillLive = resolveLiveFirstTeeDisplay(refreshedBackTee, 1, measurement, measurement)
  assert.equal(stillLive.distanceToPinYds, 493)
  // Native observation expiry/reload: per-round local storage candidate wins.
  const expired = resolveLiveFirstTeeDisplay(refreshedBackTee, 1, null, measurement)
  assert.deepEqual(expired.ball, measurement.point)
  assert.equal(expired.distanceToPinYds, 493)
  // Critical safety: after the actual first shot, native tee MUST NOT override
  // physical current ball/yardage from GSPro.
  const shotTwo = {
    holeNumber: 1, nextShotNumber: 2, teePlacement: null,
    ballLocalYds: [-33.417, 305.539], distanceToPinYds: 262.72,
  }
  const current = resolveLiveFirstTeeDisplay(shotTwo, 1, measurement, measurement)
  assert.equal(current.measured, null)
  assert.deepEqual(current.ball, shotTwo.ballLocalYds)
  assert.equal(current.distanceToPinYds, 262.72)
  const wrongHole = resolveLiveFirstTeeDisplay(backTee, 2, measurement, measurement)
  assert.equal(wrongHole.measured, null)
  const invalid = resolveLiveFirstTeeDisplay(backTee,1,{...measurement,distanceYds:Number.NaN},null)
  assert.deepEqual(invalid.ball,[0,0])
  assert.equal(invalid.distanceToPinYds,572)
  console.log('PASS: native White tee supersedes 572yd back-tee in ball and header; persists across snapshot refresh/measurement expiry; physical Shot 2 always wins.')
} finally { await server.close() }
