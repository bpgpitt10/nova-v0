// Match an installed GSPro course to its real course by green geometry
// (spec: claude/spec-geometry-course-matching.md, Match 1).
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
  const { fitGreens, fitAccepted, matchCourseByGreens } = await load('/src/courseLoading/courseGeometryMatch.ts')
  // A deterministic "course": 18 greens spread over ~1.6 x 1.2 km.
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const real = Array.from({ length: 18 }, () => [rnd() * 1600 - 800, rnd() * 1200 - 600])
  // GSPro scene: rotated 37°, mirrored, shifted, holes in a different order,
  // three greens missing from the map, four strays from a neighbouring course.
  const th = 37 * Math.PI / 180
  const toScene = ([e, n]) => { const x = -e, z = n; return [Math.cos(th) * x - Math.sin(th) * z + 5000, Math.sin(th) * x + Math.cos(th) * z - 3000] }
  const gkd = real.map(toScene).reverse()
  const mapGreens = [...real.slice(3), [1500, 900], [1600, 950], [1700, 880], [1650, 1000]]
  const fit = fitGreens(gkd, mapGreens)
  assert.ok(fit, 'fits')
  assert.ok(fit.rmsM < 2, `rms ${fit.rmsM}`)
  assert.equal(fit.paired, 15)
  assert.equal(fit.mirrored, true)
  assert.ok(Math.abs(fit.scale - 1) < 0.01)
  assert.ok(fitAccepted(fit))
  // OSM greens a few metres off (mapper error): still accepted.
  const noisy = real.map(([e, n]) => [e + (rnd() - 0.5) * 12, n + (rnd() - 0.5) * 12])
  const noisyFit = fitGreens(gkd, noisy)
  assert.ok(noisyFit.rmsM < 8 && fitAccepted(noisyFit), JSON.stringify(noisyFit))
  // A different course's greens: no accepted fit.
  const other = Array.from({ length: 18 }, () => [rnd() * 1600 - 800, rnd() * 1200 - 600])
  const otherFit = fitGreens(gkd, other)
  assert.equal(fitAccepted(otherFit), false, JSON.stringify(otherFit))

  // Candidates in lat/lon: the real course and a neighbour 3 km away.
  const lat0 = 36.57, lon0 = -121.95
  const toLatLon = ([e, n], dE = 0) => [lat0 + n / 110_540, lon0 + (e + dE) / (111_320 * Math.cos(lat0 * Math.PI / 180))]
  const realLL = real.map((p) => toLatLon(p))
  const neighbourLL = other.map((p) => toLatLon(p, 3000))
  const bbox = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]
  const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]
  const rb = bbox(realLL), nb = bbox(neighbourLL)
  const candidates = [
    { osmType: 'way', osmId: 2, name: 'Neighbour Links', centre: centre(nb), bbox: nb },
    { osmType: 'relation', osmId: 1, name: 'Pebble Beach Golf Links', centre: centre(rb), bbox: rb },
  ]
  const result = matchCourseByGreens(gkd, candidates, [...realLL, ...neighbourLL])
  assert.equal(result.status, 'matched')
  assert.equal(result.best.osmId, 1)
  // Only the neighbour on the map: no fit (Kiawah-style), best reported for diagnosis.
  const none = matchCourseByGreens(gkd, [candidates[0]], neighbourLL)
  assert.equal(none.status, 'no-fit')
  assert.equal(matchCourseByGreens(gkd, [], []).status, 'no-candidates')
  console.log('PASS: green geometry finds the real course through rotation, mirroring, renumbering, missing and stray greens; rejects other courses.')
} finally {
  await server?.close()
}
