// Trees in the flight path (spec: claude/spec-long-shot-engine.md, piece 3).
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
try {
  const { flightBlockedAt, sampleModeledAimDistribution } = await load('/src/liveCaddie/aimOutcomeSampling.ts')
  const prov = { source: 'osm', confidence: 'high' }
  const tee = { id: 'tee', kind: 'tee', polygons: [[[-6, -6], [6, -6], [6, 6], [-6, 6]]], provenance: prov }
  const fairway = { id: 'fw', kind: 'fairway', polygons: [[[-25, 180], [25, 180], [25, 280], [-25, 280]]], provenance: prov }
  const woodsLayer = (polygons) => ({ id: 'w', kind: 'woods', polygons, provenance: prov })
  // A wall of trees 15-45 yd ahead, across the whole line.
  const boxedIn = { holeNumber: 1, markers: { tee: [0, 0], pin: [0, 420] }, surfaces: [tee, fairway],
    contextLayers: [woodsLayer([[[-60, 15], [60, 15], [60, 45], [-60, 45]]])] }
  const blocked = flightBlockedAt(boxedIn, [0, 0], [0, 240], 38)
  assert.equal(blocked?.tag, 'trees-early')
  assert.ok(blocked.point[1] >= 12 && blocked.point[1] <= 36)
  // One thin tree line crossing at 24 yd only: a single point, not a wall.
  const thin = { ...boxedIn, contextLayers: [woodsLayer([[[-60, 22], [60, 22], [60, 26], [-60, 26]]])] }
  assert.equal(flightBlockedAt(thin, [0, 0], [0, 240], 38), null)
  // Trees just short of the fairway, under 15 yd of height on a 50° wedge descent: trees-late.
  const shortTrees = { ...boxedIn, contextLayers: [woodsLayer([[[-60, 120], [60, 120], [60, 135], [-60, 135]]])] }
  const late = flightBlockedAt(shortTrees, [0, 0], [0, 140], 50)
  assert.equal(late?.tag, 'trees-late')
  // A steeper Driver-height descent 16 yd back is above the trees at 8 yd only if tan(d)*8 < 15: still checked at 8.
  assert.equal(flightBlockedAt(shortTrees, [0, 0], [0, 240], 38), null, 'trees far short of a long carry are flown over')
  // Mid-flight (Georgia Golf Club 2 and 9): a stand of pines 50-90 yd out. A Driver (peak 30 yd)
  // is still under the 27-yd canopy there, so it flies into them; the old checks missed it.
  const stand = (from, to) => ({ ...boxedIn, contextLayers: [woodsLayer([[[-60, from], [60, from], [60, to], [-60, to]]])] })
  assert.equal(flightBlockedAt(stand(50, 90), [0, 0], [0, 240], 38, 30)?.tag, 'trees-mid')
  // Near the top of the flight it clears them; a punched shot (peak 12 yd) does not.
  assert.equal(flightBlockedAt(stand(115, 150), [0, 0], [0, 240], 38, 30), null)
  assert.equal(flightBlockedAt(stand(115, 150), [0, 0], [0, 240], 38, 12)?.tag, 'trees-mid')
  // Coming down 40-60 yd short of the landing, still below the canopy: trees.
  assert.equal(flightBlockedAt(stand(180, 200), [0, 0], [0, 240], 38, 30)?.tag, 'trees-mid')
  // Trees standing on mapped rough count too (the woods layer, not the surface under it).
  const roughUnder = { id: 'r', kind: 'rough', polygons: [[[-100, 0], [100, 0], [100, 300], [-100, 300]]], provenance: prov }
  assert.equal(flightBlockedAt({ ...boxedIn, surfaces: [tee, fairway, roughUnder] }, [0, 0], [0, 240], 38)?.tag, 'trees-early')
  // A single 6-yd row is one point, not a stand.
  assert.equal(flightBlockedAt(stand(60, 66), [0, 0], [0, 240], 38, 30), null)
  // The height model: 0 at launch, the peak a little past halfway, 0 at the carry.
  const { ballHeightAt } = await load('/src/liveCaddie/aimOutcomeSampling.ts')
  assert.equal(ballHeightAt(0, 240, 30, 38), 0)
  assert.ok(Math.abs(ballHeightAt(240 * 0.56, 240, 30, 38) - 30) < 1e-9)
  assert.ok(Math.abs(ballHeightAt(240, 240, 30, 38)) < 1e-9)

  // Clear line: nothing.
  const open = { ...boxedIn, contextLayers: [] }
  assert.equal(flightBlockedAt(open, [0, 0], [0, 240], 38), null)

  // Through the sampler: the boxed-in Driver is nearly all trees; an open line isn't.
  const sample = (hole) => sampleModeledAimDistribution({ hole, ball: [0, 0], aimPoint: [0, 240], carryMeanYds: 240,
    totalMeanYds: 258, lateralMeanYds: 0, carrySigmaYds: 8, lateralSigmaYds: 10, pinLocalYds: [0, 420],
    flightCheck: { descentDeg: 38 } })
  const share = (s) => s.samples.filter((q) => q.flightTag === 'trees-early').length / s.samples.length
  assert.ok(share(sample(boxedIn)) > 0.95)
  assert.equal(share(sample(open)), 0)
  const blockedSample = sample(boxedIn).samples.find((q) => q.flightTag)
  assert.equal(blockedSample.kind, 'deep-rough')
  assert.equal(blockedSample.state.obstruction, 'woods-or-scrub')
  console.log('PASS: flights through trees after launch, in flight below the canopy or on the way down end in the trees; thin lines, open lines and stands flown over are clear.')
} finally {
  await server?.close()
}
