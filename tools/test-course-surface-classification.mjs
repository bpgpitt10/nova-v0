import assert from 'node:assert/strict'
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

try {
  const { classifyPoint } = await vite.ssrLoadModule('/src/courseGeometry/geometry.ts')
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

  console.log('Runtime surface precedence: explicit hazards/golf surfaces > vegetation > rough: ok')
} finally {
  await vite.close()
}
