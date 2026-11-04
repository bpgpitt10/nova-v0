// Unmapped ground: rough on mapped grass, deep rough outside it (tree cover),
// rough when the hole has no landcover evidence. Also runs the next-state proofs.
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
  const { buildDecisionLandingState } = await load('/src/liveCaddie/decisionLandingState.ts')
  const { evaluateDecisionLandingStateValue } = await load('/src/liveCaddie/nextStateValue.ts')
  const { runNextStateValueProofs } = await load('/src/liveCaddie/nextStateValueProof.ts')
  const grass = [[-60, 100], [-10, 100], [-10, 300], [-60, 300]]
  const hole = {
    holeNumber: 1, markers: { tee: [0, 0], pin: [0, 400] },
    surfaces: [{ id: 'fw', kind: 'fairway', polygons: [[[-10, 100], [10, 100], [10, 300], [-10, 300]]], provenance: { source: 'osm', confidence: 'high' } }],
    contextLayers: [{ id: 'g', kind: 'landcover-grass', polygons: [grass], provenance: { source: 'other', confidence: 'medium' } }],
  }
  const unknown = { kind: 'unknown', surfaceId: null, confidence: 'unknown' }
  const onGrass = buildDecisionLandingState(hole, [-30, 200], unknown)
  const offGrass = buildDecisionLandingState(hole, [40, 200], unknown)
  assert.equal(onGrass.unknownGround, 'grass')
  assert.equal(offGrass.unknownGround, 'other')
  const vGrass = evaluateDecisionLandingStateValue(onGrass)
  const vOther = evaluateDecisionLandingStateValue(offGrass)
  assert.equal(vGrass.assumption, 'unknown-as-rough')
  assert.equal(vOther.assumption, 'unknown-as-deep-rough')
  assert.ok(vOther.expectedStrokes > vGrass.expectedStrokes + 0.3, `${vOther.expectedStrokes} vs ${vGrass.expectedStrokes}`)
  // No landcover on the hole: no evidence, stays rough.
  const bare = buildDecisionLandingState({ ...hole, contextLayers: [] }, [40, 200], unknown)
  assert.equal(bare.unknownGround, 'no-landcover')
  assert.equal(evaluateDecisionLandingStateValue(bare).assumption, 'unknown-as-rough')
  // An aim with 40% unknown-off-grass loses to one with 40% rough (same rest).
  const rough = buildDecisionLandingState(hole, [-30, 200], { kind: 'rough', surfaceId: 'r', confidence: 'high' })
  assert.ok(evaluateDecisionLandingStateValue(rough).expectedStrokes < vOther.expectedStrokes)

  const proofs = runNextStateValueProofs()
  const failed = proofs.filter((p) => !p.passed)
  assert.deepEqual(failed, [], `next-state proofs: ${JSON.stringify(failed)}`)
  console.log('PASS: unmapped ground valued by WorldCover evidence; next-state proofs pass.')
} finally {
  await server?.close()
}
