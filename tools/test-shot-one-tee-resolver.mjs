import assert from 'node:assert/strict'
import {
  courseGeometryFingerprint,
  resolveShotOneTee,
} from '../src/courseGeometry/shotOneTeeResolver.ts'
import {
  loadTeeCalibration,
  lockTeeCalibration,
} from '../src/courseGeometry/teeCalibrationStore.ts'
import { loadCourseTeeCandidates } from '../src/courseGeometry/teeCandidateProvider.ts'

const memory = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
  },
  dispatchEvent: () => true,
}
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type
      this.detail = init.detail
    }
  }
}

const geometry = {
  schemaVersion: 'looper-course-geometry-v1',
  courseId: 'greywolf-panorama-bc',
  courseName: 'Fixture Course',
  holeNumber: 1,
  coordinateSystem: {
    units: 'yards',
    origin: 'selected-tee',
    xAxis: 'right',
    yAxis: 'forward',
  },
  bounds: { minX: -50, maxX: 50, minY: -50, maxY: 450 },
  markers: { tee: [0, 0], pin: [0, 400] },
  teeCandidates: [
    {
      osmId: 101,
      teeSet: 'Blue',
      coursePoint: [4, -22],
      teeToGreenCentroidYards: 422,
    },
    {
      osmId: 102,
      teeSet: 'White',
      coursePoint: [-2, 8],
      teeToGreenCentroidYards: 392,
    },
  ],
  surfaces: [],
  availability: {
    tee: 'available', fairway: 'available', rough: 'available', 'deep-rough': 'unavailable',
    green: 'available', bunker: 'unavailable', water: 'unavailable', penalty: 'unavailable',
  },
  registration: {
    status: 'verified',
    targetCoordinateSystem: 'looper-hole-local-yards',
  },
  provenance: {
    geometrySource: 'fixture-v1',
    sourceBaseTimestamp: '2026-09-22T00:00:00Z',
  },
}

const blueSelection = {
  courseId: 'greywolf-panorama-bc',
  teeSet: 'Blue',
  normalizedTeeSet: 'blue',
  selectedAt: '2026-09-22T01:00:00Z',
}

const blue = resolveShotOneTee(geometry, blueSelection)
assert.equal(blue.source, 'osm-tee-candidate')
assert.deepEqual(blue.point, [4, -22])
assert.equal(blue.candidate?.osmId, 101)

const storedCandidate = loadTeeCalibration(courseGeometryFingerprint(geometry), 1, 'BLUE')
assert.ok(storedCandidate)
assert.equal(storedCandidate.status, 'candidate')
assert.deepEqual(storedCandidate.courseLocalYds, [4, -22])

const unknown = resolveShotOneTee(geometry, {
  ...blueSelection,
  teeSet: 'Purple',
  normalizedTeeSet: 'purple',
})
assert.equal(unknown.source, 'fallback-marker')
assert.deepEqual(unknown.point, [0, 0])

const ambiguous = resolveShotOneTee({
  ...geometry,
  teeCandidates: [
    ...geometry.teeCandidates,
    { osmId: 103, color: 'Blue', coursePoint: [12, -26] },
  ],
}, blueSelection)
assert.equal(ambiguous.source, 'fallback-marker')
assert.match(ambiguous.reason, /refusing to guess/i)
assert.deepEqual(ambiguous.point, [0, 0])

const fingerprint = courseGeometryFingerprint(geometry)
const locked = lockTeeCalibration({
  courseFingerprint: fingerprint,
  holeNumber: 1,
  teeSet: 'blue',
  teeLabel: 'Blue',
  osmTeeId: 101,
  courseLocalYds: [4, -22],
  expectedYardageYds: 422,
  confidence: 0.98,
  confirmationMethod: 'fixture-confirmation',
})
assert.equal(locked.outcome, 'saved')
assert.equal(locked.record.status, 'locked')

const changedOsm = resolveShotOneTee({
  ...geometry,
  teeCandidates: [{ osmId: 999, teeSet: 'Blue', coursePoint: [30, -60] }],
}, blueSelection)
assert.equal(changedOsm.source, 'locked-calibration')
assert.deepEqual(changedOsm.point, [4, -22])
assert.equal(changedOsm.calibration?.osmTeeId, '101')

// Generic V6 route-start package: candidate points must be translated into the
// same selected-tee runtime frame used by normalizeRouteCourseGeometry.
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    holes: {
      '1': {
        coordinateFrame: { origin: 'osm-hole-route-start' },
        surfaces: {
          tee: [
            [[8, 18], [12, 18], [12, 22], [8, 22]],
          ],
        },
        teeCandidates: [
          {
            osmId: 201,
            teeSet: 'Blue',
            coursePoint: [10, 20],
            polygons: [[[8, 18], [12, 18], [12, 22], [8, 22]]],
            teeToGreenCentroidYards: 410,
          },
          {
            osmId: 202,
            teeSet: 'White',
            coursePoint: [9, 42],
            teeToGreenCentroidYards: 388,
          },
        ],
      },
    },
  }),
})

const genericCandidates = await loadCourseTeeCandidates('erin-hills-erin-wi', 1)
assert.equal(genericCandidates.length, 2)
assert.deepEqual(genericCandidates[0].coursePoint, [0, 0])
assert.deepEqual(genericCandidates[1].coursePoint, [-1, 22])

console.log('Shot 1 tee selection, lock priority, ambiguity guard, and runtime rebase: ok')
