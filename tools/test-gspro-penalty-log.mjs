// GSPro output_log penalty lines -> learned lie physics and code pairs.
// Line formats copied from a real FarmLinks output_log (2026-10-30); values synthetic.
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

const db = new Map()
globalThis.window = { localStorage: {
  getItem: (k) => db.get(k) ?? null,
  setItem: (k, v) => db.set(k, String(v)),
  removeItem: (k) => db.delete(k),
} }

try {
  const log = await load('/src/adapters/gsproPenaltyLog.ts')
  const surface = await load('/src/liveCaddie/surfaceResponse.ts')

  const filename = '(Filename: C:\\buildslave\\unity\\build\\Runtime/Export/Debug.bindings.h Line: 43)'
  const shot = (launch, penalty, type) => [
    `LaunchExt Vars: ${launch}`, ' ', filename, '', 'LaunchExt - Regular Mode', ' ', filename, '',
    ...(penalty ? [penalty, ' ', filename, ''] : []),
    ...(type != null ? [` ... corrected type ${type}`, ' ', filename, ''] : []),
  ].join('\n')
  const text = [
    shot('sp 133.7, el 12.33, az 2.03, ts 2977.26, sa -5.24, cy 212.5, id 1', null, null),
    shot('sp 76.2, el 27.68, az -14.76, ts 8538.42, sa -4.64, cy 89.77, id 13',
      'Penalty Surface TVGdeeprough, Spin53%, Speed 80%, VLA 98%', 3),
    shot('sp 62.75, el 27.21, az -1.41, ts 6835.01, sa 3.02, cy 66.7, id 15',
      'Penalty Surface TVGdeeprough, Spin56%, Speed 78%, VLA 98%', null),
    shot('sp 98.01, el 20.83, az -0.79, ts 8528.51, sa -4.4, cy 126.88, id 17',
      'Penalty Surface TVGrough, Spin77%, Speed 94%, VLA 100%', 1),
    shot('sp 45.54, el 32.1, az -3.5, ts 8209.63, sa 3.15, cy 38.41, id 21',
      'Penalty Surface TVGsand, Spin86%, Speed 84%, VLA 100%', 11),
    shot('sp 30, el 30, az 0, ts 4000, sa 0, cy 20, id 23',
      'Penalty Surface TVGpinestraw, Spin70%, Speed 90%, VLA 100%', 9),
  ].join('\n')

  // 1. Parsing: each penalty bound to its launch and GSPro's code.
  const events = log.parseGsproPenaltyEvents(text)
  assert.equal(events.length, 5, 'only shots from penalty lies')
  const [deep1, deep2, rough, sand, pine] = events
  assert.deepEqual([deep1.lie, deep1.speed, deep1.spin, deep1.vla, deep1.typeCode], ['deep-rough', 0.8, 0.53, 0.98, 3])
  assert.equal(deep1.launch.ballSpeedMph, 76.2)
  assert.equal(deep1.launch.vlaDeg, 27.68)
  assert.equal(deep2.typeCode, null, 'no "corrected type" line -> unknown code')
  assert.deepEqual([rough.lie, rough.typeCode, sand.lie, sand.typeCode], ['rough', 1, 'sand', 11])
  assert.equal(pine.lie, null, 'unseen GSPro surface names stay unknown')

  // 2. Recording de-duplicates repeated log reads; unknown names are not stored.
  assert.equal(log.recordPenaltyEvents(events), 4)
  assert.equal(log.recordPenaltyEvents(log.parseGsproPenaltyEvents(text)), 0, 'same log re-read adds nothing')

  // 3. Learned physics: median per lie once there are 2+ shots.
  const learned = log.learnedSurfaceFactors()
  assert.deepEqual(learned['deep-rough'], { speed: 0.79, spin: 0.545, vla: 0.98, samples: 2 })
  assert.equal(learned.rough, undefined, 'one rough shot is not enough')
  assert.equal(learned.sand, undefined)

  // 4. Code pairs straight from GSPro: 3 deep rough, 1 rough, 11 sand.
  const codes = log.learnedCodeLies()
  assert.deepEqual([...codes.entries()].sort((a, b) => a[0] - b[0]), [[1, 'rough'], [3, 'deep-rough'], [11, 'sand']])

  // 5. Physics uses the golfer's own penalties when set, defaults otherwise.
  assert.equal(surface.getSurfaceResponse('deep-rough').factors.speed, 0.82, 'default before learning')
  surface.setLearnedSurfaceFactors(learned)
  const deep = surface.getSurfaceResponse('deep-rough')
  assert.equal(deep.factors.speed, 0.79)
  assert.equal(deep.factors.spin, 0.545)
  assert.match(deep.evidence, /Your GSPro shots \(2\)/)
  assert.equal(surface.getSurfaceResponse('rough').factors.speed, 0.96, 'rough keeps the default')
  surface.setLearnedSurfaceFactors({ 'deep-rough': { speed: 0.1, spin: 0.5, vla: 1, samples: 5 } })
  assert.equal(surface.getSurfaceResponse('deep-rough').factors.speed, 0.82, 'implausible values ignored')
  surface.setLearnedSurfaceFactors(null)

  // 6. A contradicted code is not learned.
  const conflicting = log.parseGsproPenaltyEvents(shot('sp 50, el 25, az 0, ts 5000, sa 0, cy 40, id 31',
    'Penalty Surface TVGrough, Spin60%, Speed 97%, VLA 100%', 3))
  log.recordPenaltyEvents(conflicting)
  assert.equal(log.learnedCodeLies().has(3), false, 'code 3 seen as two different lies -> not learned')

  console.log('PASS: GSPro penalty log parsed; learned lie physics (median, 2+ shots) and code pairs; duplicates and unknown surfaces ignored.')
} finally {
  await server?.close()
}
