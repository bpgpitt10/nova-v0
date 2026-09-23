import assert from 'node:assert/strict'
import {
  captureGreywolfH1StartingPosition,
  GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT,
  gsproWorldToGreywolfH1Local,
} from '../src/courseGeometry/greywolfH1StartingPositionCalibration.ts'
import { listTeeCalibrations } from '../src/courseGeometry/teeCalibrationStore.ts'
import { parseGsproStartingPosition } from '../src/adapters/gsproStartingPosition.ts'

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

const METERS_TO_YARDS = 1.0936132983377078
const blueWorld = { x: 100, y: 12, z: 200 }
const whiteWorld = { x: 100, y: 11, z: 273.15 }

const currentShotJson = JSON.stringify({
  CurrentShot: {
    ShotID: 'pending-h1-blue',
    RoundID: 44,
    Hole: 0,
    HoleShot: 1,
    CourseKey: 'Greywolf_gsp',
    StartingPOS: blueWorld,
    StartingSurface: 18,
    DistanceToPin: 350.2 / METERS_TO_YARDS,
  },
  CompletedShots: [
    {
      ShotID: 'stale-shot',
      RoundID: 43,
      Hole: 17,
      HoleShot: 4,
      StartingPOS: { x: 1, y: 2, z: 3 },
      DistanceToPin: 10,
    },
  ],
})

const parsedBlue = parseGsproStartingPosition(currentShotJson, 18)
assert.ok(parsedBlue)
assert.equal(parsedBlue.holeNumber, 1)
assert.equal(parsedBlue.shotNumber, 1)
assert.equal(parsedBlue.courseKey, 'Greywolf_gsp')
assert.equal(parsedBlue.surface, 'tee')
assert.deepEqual(parsedBlue.world, blueWorld)
assert.ok(Math.abs(parsedBlue.distanceToPinYds - 350.2) < 0.01)

const whiteBeforeAnchor = captureGreywolfH1StartingPosition({
  teeSet: 'White',
  world: whiteWorld,
  distanceToPinYds: 268.8,
})
assert.equal(whiteBeforeAnchor.status, 'needs-anchor')
assert.equal(listTeeCalibrations(GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT).length, 0)

const blue = captureGreywolfH1StartingPosition({
  teeSet: 'Blue',
  world: parsedBlue.world,
  distanceToPinYds: parsedBlue.distanceToPinYds,
})
assert.equal(blue.status, 'anchor-locked')
assert.equal(blue.record.status, 'locked')
assert.equal(blue.record.osmTeeId, '1209190795')
assert.deepEqual(blue.record.courseLocalYds, [0, 0])
assert.deepEqual(blue.record.gsproWorld, blueWorld)

const expectedWhiteLocal = gsproWorldToGreywolfH1Local(whiteWorld, blueWorld)
assert.ok(Math.hypot(...expectedWhiteLocal) > 75)
assert.ok(Math.hypot(...expectedWhiteLocal) < 85)

const white = captureGreywolfH1StartingPosition({
  teeSet: 'White',
  world: whiteWorld,
  distanceToPinYds: 268.8,
})
assert.equal(white.status, 'candidate-saved')
assert.equal(white.record.status, 'candidate')
assert.equal(white.record.osmTeeId, undefined)
assert.deepEqual(white.record.gsproWorld, whiteWorld)
assert.deepEqual(white.record.courseLocalYds, expectedWhiteLocal)
assert.notDeepEqual(white.record.courseLocalYds, [0, 0])

const repeatedWhite = captureGreywolfH1StartingPosition({
  teeSet: ' white ',
  world: whiteWorld,
  distanceToPinYds: 268.8,
})
assert.equal(repeatedWhite.status, 'unchanged')

const calibrations = listTeeCalibrations(GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT)
assert.equal(calibrations.length, 2)
assert.deepEqual(calibrations.map((record) => record.teeSet), ['blue', 'white'])

console.log('Greywolf H1 StartingPOS tee calibration: ok')
