import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const vite = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
})

const rect = (x1, y1, x2, y2) => [
  [x1, y1], [x2, y1], [x2, y2], [x1, y2],
]

const surface = (kind, polygon) => ({
  id: `fixture-${kind}`,
  kind,
  polygons: [polygon],
  provenance: { source: 'osm', confidence: 'high' },
})

const packagedSurface = (kind, polygons) => ({
  id: `augusta-h1-${kind}`,
  kind,
  polygons,
  provenance: { source: 'osm', confidence: 'high' },
})

const polygonCandidates = (polygon) => {
  const xs = polygon.map((point) => point[0])
  const ys = polygon.map((point) => point[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const candidates = []

  candidates.push([
    polygon.reduce((sum, point) => sum + point[0], 0) / polygon.length,
    polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length,
  ])

  for (let i = 0; i < polygon.length; i += 1) {
    const start = polygon[i]
    const end = polygon[(i + 1) % polygon.length]
    candidates.push(start)
    candidates.push([(start[0] + end[0]) / 2, (start[1] + end[1]) / 2])
  }

  for (let row = 1; row < 10; row += 1) {
    for (let col = 1; col < 10; col += 1) {
      candidates.push([
        minX + ((maxX - minX) * col) / 10,
        minY + ((maxY - minY) * row) / 10,
      ])
    }
  }
  return candidates
}

try {
  const { classifyPoint, pointInPolygon } = await vite.ssrLoadModule('/src/courseGeometry/geometry.ts')
  const { SURFACE_CLASSIFICATION_PRECEDENCE } = await vite.ssrLoadModule('/src/courseGeometry/semantics.ts')

  assert.deepEqual(
    [...SURFACE_CLASSIFICATION_PRECEDENCE],
    ['water', 'penalty', 'bunker', 'green', 'tee', 'fairway', 'deep-rough', 'rough'],
    'explicit golf surfaces must beat vegetation, and vegetation must beat ordinary rough',
  )

  const hole = {
    schemaVersion: 'looper-course-geometry-v1',
    courseId: 'fixture',
    courseName: 'Fixture',
    holeNumber: 1,
    coordinateSystem: { units: 'yards', origin: 'selected-tee', xAxis: 'right', yAxis: 'forward' },
    bounds: { minX: -12, maxX: 12, minY: -12, maxY: 12 },
    markers: { tee: [0, 0] },
    surfaces: [
      surface('rough', rect(-10, -10, 10, 10)),
      surface('deep-rough', rect(-8, -8, 8, 8)),
      surface('fairway', rect(-6, -6, 6, 6)),
      surface('green', rect(-4, -4, 4, 4)),
      surface('bunker', rect(-2, -2, 2, 2)),
      surface('water', rect(-1, -1, 1, 1)),
    ],
    availability: {
      tee: 'unavailable', fairway: 'available', rough: 'available', 'deep-rough': 'available',
      green: 'available', bunker: 'available', water: 'available', penalty: 'unavailable',
    },
    registration: { status: 'verified', targetCoordinateSystem: 'looper-hole-local-yards' },
    provenance: { geometrySource: 'fixture' },
  }

  assert.equal(classifyPoint(hole, [0, 0]).kind, 'water')
  assert.equal(classifyPoint(hole, [1.5, 0]).kind, 'bunker')
  assert.equal(classifyPoint(hole, [3, 0]).kind, 'green')
  assert.equal(classifyPoint(hole, [5, 0]).kind, 'fairway')
  assert.equal(classifyPoint(hole, [7, 0]).kind, 'deep-rough')
  assert.equal(classifyPoint(hole, [9, 0]).kind, 'rough')

  const teeVsWoods = {
    ...hole,
    surfaces: [
      surface('deep-rough', rect(-5, -5, 5, 5)),
      surface('tee', rect(-2, -2, 2, 2)),
    ],
  }
  assert.equal(classifyPoint(teeVsWoods, [0, 0]).kind, 'tee')

  const augustaPackage = JSON.parse(readFileSync(
    new URL('../public/course-geometry/augusta-national/course-v1.json', import.meta.url),
    'utf8',
  ))
  const rawH1 = augustaPackage.holes?.['1']
  assert.ok(rawH1, 'Augusta National H1 must be committed for the real-hole probe')

  const rawSurfaces = rawH1.surfaces ?? {}
  const rawContext = rawH1.context ?? {}
  const deepRough = [...(rawContext.woods ?? []), ...(rawContext.scrub ?? [])]
  const realSurfaces = Object.entries(rawSurfaces)
    .filter(([, polygons]) => Array.isArray(polygons) && polygons.length > 0)
    .map(([kind, polygons]) => packagedSurface(kind, polygons))
  if (deepRough.length > 0) realSurfaces.push(packagedSurface('deep-rough', deepRough))

  const augustaH1 = {
    ...hole,
    courseId: 'augusta-national',
    courseName: 'Augusta National',
    surfaces: realSurfaces,
  }

  const findClassifiedPoint = (kind) => {
    const matching = augustaH1.surfaces.filter((candidate) => candidate.kind === kind)
    for (const candidate of matching) {
      for (const polygon of candidate.polygons) {
        for (const point of polygonCandidates(polygon)) {
          if (!pointInPolygon(point, polygon)) continue
          if (classifyPoint(augustaH1, point).kind === kind) return point
        }
      }
    }
    return null
  }

  const probes = {}
  for (const kind of ['water', 'bunker', 'green', 'fairway', 'deep-rough']) {
    probes[kind] = findClassifiedPoint(kind)
    assert.ok(probes[kind], `Augusta H1 has no point that resolves tactically as ${kind}`)
  }
  probes.rough = findClassifiedPoint('rough')

  console.log(
    'Augusta National H1 point probes:',
    Object.entries(probes).map(([kind, point]) => `${kind}=${point ? point.map((v) => v.toFixed(1)).join(',') : 'fully-overridden'}`).join(' | '),
  )
  console.log('Runtime surface precedence: explicit hazards/golf surfaces > vegetation > rough: ok')
} finally {
  await vite.close()
}
