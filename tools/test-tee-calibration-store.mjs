import assert from 'node:assert/strict'
import {
  applyTeeCalibrationWrite,
  loadTeeCalibration,
  lockTeeCalibration,
  saveTeeCalibrationCandidate,
  teeCalibrationRecordKey,
} from '../src/courseGeometry/teeCalibrationStore.ts'

const t1 = '2026-09-22T01:00:00.000Z'
const t2 = '2026-09-22T01:01:00.000Z'
const t3 = '2026-09-22T01:02:00.000Z'

const base = {
  courseFingerprint: 'Greywolf::v1',
  holeNumber: 1,
  teeSet: ' Blue ',
  teeLabel: 'Blue',
  osmTeeId: 12345,
  courseLocalYds: [12.5, 34.25],
  expectedYardageYds: 392,
  confidence: 0.72,
  confirmationMethod: 'user-tee-plus-osm',
}

const candidate = applyTeeCalibrationWrite(null, base, 'candidate', t1)
assert.equal(candidate.outcome, 'saved')
assert.equal(candidate.record.status, 'candidate')
assert.equal(candidate.record.teeSet, 'blue')
assert.equal(candidate.record.osmTeeId, '12345')
assert.equal(candidate.record.recordKey, teeCalibrationRecordKey('Greywolf::v1', 1, 'blue'))

const confirmed = applyTeeCalibrationWrite(candidate.record, base, 'confirmed', t2)
assert.equal(confirmed.outcome, 'saved')
assert.equal(confirmed.record.status, 'confirmed')
assert.equal(confirmed.record.confirmedAt, t2)

const locked = applyTeeCalibrationWrite(confirmed.record, base, 'locked', t3)
assert.equal(locked.outcome, 'saved')
assert.equal(locked.record.status, 'locked')
assert.equal(locked.record.lockedAt, t3)

const sameLocked = applyTeeCalibrationWrite(locked.record, base, 'candidate', '2026-09-22T01:03:00.000Z')
assert.equal(sameLocked.outcome, 'unchanged')
assert.deepEqual(sameLocked.record.courseLocalYds, [12.5, 34.25])

const movedLocked = applyTeeCalibrationWrite(
  locked.record,
  { ...base, courseLocalYds: [13.5, 34.25] },
  'candidate',
  '2026-09-22T01:04:00.000Z',
)
assert.equal(movedLocked.outcome, 'locked-conflict')
assert.deepEqual(movedLocked.conflictFields, ['courseLocalYds'])
assert.deepEqual(movedLocked.record.courseLocalYds, [12.5, 34.25])

const localOnlyLocked = applyTeeCalibrationWrite(null, base, 'locked', t1)
assert.equal(localOnlyLocked.outcome, 'saved')
assert.equal(localOnlyLocked.record.gsproWorld, undefined)

const learnedWorld = applyTeeCalibrationWrite(
  localOnlyLocked.record,
  { ...base, gsproWorld: { x: 100.1, y: 4.2, z: -22.75 }, confidence: 0.95 },
  'candidate',
  t2,
)
assert.equal(learnedWorld.outcome, 'saved')
assert.equal(learnedWorld.record.status, 'locked')
assert.deepEqual(learnedWorld.record.gsproWorld, { x: 100.1, y: 4.2, z: -22.75 })
assert.equal(learnedWorld.record.confidence, 0.95)

const conflictingWorld = applyTeeCalibrationWrite(
  learnedWorld.record,
  { ...base, gsproWorld: { x: 101, y: 4.2, z: -22.75 } },
  'candidate',
  t3,
)
assert.equal(conflictingWorld.outcome, 'locked-conflict')
assert.deepEqual(conflictingWorld.conflictFields, ['gsproWorld'])
assert.deepEqual(conflictingWorld.record.gsproWorld, { x: 100.1, y: 4.2, z: -22.75 })

const differentVersionKey = teeCalibrationRecordKey('Greywolf::v2', 1, 'Blue')
assert.notEqual(differentVersionKey, locked.record.recordKey)

const invalidHole = applyTeeCalibrationWrite(
  null,
  { ...base, holeNumber: 19 },
  'candidate',
  t1,
)
assert.equal(invalidHole.outcome, 'invalid')

// Exercise the browser persistence wrappers with a tiny in-memory localStorage.
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

const persisted = saveTeeCalibrationCandidate({ ...base, courseFingerprint: 'Persisted Course v1' })
assert.equal(persisted.outcome, 'saved')
const persistedLocked = lockTeeCalibration({ ...base, courseFingerprint: 'Persisted Course v1' })
assert.equal(persistedLocked.outcome, 'saved')
assert.equal(persistedLocked.record.status, 'locked')

const loaded = loadTeeCalibration('Persisted Course v1', 1, 'BLUE')
assert.ok(loaded)
assert.equal(loaded.status, 'locked')

const blocked = saveTeeCalibrationCandidate({
  ...base,
  courseFingerprint: 'Persisted Course v1',
  courseLocalYds: [20, 40],
})
assert.equal(blocked.outcome, 'locked-conflict')
const loadedAfterConflict = loadTeeCalibration('Persisted Course v1', 1, 'blue')
assert.deepEqual(loadedAfterConflict.courseLocalYds, loaded.courseLocalYds)

console.log('tee calibration locking and persistence: ok')
