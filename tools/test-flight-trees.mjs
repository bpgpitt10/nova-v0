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
  console.log('PASS: flights through trees after launch or on the way down end in the trees; thin lines and open lines are clear.')
} finally {
  await server?.close()
}
