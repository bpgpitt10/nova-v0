import { greywolfHole01RenderFixture as source } from '../dev/greywolfHole01RenderFixture'
import {
  analyzeTacticalStation,
  classifyPoint,
  sampleLandingEllipse,
  validateCourseGeometry,
} from './geometry'
import { greywolfHole01Geometry as hole } from './greywolfHole01'
import type { CoursePointYds } from './types'

const stationDistancesYds = [150, 200, 250] as const

export const greywolfHole01Regression = {
  geometryValidation: validateCourseGeometry(hole),
  shotSurfaceChecks: source.markers.shots.map((shot) => {
    const point: CoursePointYds = [shot.x, shot.y]
    const actual = classifyPoint(hole, point)
    return {
      label: shot.label,
      point,
      expected: shot.surface,
      actual: actual.kind,
      confidence: actual.confidence,
      pass: actual.kind === shot.surface,
    }
  }),
  stations: stationDistancesYds.map((forwardYds) => {
    const station = analyzeTacticalStation(hole, forwardYds)
    const centerRightYds = station.fairwayCorridor?.centerRightYds ?? 0
    const landingCoverage = sampleLandingEllipse(
      hole,
      [centerRightYds, forwardYds],
      15,
      15,
      2,
    )
    return { ...station, landingCoverage }
  }),
} as const

export const greywolfHole01RegressionPasses =
  greywolfHole01Regression.geometryValidation.ok &&
  greywolfHole01Regression.shotSurfaceChecks.every((check) => check.pass)
