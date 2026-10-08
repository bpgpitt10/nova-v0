import assert from 'node:assert/strict'
import { buildTacticalMapBounds } from '../src/liveCaddie/mapFraming.ts'

const hole = {
  surfaces: [
    {
      kind: 'tee',
      polygons: [[[-4, -5], [4, -5], [4, 5], [-4, 5]]],
    },
    {
      kind: 'fairway',
      polygons: [[[-25, 0], [20, 0], [70, 300], [40, 500], [-25, 500]]],
    },
    {
      kind: 'green',
      polygons: [[[-16, 591], [16, 591], [16, 624], [-16, 624]]],
    },
    {
      kind: 'water',
      polygons: [[[55, 380], [95, 380], [95, 450], [55, 450]]],
    },
  ],
}

const candidate = {
  aimPoint: [0, 245],
  meanLanding: [-10, 262],
  probabilityContours: [
    { carryRadiusYds: 35, lateralRadiusYds: 25 },
  ],
}

const tee = buildTacticalMapBounds(hole, [0, 0], [0, 220], [0, 607], candidate)
assert.equal(tee.minY, -20)
assert.ok(tee.maxY >= 648, `tee view should show the full green + buffer, got ${tee.maxY}`)
assert.ok(tee.maxY < 700, `tee view should not include excessive dead ground, got ${tee.maxY}`)
assert.ok(tee.minX <= -16 && tee.maxX >= 95, 'tee view should contain the playable corridor and strategic water')

const second = buildTacticalMapBounds(hole, [12, 260], [20, 470], [0, 607], candidate)
assert.equal(second.minY, 240)
assert.ok(second.maxY >= 648, 'shot 2 must retain the complete green plus destination buffer')
assert.ok(second.minY > tee.minY, 'shot 2 should discard ground already passed')

const approach = buildTacticalMapBounds(hole, [5, 520], [0, 607], [0, 607], null)
assert.equal(approach.minY, 500)
assert.ok(approach.maxY >= 648)
assert.ok(approach.maxY - approach.minY < second.maxY - second.minY, 'viewport should progressively tighten near the green')

console.log('progressive Live Caddie map framing: ok')
