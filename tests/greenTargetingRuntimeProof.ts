import {
  buildCourseGreenApproachTarget,
  redirectCourseGreenRollout,
  sampleCourseGreenSlopeAtPoint,
} from '../src/liveCaddie/greenTargeting'

const expect = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}

const near = (actual: number | null | undefined, expected: number, tolerance: number, label: string) => {
  expect(typeof actual === 'number' && Number.isFinite(actual), `${label}: expected finite number, got ${actual}`)
  expect(Math.abs((actual as number) - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`)
}

const polygon: [number, number][] = [
  [-5, -5],
  [5, -5],
  [5, 5],
  [-5, 5],
]

const hole: any = {
  surfaces: [
    {
      id: 'test-green',
      kind: 'green',
      polygons: [polygon],
      provenance: { confidence: 'high' },
    },
  ],
}

const makeDetail = (
  elevationAt: (rightYds: number, forwardYds: number) => number,
  summarySlopePercent = 2,
  summaryDownhill: readonly [number, number] = [0, 1],
): any => {
  const minX = -6
  const minY = -6
  const width = 13
  const height = 13
  const spacingYds = 1
  const elevationOffsetFt = 70
  const values = new Uint16Array(width * height)
  for (let row = 0; row < height; row += 1) {
    const y = minY + row * spacingYds
    for (let column = 0; column < width; column += 1) {
      const x = minX + column * spacingYds
      const elevationFt = elevationAt(x, y)
      values[row * width + column] = Math.round((elevationFt - elevationOffsetFt) * 10)
    }
  }
  return {
    holeNumber: 1,
    greenBoundsYds: [-5, 5, -5, 5],
    greenSampleCount: 121,
    greenSummary: {
      sampleCount: 121,
      meanElevationFt: 100,
      minElevationFt: 90,
      maxElevationFt: 110,
      elevationRangeFt: 20,
      planeSlopePercent: summarySlopePercent,
      downhillLocalUnit: summaryDownhill,
      downhillBearingDeg: 0,
    },
    sectors: [
      {
        id: 'middle-center',
        row: 'middle',
        column: 'center',
        boundsYds: [-5, 5, -5, 5],
        sampleCount: 121,
      },
    ],
    grid: {
      minX,
      minY,
      spacingYds,
      width,
      height,
      elevationOffsetFt,
      nodata: 65535,
      values,
    },
  }
}

// A coherent 48% bank is intentionally valid. There is no maximum-slope cap.
const steepDetail = makeDetail((x) => 100 + 1.44 * x)
const steepSlope = sampleCourseGreenSlopeAtPoint(steepDetail, [0, 0], polygon)
expect(steepSlope != null, 'coherent steep bank should produce a local slope')
near(steepSlope?.slopePercent, 48, 0.8, 'coherent steep bank slope')
expect((steepSlope?.downhill[0] ?? 0) < -0.95, 'coherent steep bank should fall left')

// A sharp tier crossing is not a trustworthy single plane. It must fall back to
// the whole-green summary rather than masquerading as an extreme local slope.
const tierDetail = makeDetail((x) => 100 + (x >= 0 ? 4 : 0), 2, [0, 1])
const tierSlope = sampleCourseGreenSlopeAtPoint(tierDetail, [0, 0], polygon)
expect(tierSlope != null, 'tier crossing should fall back to summary slope')
near(tierSlope?.slopePercent, 2, 0.01, 'tier fallback slope')
near(tierSlope?.downhill[0], 0, 0.01, 'tier fallback downhill right')
near(tierSlope?.downhill[1], 1, 0.01, 'tier fallback downhill forward')

// Exact-pin approach guidance may respond to the coherent steep bank, but the
// strategic move remains conservative and bounded.
const steepGuidance = buildCourseGreenApproachTarget({
  hole,
  ball: [0, -100],
  pin: [0, 0],
  detail: steepDetail,
  exactPin: true,
})
expect(steepGuidance.applied, 'coherent steep bank should be allowed to influence the target')
expect(steepGuidance.shiftYds <= 5 + 1e-9, `target shift exceeded 5 yd cap: ${steepGuidance.shiftYds}`)
expect(
  steepGuidance.target[0] >= -5 && steepGuidance.target[0] <= 5
    && steepGuidance.target[1] >= -5 && steepGuidance.target[1] <= 5,
  `shifted target left the green: ${JSON.stringify(steepGuidance.target)}`,
)

// Without an exact GSPro pin, terrain context may be reported but must not move
// the strategic target.
const inexactGuidance = buildCourseGreenApproachTarget({
  hole,
  ball: [0, -100],
  pin: [0, 0],
  detail: steepDetail,
  exactPin: false,
})
expect(!inexactGuidance.applied, 'inexact pin must not receive strategic target shift')
near(inexactGuidance.shiftYds, 0, 0.001, 'inexact pin shift')

// Near an edge, combined slope + inward pressure must still stay on-green and
// respect the same <=5 yd total-shift contract.
const edgeGuidance = buildCourseGreenApproachTarget({
  hole,
  ball: [0, -100],
  pin: [4.5, 0],
  detail: steepDetail,
  exactPin: true,
})
expect(edgeGuidance.shiftYds <= 5 + 1e-9, `edge target shift exceeded 5 yd cap: ${edgeGuidance.shiftYds}`)
expect(
  edgeGuidance.target[0] >= -5 && edgeGuidance.target[0] <= 5
    && edgeGuidance.target[1] >= -5 && edgeGuidance.target[1] <= 5,
  `edge-adjusted target left the green: ${JSON.stringify(edgeGuidance.target)}`,
)

// Rollout redirection preserves the player's observed rollout distance. Terrain
// changes direction only; it does not invent extra run.
const carry: [number, number] = [0, 0]
const baseline: [number, number] = [0, 5]
const redirected = redirectCourseGreenRollout({
  hole,
  detail: steepDetail,
  carryLanding: carry,
  baselineLanding: baseline,
})
expect(redirected.applied, 'coherent steep bank should redirect rollout')
const baselineDistance = Math.hypot(baseline[0] - carry[0], baseline[1] - carry[1])
const redirectedDistance = Math.hypot(
  redirected.landing[0] - carry[0],
  redirected.landing[1] - carry[1],
)
near(redirectedDistance, baselineDistance, 0.001, 'redirected rollout distance')

console.log(JSON.stringify({
  coherentSteepBankSlopePercent: steepSlope?.slopePercent,
  tierFallbackSlopePercent: tierSlope?.slopePercent,
  steepTargetShiftYds: steepGuidance.shiftYds,
  edgeTargetShiftYds: edgeGuidance.shiftYds,
  rolloutDistanceYds: redirectedDistance,
  result: 'PASS',
}, null, 2))
