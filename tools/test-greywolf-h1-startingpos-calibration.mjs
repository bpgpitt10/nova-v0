import assert from 'node:assert/strict'
import { createServer } from 'vite'

const vite = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
})

try {
  const {
    captureGreywolfH1StartingPosition,
    GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT,
    gsproWorldToGreywolfH1Local,
  } = await vite.ssrLoadModule('/src/courseGeometry/greywolfH1StartingPositionCalibration.ts')
  const { resolveGreywolfH1LiveTeePosition } = await vite.ssrLoadModule('/src/courseGeometry/greywolfH1LiveTeePosition.ts')
  const { listTeeCalibrations } = await vite.ssrLoadModule('/src/courseGeometry/teeCalibrationStore.ts')
  const { saveRoundTeeSelection } = await vite.ssrLoadModule('/src/courseGeometry/roundTeeSelection.ts')
  const { GREYWOLF_COURSE_ID } = await vite.ssrLoadModule('/src/courseGeometry/courseCatalog.ts')
  const { parseGsproStartingPosition } = await vite.ssrLoadModule('/src/adapters/gsproStartingPosition.ts')

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

  const additionalTees = [
    { teeSet: 'Black', world: { x: 99.6, y: 12.5, z: 165 }, distanceToPinYds: 390.0 },
    { teeSet: 'Gold', world: { x: 100.4, y: 10.5, z: 300 }, distanceToPinYds: 240.0 },
    { teeSet: 'Red', world: { x: 101.1, y: 9.8, z: 330 }, distanceToPinYds: 210.0 },
  ]

  for (const tee of additionalTees) {
    const result = captureGreywolfH1StartingPosition(tee)
    assert.equal(result.status, 'candidate-saved')
    assert.equal(result.record.osmTeeId, undefined)
    assert.deepEqual(result.record.gsproWorld, tee.world)
    assert.ok(Math.hypot(...result.record.courseLocalYds) > 1)
  }

  const repeatedWhite = captureGreywolfH1StartingPosition({
    teeSet: 'White',
    world: whiteWorld,
    distanceToPinYds: 268.8,
  })
  assert.equal(repeatedWhite.status, 'unchanged')

  const calibrations = listTeeCalibrations(GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT)
  assert.equal(calibrations.length, 5)
  assert.deepEqual(
    calibrations.map((record) => record.teeSet),
    ['black', 'blue', 'gold', 'red', 'white'],
  )
  assert.equal(calibrations.filter((record) => record.osmTeeId != null).length, 1)

  const red = additionalTees.find((tee) => tee.teeSet === 'Red')
  assert.ok(red)
  saveRoundTeeSelection(GREYWOLF_COURSE_ID, 'Red')
  const liveRed = resolveGreywolfH1LiveTeePosition(GREYWOLF_COURSE_ID, 1, {
    world: red.world,
    holeNumber: 1,
    shotNumber: 1,
    shotId: null,
    roundId: 45,
    courseKey: 'Greywolf_gsp',
    distanceToPinYds: red.distanceToPinYds,
    surface: 'tee',
    surfaceRaw: 18,
    recordKey: '45:1:1:red',
  })
  assert.ok(liveRed)
  assert.equal(liveRed.source, 'gspro-startingpos')
  assert.equal(liveRed.teeSet, 'Red')
  assert.deepEqual(
    liveRed.courseLocalYds,
    calibrations.find((record) => record.teeSet === 'red')?.courseLocalYds,
  )

  const cachedRed = resolveGreywolfH1LiveTeePosition(GREYWOLF_COURSE_ID, 1, null)
  assert.ok(cachedRed)
  assert.equal(cachedRed.source, 'cached-calibration')
  assert.deepEqual(cachedRed.courseLocalYds, liveRed.courseLocalYds)

  saveRoundTeeSelection(GREYWOLF_COURSE_ID, 'Unseen')
  const unseen = resolveGreywolfH1LiveTeePosition(GREYWOLF_COURSE_ID, 1, null)
  assert.ok(unseen)
  assert.equal(unseen.source, 'unresolved')
  assert.equal(unseen.courseLocalYds, null)

  console.log('Greywolf H1 StartingPOS tee calibration: five tee sets and live resolver ok')
} finally {
  await vite.close()
}
