import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGsproStartingPosition } from '../src/adapters/gsproStartingPosition.ts'

test('explicit CurrentShot wins over a higher-numbered historical shot', () => {
  const result = parseGsproStartingPosition(JSON.stringify({
    Shots: [
      {
        Hole: 0,
        HoleShot: 99,
        GlobalShotNumber: 99,
        StartingPOS: { x: 900, y: 0, z: 900 },
      },
    ],
    CurrentShot: {
      Hole: 0,
      HoleShot: 1,
      StartingPOS: { x: 1, y: 2, z: 3 },
    },
  }))

  assert.ok(result)
  assert.equal(result.holeNumber, 1)
  assert.deepEqual(result.world, { x: 1, y: 2, z: 3 })
})

test('stale expected-hole evidence must not veto an explicit CurrentShot', () => {
  const result = parseGsproStartingPosition(JSON.stringify({
    Shots: [
      {
        Hole: 17,
        HoleShot: 72,
        GlobalShotNumber: 72,
        ShotID: 'old-round-last-shot',
        StartingPOS: { x: 1800, y: 0, z: 1800 },
      },
    ],
    CurrentShot: {
      Hole: 0,
      HoleShot: 1,
      RoundID: 501,
      CourseKey: 'greywolf_gsp',
      StartingPOS: { x: 10, y: 20, z: 30 },
      StartingSurface: 18,
      DistanceToPin: 400,
    },
  }), 18)

  assert.ok(result, 'explicit CurrentShot should survive a stale expected-hole hint')
  assert.equal(result.holeNumber, 1)
  assert.deepEqual(result.world, { x: 10, y: 20, z: 30 })
})

test('expected hole still constrains historical fallback when CurrentShot is absent', () => {
  const result = parseGsproStartingPosition(JSON.stringify({
    Shots: [
      { Hole: 0, HoleShot: 1, GlobalShotNumber: 1, StartingPOS: { x: 1, y: 0, z: 1 } },
      { Hole: 1, HoleShot: 2, GlobalShotNumber: 2, StartingPOS: { x: 2, y: 0, z: 2 } },
    ],
  }), 1)

  assert.ok(result)
  assert.equal(result.holeNumber, 1)
  assert.deepEqual(result.world, { x: 1, y: 0, z: 1 })
})

test('returns null when no record contains a complete StartingPOS', () => {
  const result = parseGsproStartingPosition(JSON.stringify({
    CurrentShot: { Hole: 0, StartingPOS: { x: 1, y: 2 } },
    Shots: [{ Hole: 0, HoleShot: 1 }],
  }))

  assert.equal(result, null)
})
