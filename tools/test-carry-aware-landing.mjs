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

  // 7b. Water is valued from where the ball last crossed into it (backed off 1 yd),
  //     not from the splash point. Pin at [0,300]: entry edge y=200 → relief y≈199.
  const { penaltyReliefPoint } = await load('/src/liveCaddie/carryAwareLanding.ts')
  const relief = penaltyReliefPoint(hole, [0, 0], [0, 205])
  assert.ok(Math.abs(relief[0]) < 1e-9 && Math.abs(relief[1] - 199) < 1e-6, JSON.stringify(relief))
  assert.equal(penaltyReliefPoint(hole, [0, 0], [0, 150]), null, 'no crossing → no relief point')
  const wet = sampled.samples.find((s) => s.kind === 'water')
  assert.ok(Math.abs(wet.state.distanceToPinYds - Math.hypot(wet.landing[0] * 199 / wet.landing[1], 101)) < 0.5,
    `water next-shot distance should be from the entry point (got ${wet.state.distanceToPinYds})`)
  assert.ok(wet.state.distanceToPinYds > Math.hypot(wet.landing[0], 300 - wet.landing[1]),
    'relief is farther from the pin than the splash point')
  // Bunkers are not relief: still valued where the ball sits.
  const sandy = sampled.samples.find((s) => s.kind === 'bunker')
  if (sandy) assert.ok(Math.abs(sandy.state.distanceToPinYds - Math.hypot(sandy.landing[0], 300 - sandy.landing[1])) < 1e-6)

  // 7c. Ranking is pure expected strokes: more water no longer vetoes a club that saves strokes.
  const { rankRiskAwareClubChoices } = await load('/src/liveCaddie/aimDecisionRanking.ts')
  const riskOf = (catastrophe) => ({
    bySurface: { water: catastrophe }, success: 0.8 - catastrophe, manageable: 0.2, seriousTrouble: 0, catastrophe,
    unknown: 0, expectedSeverity: 0, coreProbability: 1, tailProbability: 0, mishitProbability: 0,
    severeMishitProbability: 0, coreSampleCount: 1, tailSampleCount: 0, tailLandings: [],
  })
  const option = (club, catastrophe, strokes) => ({
    club, modeledCarryYds: 180, targetDistanceYds: 186, supportShots: 24, supportingSessions: 3,
    bestCandidate: { aimOffsetYds: 0, score: 0, riskProfile: riskOf(catastrophe), stateValue: { expectedFutureStrokes: strokes } },
  })
  const ranked = rankRiskAwareClubChoices([option('Driver', 0, 3.45), option('5i', 0.115, 2.28)])
  assert.equal(ranked[0].evaluation.club, '5i', 'FarmLinks 17: 5i (11.5% water, E 2.28) beats Driver (E 3.45)')
  assert.ok(ranked.every((row) => row.withinCatastropheGuardrail), 'no option is screened by default')

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
