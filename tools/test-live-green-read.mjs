// Green read + partial-shot read: player-frame directions, correct uphill-putt
// side, and a safe miss that never contradicts the terrain line.
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { greenPlayerRead, buildCourseGreenApproachTarget } = await vite.ssrLoadModule('/src/liveCaddie/greenTargeting.ts')
  const { buildShotStrategyTacticalRead } = await vite.ssrLoadModule('/src/liveCaddie/shotStrategyTerrain.ts')
  const { pinPlacementFromBall, toPlayerFrameDirection, uphillPuttSide } = await vite.ssrLoadModule('/src/liveCaddie/greenPlayerFrame.ts')

  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  const read = (overrides) => greenPlayerRead({
    ball: [0, 0], pin: [0, 150], green: rect(-12, 140, 12, 165),
    slopePercent: 3, downhillLocalUnit: [1, 0], nearEdge: false, ...overrides,
  })

  // 1. The uphill putt is on the LOW side. Falls right → leave it right.
  let text = read({})
  assert.match(text, /slopes down to the right/, text)
  assert.match(text, /Leave it right of the hole for an uphill putt/, text)
  assert.doesNotMatch(text, /left of the hole/, text)

  // Back-to-front (falls toward the player) → leave it short; front-to-back → past.
  text = read({ downhillLocalUnit: [0, -1] })
  assert.match(text, /slopes down toward you/, text)
  assert.match(text, /Leave it short of the hole/, text)
  text = read({ downhillLocalUnit: [0, 1] })
  assert.match(text, /slopes down away from you/, text)
  assert.match(text, /Leave it past the hole for an uphill putt/, text)
  text = read({ downhillLocalUnit: [-Math.SQRT1_2, Math.SQRT1_2] })
  assert.match(text, /Leave it past the hole and to the left for an uphill putt/, text)
  text = read({ downhillLocalUnit: [Math.SQRT1_2, -Math.SQRT1_2] })
  assert.match(text, /toward you and to the right/, text)
  assert.match(text, /Leave it short and right of the hole/, text)

  // Gentle slopes (<2%) describe the fall but give no putt-side instruction.
  text = read({ slopePercent: 1.5 })
  assert.match(text, /gently down to the right/, text)
  assert.doesNotMatch(text, /uphill putt/, text)

  // 2. Pin placement is measured on the real polygon from the ball.
  assert.equal(pinPlacementFromBall([0, 0], [6, 160], rect(-12, 140, 12, 165)).text, 'back right')
  assert.equal(pinPlacementFromBall([0, 0], [0, 152], rect(-12, 140, 12, 165)).text, 'in the middle')
  assert.match(read({ pin: [6, 160] }), /^Pin back right; /)

  // 3. Angled approach: ball due "east" of the green, looking along -x. The
  //    hole's +y ("back" in hole terms) is the PLAYER's right.
  const sideBall = [150, 150]
  const sidePin = [0, 150]
  const dir = toPlayerFrameDirection(sideBall, sidePin, [0, 1])
  assert.ok(dir.lateral > 0.99 && Math.abs(dir.away) < 1e-9, JSON.stringify(dir))
  assert.equal(uphillPuttSide(dir), 'right of the hole')
  text = read({ ball: sideBall, pin: [0, 160], downhillLocalUnit: [0, 1] })
  assert.match(text, /^Pin middle right; green slopes down to the right/, text)
  assert.match(text, /Leave it right of the hole/, text)
  assert.doesNotMatch(text, /short|past|back/, text)

  // 4. End to end through the LiDAR green guidance with a planar green.
  const planarDetail = (risePerRightYd, risePerForwardYd, bounds = [-30, 30, 20, 180]) => {
    const [minX, maxX, minY, maxY] = bounds
    const width = maxX - minX + 1
    const height = maxY - minY + 1
    const values = new Uint16Array(width * height)
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const x = minX + column
        const y = minY + row
        values[row * width + column] = Math.round((100 + risePerRightYd * x + risePerForwardYd * y) * 10)
      }
    }
    const percent = Math.hypot(risePerRightYd, risePerForwardYd) / 3 * 100
    const downhill = [-risePerRightYd, -risePerForwardYd].map((v) => v / (Math.hypot(risePerRightYd, risePerForwardYd) || 1))
    return {
      holeNumber: 1,
      greenBoundsYds: bounds,
      greenSampleCount: width * height,
      greenSummary: {
        sampleCount: width * height, meanElevationFt: 600, minElevationFt: 590, maxElevationFt: 610,
        elevationRangeFt: 20, planeSlopePercent: percent, downhillLocalUnit: downhill, downhillBearingDeg: 0,
      },
      sectors: [],
      grid: { minX, minY, spacingYds: 1, width, height, elevationOffsetFt: 500, nodata: 65535, values },
    }
  }
  const approachHole = {
    holeNumber: 1,
    surfaces: [{ id: 'g', kind: 'green', polygons: [rect(-12, 140, 12, 165)], provenance: { source: 'manual', confidence: 'high' } }],
  }
  const guidance = buildCourseGreenApproachTarget({
    hole: approachHole, ball: [0, 0], pin: [0, 152],
    detail: planarDetail(-0.09, 0), // falls to the right at 3%
    exactPin: true,
  })
  assert.match(guidance.playerRead, /slopes down to the right/, guidance.playerRead)
  assert.match(guidance.playerRead, /Leave it right of the hole/, guidance.playerRead)

  // 5. Partial shot: bunker short + green running away long. The old card said
  //    "Long leaves the more difficult miss" and then "Favor pin-high / slightly long".
  const partialHole = (withBunker) => ({
    holeNumber: 1,
    surfaces: [
      { id: 'g', kind: 'green', polygons: [rect(-15, 40, 15, 70)], provenance: { source: 'manual', confidence: 'high' } },
      ...(withBunker ? [{ id: 'b', kind: 'bunker', polygons: [rect(-10, 28, 10, 36)], provenance: { source: 'manual', confidence: 'high' } }] : []),
    ],
  })
  const fallingAway = planarDetail(0, -0.4, [-30, 30, 20, 80])
  const both = buildShotStrategyTacticalRead(partialHole(true), [0, 0], [0, 50], fallingAway)
  assert.match(both.terrain, /Long leaves/, both.terrain)
  assert.match(both.hazard, /Bunker guards short/, both.hazard)
  assert.doesNotMatch(both.safeMiss, /slightly long/, both.safeMiss)
  assert.match(both.safeMiss, /bunker short/, both.safeMiss)
  assert.match(both.safeMiss, /pin-high/i, both.safeMiss)

  const flat = planarDetail(0, 0, [-30, 30, 20, 80])
  const shortOnly = buildShotStrategyTacticalRead(partialHole(true), [0, 0], [0, 50], flat)
  assert.equal(shortOnly.safeMiss, 'Favor pin-high / slightly long.')
  const longOnly = buildShotStrategyTacticalRead(partialHole(false), [0, 0], [0, 50], fallingAway)
  assert.equal(longOnly.safeMiss, 'Favor pin-high / slightly short.')

  // 6. Steep side slope: player-frame words, and the safe miss names the high side.
  const sideSlope = buildShotStrategyTacticalRead(partialHole(false), [0, 0], [0, 50], planarDetail(-0.18, 0, [-30, 30, 20, 80]))
  assert.match(sideSlope.terrain, /falling to the right/, sideSlope.terrain)
  assert.equal(sideSlope.safeMiss, 'Favor the high (left) side.')
  // Same green approached from the side: the slope now falls AWAY from the player, so no left/right call.
  const sideOn = buildShotStrategyTacticalRead(partialHole(false), [-60, 50], [0, 50], planarDetail(-0.18, 0, [-30, 30, 20, 80]))
  assert.match(sideOn.terrain, /falling away from you/, sideOn.terrain)

  console.log('PASS: uphill-putt side, player-frame pin/slope words (straight and angled), LiDAR read end to end, partial-shot safe miss agrees with terrain, side-slope high side.')
} finally {
  await vite.close()
}
