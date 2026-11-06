// Course crosswalk decisions (src/courseLoading/courseCrosswalk.ts).
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
  const { crosswalkDecision } = await load('/src/courseLoading/courseCrosswalk.ts')
  const base = {
    sgt_id: 1374, name: 'Greywolf Golf Course', location: 'Panorama, British Columbia, Canada',
    lat: 50.4464, lon: -116.2476, gspro_folder: 'GreyWolf_gsp', osm_name: null, candidates: [], verified: false,
  }
  assert.deepEqual(crosswalkDecision(null), { kind: 'unknown' })

  // Matched: load exactly that map course, at the course's own coordinates.
  const matched = crosswalkDecision({ ...base, status: 'matched', osm_type: 'relation', osm_id: 21216862 })
  assert.equal(matched.kind, 'load')
  assert.equal(matched.osmId, 21216862)
  assert.equal(matched.lat, 50.4464)

  // Review: the candidates to pick from (an unnamed outline is labelled, not blank).
  const review = crosswalkDecision({
    ...base, status: 'review', osm_type: 'way', osm_id: 1209552048,
    candidates: [{ type: 'relation', id: 21216862, name: 'Greywolf Golf Course', distanceM: 40, score: 1 },
      { type: 'way', id: 1209552048, name: '', distanceM: 160, score: 0 }],
  })
  assert.equal(review.kind, 'pick')
  assert.equal(review.candidates.length, 2)
  assert.match(review.candidates[1].name, /no name, 0\.2 km/)

  // Not on the map / fictional: say so (it still plays from GSPro's file).
  assert.equal(crosswalkDecision({ ...base, status: 'no-map', osm_type: null, osm_id: null }).kind, 'not-on-map')
  assert.equal(crosswalkDecision({ ...base, status: 'fictional', lat: null, lon: null, osm_type: null, osm_id: null }).kind, 'not-on-map')

  console.log('course crosswalk: matched loads the map course, review offers candidates, no-map and fictional say why.')
} finally {
  await server?.close()
}
