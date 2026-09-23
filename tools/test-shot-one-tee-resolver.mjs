import assert from 'node:assert/strict'
import {
  courseGeometryFingerprint,
  resolveShotOneTee,
} from '../src/courseGeometry/shotOneTeeResolver.ts'
import {
  loadTeeCalibration,
  lockTeeCalibration,
} from '../src/courseGeometry/teeCalibrationStore.ts'

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

const whiteSelection = {
  ...blueSelection,
  teeSet: 'White',
  normalizedTeeSet: 'white',
}
const whiteGkdOnly = resolveShotOneTee({
  ...geometry,
  teeCandidates: [
    geometry.teeCandidates[0],
    {
      source: 'gspro-gkd',
      teeSet: 'White',
      coursePoint: [38.328, 75.193],
      gsproWorld: { x: 929.0867, y: 50.2128, z: 1110.63635 },
    },
  ],
}, whiteSelection)
assert.equal(whiteGkdOnly.source, 'gspro-gkd')
assert.deepEqual(whiteGkdOnly.point, [38.328, 75.193])
assert.equal(whiteGkdOnly.candidate?.osmId, undefined)
assert.deepEqual(whiteGkdOnly.candidate?.gsproWorld, { x: 929.0867, y: 50.2128, z: 1110.63635 })

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

const authoritativeGkd = resolveShotOneTee({
  ...geometry,
  teeCandidates: [{
    source: 'gspro-gkd',
    teeSet: 'Blue',
    coursePoint: [-3.099, -1.404],
    gsproWorld: { x: 981.0245, y: 46.8084259, z: 1170.985 },
    osmId: 1209190795,
  }],
}, blueSelection)
assert.equal(authoritativeGkd.source, 'gspro-gkd')
assert.deepEqual(authoritativeGkd.point, [-3.099, -1.404])
assert.match(authoritativeGkd.reason, /authoritative GSPro \.GKD/i)

console.log('Shot 1 GKD authority, OSM fallback, lock fallback, and ambiguity guard: ok')
