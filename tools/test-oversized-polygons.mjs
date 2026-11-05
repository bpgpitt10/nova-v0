// Oversized polygons (a whole lake shore in a LiDAR package) are clipped to the hole: same answer
// inside the frame, a hole-sized polygon, and point lookups fast again (Arcadia Bluffs: Lake Michigan,
// 79,625 points on every hole, made a tee shot calculate for minutes).
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
  const g = await load('/src/courseGeometry/geometry.ts')

  // A "lake": a wiggly ring 20 km across whose east shore runs just west of the hole.
  const N = 40_000
  const lake = Array.from({ length: N }, (_, i) => {
    const a = (i / N) * 2 * Math.PI
    const r = 10_000 + 6 * Math.sin(a * 900)
    return [-10_250 + r * Math.cos(a), 300 + r * Math.sin(a)]
  })
  const pond = [[40, 200], [80, 200], [80, 240], [40, 240]]
  const frame = { minX: -150, maxX: 150, minY: -50, maxY: 550 }
  const layers = [
    { id: 'water', kind: 'water', polygons: [lake, pond] },
    { id: 'fairway', kind: 'fairway', polygons: [[[-30, 50], [30, 50], [30, 450], [-30, 450]]] },
  ]
  const clipped = g.clipOversizedPolygons(layers, frame)
  const water = clipped.find((l) => l.kind === 'water')
  assert.ok(water.polygons.some((p) => p === pond), 'small polygons are kept as they are')
  const shore = water.polygons.find((p) => p !== pond)
  assert.ok(shore && shore.length < 2_000, `lake cut to the hole (${shore?.length} points)`)
  assert.equal(clipped.find((l) => l.kind === 'fairway').polygons[0], layers[1].polygons[0])

  // Same classification everywhere inside the frame + margin.
  const m = g.OVERSIZED_CLIP_MARGIN_YDS
  let seed = 11
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  let inLake = 0
  for (let i = 0; i < 4000; i += 1) {
    const p = [frame.minX - m + rand() * (frame.maxX - frame.minX + 2 * m), frame.minY - m + rand() * (frame.maxY - frame.minY + 2 * m)]
    const a = g.pointInPolygon(p, lake)
    if (a) inLake += 1
    assert.equal(g.pointInPolygon(p, shore), a, `point ${p} classified the same after clipping`)
  }
  assert.ok(inLake > 200 && inLake < 3800, `the test frame straddles the shore (${inLake} of 4000 in the lake)`)

  // A lake entirely outside the frame disappears; nothing oversized → returned as is.
  const far = lake.map(([x, y]) => [x - 5_000, y])
  assert.equal(g.clipOversizedPolygons([{ id: 'w', kind: 'water', polygons: [far] }], frame).length, 0)
  assert.equal(g.clipOversizedPolygons(layers.slice(1), frame)[0], layers[1])
  // No frame given: the extent of the ordinary polygons is used.
  const noFrame = g.clipOversizedPolygons(layers, null).find((l) => l.kind === 'water')
  assert.ok(noFrame.polygons.every((p) => p.length < 2_000))

  // Lookups: 20k points against the clipped shore in well under a second.
  const started = Date.now()
  for (let i = 0; i < 20_000; i += 1) g.pointInPolygon([-100 + (i % 200), (i % 500)], shore)
  const ms = Date.now() - started
  assert.ok(ms < 1000, `clipped lookups are fast (${ms} ms)`)
  console.log(`PASS: oversized polygons clipped to the hole (40,000 → ${shore.length} points), same answers in the frame, ${ms} ms / 20k lookups.`)
} finally {
  await server?.close()
}
