// Yardage-book labels on the live map: reach/carry for in-play hazards, F/M/B for the green.
import assert from 'node:assert/strict'
import { greenYardage, hazardYardages } from '../src/liveCaddie/mapYardages.ts'

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

// Straight ahead (aim at 0,250): a fairway bunker right of the line from 238 to 252.
const bunkerRight = rect(6, 238, 20, 252)
const farLeft = rect(-70, 200, -55, 215) // 55+ yds left: not in play
const behind = rect(-5, -30, 5, -10) // behind the ball
const long = rect(-5, 420, 5, 440) // beyond reach
const greenside = rect(-12, 300, -2, 310)

let labels = hazardYardages({
  hazards: [{ kind: 'bunker', polygons: [bunkerRight, farLeft, behind, long, greenside] }],
  aim: [0, 250],
  corridorHalfWidthYds: 25,
  maxReachYds: 330,
})
assert.equal(labels.length, 2, JSON.stringify(labels))
assert.deepEqual([labels[0].reachYds, labels[0].carryYds, labels[0].side], [238, 252, 'right'])
assert.deepEqual([labels[1].reachYds, labels[1].carryYds, labels[1].side], [300, 310, 'center'])

// A bunker that only pokes into the corridor (no vertex inside it) is still found,
// and only the in-corridor part counts.
labels = hazardYardages({
  hazards: [{ kind: 'bunker', polygons: [[[18, 200], [80, 150], [80, 300], [18, 240]]] }],
  aim: [0, 250], corridorHalfWidthYds: 20, maxReachYds: 330,
})
assert.equal(labels.length, 1)
assert.ok(labels[0].reachYds >= 196 && labels[0].reachYds <= 201, JSON.stringify(labels[0]))
assert.ok(labels[0].carryYds >= 240 && labels[0].carryYds <= 245, JSON.stringify(labels[0]))

// Aiming right of the pin line: distances are along the aim line.
// A 10x10 pond centred on the aim line 200 yds out (at 141,141).
labels = hazardYardages({
  hazards: [{ kind: 'water', polygons: [rect(136.4, 136.4, 146.4, 146.4)] }],
  aim: [200, 200], corridorHalfWidthYds: 15, maxReachYds: 400,
})
assert.equal(labels.length, 1)
assert.equal(labels[0].kind, 'water')
assert.ok(Math.abs(labels[0].reachYds - 195) <= 3 && Math.abs(labels[0].carryYds - 205) <= 3, JSON.stringify(labels[0]))

// Ball sitting in a bunker: that bunker gets no label.
labels = hazardYardages({
  hazards: [{ kind: 'bunker', polygons: [rect(-5, -5, 5, 5)] }],
  aim: [0, 100], corridorHalfWidthYds: 10, maxReachYds: 200,
})
assert.equal(labels.length, 0)

// Limit keeps the nearest.
labels = hazardYardages({
  hazards: [{ kind: 'bunker', polygons: [10, 40, 70, 100, 130, 160].map((y) => rect(-3, y, 3, y + 8)) }],
  aim: [0, 200], corridorHalfWidthYds: 10, maxReachYds: 300, limit: 4,
})
assert.deepEqual(labels.map((l) => l.reachYds), [10, 40, 70, 100])

// Two water bodies back to back are one forced carry: reach the first, carry the last.
labels = hazardYardages({
  hazards: [{ kind: 'water', polygons: [rect(-40, 31, 30, 88), rect(-30, 86, 20, 118)] }],
  aim: [0, 126], corridorHalfWidthYds: 14, maxReachYds: 160,
})
assert.deepEqual(labels.map((l) => [l.kind, l.reachYds, l.carryYds]), [['water', 31, 118]])

// A creek that crosses at 190-200 then winds up the left side to 270: carry is the crossing.
const creek = [[-30, 190], [30, 190], [30, 200], [-10, 200], [-10, 270], [-30, 270]]
labels = hazardYardages({
  hazards: [{ kind: 'water', polygons: [creek] }],
  aim: [0, 250], corridorHalfWidthYds: 29, maxReachYds: 300,
})
assert.deepEqual(labels.map((l) => [l.reachYds, l.carryYds, l.side]), [[190, 200, 'center']])

// A creek that only touches the left edge of the corridor early but crosses the
// aim line at 250-258: the label is the crossing, on the line.
const winding = [[-29, 190], [-24, 190], [-24, 250], [10, 250], [10, 258], [-29, 258]]
labels = hazardYardages({
  hazards: [{ kind: 'water', polygons: [winding] }],
  aim: [0, 270], corridorHalfWidthYds: 29, maxReachYds: 300,
})
assert.deepEqual(labels.map((l) => [l.reachYds, l.carryYds, l.side]), [[250, 258, 'center']])
assert.ok(Math.abs(labels[0].anchor[0]) <= 6, JSON.stringify(labels[0].anchor))

// Driver from the tee: only hazards whose front edge is where the ball could come
// down get a reach number. A bunker 37 yds out and a pond you fly over at 20-60
// are left off; the landing-zone bunker and the creek at 200 stay.
labels = hazardYardages({
  hazards: [
    { kind: 'bunker', polygons: [rect(4, 37, 12, 47), rect(8, 238, 20, 252)] },
    { kind: 'water', polygons: [rect(-15, 20, 15, 60), rect(-30, 200, 30, 206)] },
  ],
  aim: [0, 250], corridorHalfWidthYds: 29, maxReachYds: 290, minReachYds: 194,
})
assert.deepEqual(labels.map((l) => [l.kind, l.reachYds]), [['water', 200], ['bunker', 238]])

// Green front / middle / back along the pin line.
assert.deepEqual(greenYardage([rect(-10, 142, 12, 160)]), { frontYds: 142, middleYds: 151, backYds: 160 })
// Ball on the green: no F/M/B.
assert.equal(greenYardage([rect(-10, -4, 10, 20)]), null)
// Pin line misses the polygon: none.
assert.equal(greenYardage([rect(20, 100, 30, 120)]), null)

console.log('map yardages: ok')
