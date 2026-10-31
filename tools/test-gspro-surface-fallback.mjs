import assert from 'node:assert/strict'
import { createServer } from 'vite'

// FarmLinks White H1 Round 255 Shot 1: GSPro displayed DEEP ROUGH
// 449.6 yd remaining, while Looper previously displayed SAND and applied
// a -91.6 yd bunker carry modifier. CurrentRound numeric "3" -> "sand"
// was unverified. Do not invent an exact lie from ambiguous telemetry.
const vite = await createServer({appType:'custom',logLevel:'silent',server:{middlewareMode:true}})
try {
  const {surfaceFromGsproRaw} = await vite.ssrLoadModule('/src/adapters/gsproSurfaceCodes.ts')
  const {getSurfaceResponse} = await vite.ssrLoadModule('/src/liveCaddie/surfaceResponse.ts')
  const {activeManualLieSurface,liveShotLieKey} =
    await vite.ssrLoadModule('/src/liveCaddie/currentShotLie.ts')
  assert.equal(surfaceFromGsproRaw(18),'tee')
  assert.equal(surfaceFromGsproRaw(2),'fairway')
  assert.equal(surfaceFromGsproRaw(5),'green')
  assert.equal(surfaceFromGsproRaw(1),'rough')
  assert.equal(surfaceFromGsproRaw(3),'deep-rough',
    'Raw 3 is Deep Rough (paired R269), never sand carry physics')
  assert.notEqual(surfaceFromGsproRaw(3),'sand')
  assert.equal(surfaceFromGsproRaw(11),'sand','Raw 11 is Sand (paired R269 bunker)')
  assert.equal(surfaceFromGsproRaw(777),null)
  const shot2=liveShotLieKey('farmlinks',1,255,2,'shot1')
  const saved={shotKey:shot2,surface:'deep-rough'}
  assert.equal(activeManualLieSurface(shot2,saved),'deep-rough')
  assert.equal(activeManualLieSurface(liveShotLieKey('farmlinks',1,255,3,'shot2'),saved),null)
  assert.equal(activeManualLieSurface(liveShotLieKey('farmlinks',2,255,2,'shot1'),saved),null)
  assert.equal(activeManualLieSurface(liveShotLieKey('greywolf',1,255,2,'shot1'),saved),null)
  assert.equal(activeManualLieSurface(shot2,null),null)
  assert.equal(getSurfaceResponse('deep-rough').kind,'deep-rough')
  assert.equal(getSurfaceResponse('deep-rough').label,'Deep rough')
  assert.notDeepEqual(getSurfaceResponse('deep-rough').factors,
    getSurfaceResponse('sand').factors)
  assert.equal(getSurfaceResponse('rough').kind,'rough')
  console.log('PASS: raw 3 = deep rough (not sand), raw 11 = sand; FarmLinks confirmed Deep Rough gets distinct physics and expires with next shot/hole.')
} finally {await vite.close()}
