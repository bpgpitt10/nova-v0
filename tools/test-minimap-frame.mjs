// The live map turns to match GSPro's minimap: ball at the bottom, pin straight up.
import assert from 'node:assert/strict'
import { minimapFrame } from '../src/liveCaddie/minimapFrame.ts'

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`)
const same = ([x, y], [ex, ey]) => { close(x, ex); close(y, ey) }

// Straight hole: nothing changes except the origin moves to the ball.
let view = minimapFrame([0, 0], [0, 400])
same(view([0, 0]), [0, 0])
same(view([10, 250]), [10, 250])

// Dogleg right: pin is up and right of the ball; it ends up straight up at the
// same distance, and a bunker right of the line stays on the right.
const ball = [0, 0]
const pin = [150, 200]
view = minimapFrame(ball, pin)
same(view(pin), [0, 250])
const rightOfLine = [150 + 8, 200 - 6] // 10 yd to the golfer's right of the pin
same(view(rightOfLine), [10, 250])
const leftOfLine = [150 - 8, 200 + 6]
same(view(leftOfLine), [-10, 250])

// Distances are preserved (pure rotation, no mirror).
const a = [30, 40]; const b = [-20, 180]
const d0 = Math.hypot(a[0] - b[0], a[1] - b[1])
const [va, vb] = [view(a), view(b)]
close(Math.hypot(va[0] - vb[0], va[1] - vb[1]), d0, 1e-9)

// Ball off the origin, pin behind (hitting back down the hole).
view = minimapFrame([20, 300], [20, 100])
same(view([20, 100]), [0, 200])
same(view([30, 300]), [-10, 0]) // +x in hole terms is the golfer's left when facing back

// Ball on the pin: falls back to the hole's forward direction.
view = minimapFrame([5, 5], [5, 5])
same(view([5, 15]), [0, 10])

console.log('minimap frame: ok')
