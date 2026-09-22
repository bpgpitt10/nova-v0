import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectRoundObject } from './diagnose-gspro-preshot.mjs'

test('explicit CurrentShot is authoritative even when history has a higher shot number', () => {
  const result = inspectRoundObject({
    Shots: [{ Hole: 0, HoleShot: 99, GlobalShotNumber: 99, StartingPOS: { x: 900, y: 0, z: 900 } }],
    CurrentShot: { Hole: 0, HoleShot: 1, StartingPOS: { x: 1, y: 2, z: 3 } },
  })
  assert.equal(result.verdict, 'EXPLICIT_CURRENT_SHOT_WITH_STARTINGPOS')
  assert.deepEqual(result.authoritativePreShotStartingPos, { x: 1, y: 2, z: 3 })
})

test('lowercase currentShot is recognized', () => {
  const result = inspectRoundObject({
    currentShot: { Hole: 4, HoleShot: 1, StartingPOS: { x: '4.5', y: 2, z: -8 } },
  })
  assert.equal(result.explicitCurrentShotKey, 'currentShot')
  assert.equal(result.explicitCurrentShot.holeNumber, 5)
  assert.deepEqual(result.authoritativePreShotStartingPos, { x: 4.5, y: 2, z: -8 })
})

test('historical StartingPOS does not become authoritative without explicit CurrentShot', () => {
  const result = inspectRoundObject({
    Shots: [{ Hole: 0, HoleShot: 1, StartingPOS: { x: 10, y: 0, z: 20 } }],
  })
  assert.equal(result.verdict, 'NO_EXPLICIT_CURRENT_SHOT')
  assert.equal(result.authoritativePreShotStartingPos, null)
  assert.equal(result.discoveredStartingPosRecordCount, 1)
})

test('explicit CurrentShot without StartingPOS is not promoted', () => {
  const result = inspectRoundObject({
    CurrentShot: { Hole: 0, HoleShot: 1, ShotID: null },
    Shots: [{ Hole: 0, HoleShot: 1, StartingPOS: { x: 10, y: 0, z: 20 } }],
  })
  assert.equal(result.verdict, 'EXPLICIT_CURRENT_SHOT_WITHOUT_STARTINGPOS')
  assert.equal(result.authoritativePreShotStartingPos, null)
})
