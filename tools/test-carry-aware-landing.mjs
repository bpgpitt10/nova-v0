// Hazards count where the ball touches down or rolls in, not only where the
// stock rollout would have stopped it (src/liveCaddie/carryAwareLanding.ts).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
const realFetch = globalThis.fetch
try {
  const { resolveCarryAwareLanding } = await load('/src/liveCaddie/carryAwareLanding.ts')
  const { sampleModeledAimDistribution } = await load('/src/liveCaddie/aimOutcomeSampling.ts')

  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  const surface = (id, kind, polygons) => ({ id, kind, polygons, provenance: { source: 'manual', confidence: 'high' } })
  const hole = {
    holeNumber: 1,
    markers: { tee: [0, 0], pin: [0, 300] },
    surfaces: [
      surface('fw', 'fairway', [rect(-20, 0, 20, 320)]),
      surface('pond', 'water', [rect(-20, 200, 20, 210)]),
      surface('trap', 'bunker', [rect(-20, 250, 20, 256)]),
    ],
  }

  // 1. Touchdown in water, stock rollout would finish dry beyond it → water, at the touchdown point.
  let r = resolveCarryAwareLanding(hole, [0, 205], [0, 220])
  assert.equal(r.classification.kind, 'water')
  assert.equal(r.rule, 'carry-in-hazard')
  assert.deepEqual(r.landing, [0, 205])

  // 2. Touchdown in a bunker → stays in the bunker.
  r = resolveCarryAwareLanding(hole, [5, 252], [5, 270])
  assert.equal(r.classification.kind, 'bunker')
  assert.equal(r.rule, 'carry-in-hazard')

  // 3. Touches down short of the bunker and rolls into it → stops just inside the near edge.
  r = resolveCarryAwareLanding(hole, [0, 244], [0, 262])
  assert.equal(r.classification.kind, 'bunker')
  assert.equal(r.rule, 'rolled-into-hazard')
  assert.ok(r.landing[1] > 250 && r.landing[1] < 251.5, JSON.stringify(r.landing))

  // 4. Rolls into the water from short of it → water at the edge.
  r = resolveCarryAwareLanding(hole, [-3, 192], [-3, 214])
  assert.equal(r.classification.kind, 'water')
  assert.ok(r.landing[1] > 200 && r.landing[1] < 201.5, JSON.stringify(r.landing))

  // 5. Clean fairway shot is unchanged; zero rollout is fine.
  r = resolveCarryAwareLanding(hole, [0, 150], [0, 170])
  assert.equal(r.rule, 'rest')
  assert.equal(r.classification.kind, 'fairway')
  assert.deepEqual(r.landing, [0, 170])
  r = resolveCarryAwareLanding(hole, [0, 150], [0, 150])
  assert.equal(r.classification.kind, 'fairway')

  // 6. Diagonal rollout that ends left of the bunker but clips its corner is captured.
  r = resolveCarryAwareLanding(hole, [24, 245], [16, 262])
  assert.equal(r.classification.kind, 'bunker', JSON.stringify(r))

  // 7. Sampler: every sample whose touchdown is in the pond counts as water.
  const sampled = sampleModeledAimDistribution({
    hole, ball: [0, 0], aimPoint: [0, 200],
    carryMeanYds: 203, totalMeanYds: 218, lateralMeanYds: 0,
    carrySigmaYds: 6, lateralSigmaYds: 6,
  })
  const touchdownInPond = sampled.samples.filter((s) => s.carryLanding[1] >= 200 && s.carryLanding[1] <= 210 && Math.abs(s.carryLanding[0]) <= 20).length
  const waterSamples = sampled.samples.filter((s) => s.kind === 'water').length
  assert.ok(touchdownInPond > 200, `fixture should put real mass in the pond (${touchdownInPond})`)
  assert.ok(waterSamples >= touchdownInPond, `${waterSamples} water < ${touchdownInPond} touchdowns in the pond`)
  assert.ok(sampled.samples.every((s) => s.unobstructedLanding), 'unobstructed rest point is kept for rollout stats')

  // 7b. Capture starts where the ball really comes down. A roll model whose
  //     touchdown is short of the carry point (a ball flying into a hill face)
  //     must not count the ground it flew over: carry is in the pond, but the
  //     ball met the hill at y=190 and rolled to y=196, short of the water.
  const hillFace = Object.assign((carry) => [carry[0], 196], {
    resolve: (carry) => ({ touchdown: [carry[0], 190], rest: [carry[0], 196] }),
  })
  const shortOfPond = sampleModeledAimDistribution({
    hole, ball: [0, 0], aimPoint: [0, 205],
    carryMeanYds: 205, totalMeanYds: 210, lateralMeanYds: 0,
    carrySigmaYds: 1, lateralSigmaYds: 1, landingTransform: hillFace,
  })
  assert.equal(shortOfPond.samples.filter((s) => s.kind === 'water').length, 0, 'touchdown short of the pond on a hill face is dry')
  const { makeRollLandingTransform } = await load('/src/liveCaddie/rollModel.ts')
  const plainRoll = makeRollLandingTransform(hole)
  assert.equal(typeof plainRoll.resolve, 'function', 'the roll model reports its touchdown')
  assert.deepEqual(plainRoll.resolve([0, 150], [0, 170]).touchdown, [0, 150], 'without terrain the touchdown is the carry point')

  // 8. Real course packages (LiDAR enrichment, as the app loads them), same stand-in
  //    dispersion as the review's offline analysis.
  globalThis.fetch = async (url) => {
    const path = new URL(String(url), 'http://local').pathname
    try {
      const body = await readFile(`public${path}`)
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    } catch {
      return new Response('missing', { status: 404 })
    }
  }
  const { loadRoutePackagedCourseHoleGeometry } = await load('/src/courseGeometry/routePackagedCourseLoader.ts')
  const share = (samples, kinds) => samples.filter((s) => kinds.includes(s.kind)).length / samples.length

  const muirfield16 = await loadRoutePackagedCourseHoleGeometry('muirfield-village-golf-club-dublin-oh', 16)
  const par3 = sampleModeledAimDistribution({
    hole: muirfield16, ball: [0, 0], aimPoint: [-1.605, 197.636],
    carryMeanYds: 194.64, totalMeanYds: 198.64, lateralMeanYds: 0, carrySigmaYds: 7, lateralSigmaYds: 8,
  })
  const par3Water = share(par3.samples, ['water', 'penalty'])
  assert.ok(par3Water >= 0.12, `Muirfield 16 tee water ${(par3Water * 100).toFixed(1)}% (rest-only model said ~6%)`)

  const valhalla18 = await loadRoutePackagedCourseHoleGeometry('valhalla-golf-club-louisville-ky', 18)
  const approach = sampleModeledAimDistribution({
    hole: valhalla18, ball: [-76.8, 356.0], aimPoint: [-0.211, 494.893],
    carryMeanYds: 155.61, totalMeanYds: 160.61, lateralMeanYds: 0, carrySigmaYds: 6, lateralSigmaYds: 7,
  })
  const approachBunker = share(approach.samples, ['bunker'])
  assert.ok(approachBunker >= 0.10, `Valhalla 18 approach bunker ${(approachBunker * 100).toFixed(1)}% (rest-only model said ~3%)`)

  console.log(`PASS: touchdown/roll-in capture for water and bunkers; sampler counts every pond touchdown; Muirfield 16 tee water ${(par3Water * 100).toFixed(1)}%, Valhalla 18 approach bunker ${(approachBunker * 100).toFixed(1)}%.`)
} finally {
  globalThis.fetch = realFetch
  await server?.close()
}
