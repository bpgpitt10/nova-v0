// Punch-out mode (Brian, 20 Nov): in the trees, Looper says so and leaves the aim to the player.
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
  const { ballInTrees } = await load('/src/liveCaddie/punchOut.ts')
  const prov = { source: 'osm', confidence: 'high' }
  const fairway = { id: 'fw', kind: 'fairway', polygons: [[[-25, 100], [25, 100], [25, 400], [-25, 400]]], provenance: prov }
  const rough = { id: 'rough', kind: 'rough', polygons: [[[-120, 0], [120, 0], [120, 400], [-120, 400]]], provenance: prov }
  const woods = (polygons) => ({ id: 'w', kind: 'woods', polygons, provenance: prov })
  const hole = (layers) => ({ holeNumber: 1, markers: { tee: [0, 0], pin: [0, 420] }, surfaces: [fairway, rough], contextLayers: layers })
  const pin = [0, 420]

  // Under the canopy (a stand left of the fairway): in the trees.
  const stand = hole([woods([[[-110, 150], [-60, 150], [-60, 250], [-110, 250]]])])
  assert.equal(ballInTrees(stand, [-85, 200], pin), true)
  // In the rough beside the same stand, with a clear line: not.
  assert.equal(ballInTrees(stand, [-45, 200], pin), false)
  // On the fairway, even under an overhanging canopy outline: not.
  const overhang = hole([woods([[[-30, 150], [30, 150], [30, 170], [-30, 170]]])])
  assert.equal(ballInTrees(overhang, [0, 160], pin), false)
  // In the rough, not under trees, but a wall of trees from 5 yd ahead across every line in ±40°: boxed in.
  const wall = hole([woods([[[-160, 205], [160, 205], [160, 260], [-160, 260]]])])
  assert.equal(ballInTrees(wall, [-50, 200], pin), true)
  // A gap in the wall within ±40° of the pin line: a way out, not boxed in.
  const gap = hole([woods([[[-160, 205], [-60, 205], [-60, 260], [-160, 260]]]), woods([[[-30, 205], [160, 205], [160, 260], [-30, 260]]])])
  assert.equal(ballInTrees(gap, [-50, 200], pin), false)
  // No hole or no ball: off.
  assert.equal(ballInTrees(null, [0, 0], pin), false)
  // The punch: a low iron from the bag, never a wedge; the nearest fairway and which side it's on.
  const { punchOutClub, nearestFairway } = await server.ssrLoadModule('/src/liveCaddie/punchOut.ts')
  assert.equal(punchOutClub(['Driver', '3H', '5i', '9i', 'SW']), '5i')
  assert.equal(punchOutClub(['Driver', '6i', '9i']), '6i')
  assert.equal(punchOutClub(['Driver', 'PW', 'SW']), null)
  const fairwayLeft = { surfaces: [{ kind: 'fairway', polygons: [[[-60, 0], [-20, 0], [-20, 300], [-60, 300]]] }] }
  const out = nearestFairway(fairwayLeft, [0, 100], [0, 400])
  assert.ok(Math.abs(out.yds - 20) < 0.01)
  assert.equal(out.side, 'left')
  assert.equal(nearestFairway({ surfaces: [] }, [0, 100], [0, 400]), null)
  console.log('PASS: punch-out mode under the canopy or boxed in by trees; not on the fairway, beside the trees, or with a gap toward the pin.')
} finally {
  await server?.close()
}
