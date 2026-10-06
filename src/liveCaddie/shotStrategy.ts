import type { CourseGreenDetail } from '../courseGeometry/courseGreenDetail'
import type { CourseHoleGeometry, CoursePointYds } from '../courseGeometry/types'
import type { ClubAimEvaluation } from './aimOptimization'
import { buildAimShotFrame } from './aimDescriptorFrame'
import { buildCourseGreenApproachTarget } from './greenTargeting'
import { buildShotStrategyTacticalRead } from './shotStrategyTerrain'

export type ShotStrategyRead = {
  active: true
  /** Internal adjustment proxy only. Never surface this club as Looper's recommendation. */
  referenceEvaluation: ClubAimEvaluation
  target: CoursePointYds
  targetDistanceYds: number
  effectiveDistanceYds: number
  effectiveLateralChangeYds: number
  aimOffsetYds: number
  aimInstruction: string
  terrain: string
  hazard: string | null
  safeMiss: string
  modeReason: string
}

const UNDER_RANGE_EPSILON_YDS = 0.5

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const distance = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(a[0] - b[0], a[1] - b[1])

const formatAimInstruction = (
  ball: CoursePointYds,
  pin: CoursePointYds,
  target: CoursePointYds,
) => {
  const frame = buildAimShotFrame(ball, pin)
  const pinFrame = frame(pin)
  const targetFrame = frame(target)
  const offset = targetFrame.lateral - pinFrame.lateral
  if (Math.abs(offset) < 0.5) return { offset, text: 'AIM · target line' }
  return {
    offset,
    text: `AIM · ${Math.abs(offset).toFixed(Math.abs(offset) >= 10 ? 0 : 1)} yd ${offset < 0 ? 'left' : 'right'}`,
  }
}

export const buildUnderRangeShotStrategy = ({
  evaluations,
  hole,
  ball,
  target,
  pin,
  greenDetail,
}: {
  evaluations: ClubAimEvaluation[]
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  pin: CoursePointYds | null
  greenDetail: CourseGreenDetail | null
}): ShotStrategyRead | null => {
  const supported = evaluations.filter((evaluation) =>
    finite(evaluation.stockCarryYds)
    && finite(evaluation.modeledCarryYds)
    && evaluation.stockCarryYds > 0
    && evaluation.modeledCarryYds > 0
    && evaluation.supportShots > 0,
  )
  if (supported.length === 0) return null

  const referenceEvaluation = [...supported].sort(
    (left, right) => left.modeledCarryYds - right.modeledCarryYds,
  )[0]
  const targetDistanceYds = distance(ball, target)
  if (targetDistanceYds >= referenceEvaluation.modeledCarryYds - UNDER_RANGE_EPSILON_YDS) {
    return null
  }

  // We still want Looper's environmental ledger without pretending the shortest
  // calibrated club is the shot. Use its flight response only as an adjustment
  // proxy, then remove club dispersion / outcome claims from the player surface.
  const carryDeltaYds = referenceEvaluation.modeledCarryYds - referenceEvaluation.stockCarryYds
  const effectiveDistanceYds = Math.max(0, targetDistanceYds - carryDeltaYds)
  const effectiveLateralChangeYds =
    referenceEvaluation.modeledLateralBiasYds - referenceEvaluation.lateralBiasYds

  const pinPoint = pin ?? target
  const greenGuidance = greenDetail
    ? buildCourseGreenApproachTarget({
        hole,
        ball,
        pin: pinPoint,
        detail: greenDetail,
        exactPin: true,
      })
    : null
  const strategyTarget = greenGuidance?.target ?? pinPoint
  const tactical = buildShotStrategyTacticalRead(
    hole,
    ball,
    pinPoint,
    greenDetail,
  )
  const aim = formatAimInstruction(ball, pinPoint, strategyTarget)

  return {
    active: true,
    referenceEvaluation,
    target: strategyTarget,
    targetDistanceYds,
    effectiveDistanceYds,
    effectiveLateralChangeYds,
    aimOffsetYds: aim.offset,
    aimInstruction: aim.text,
    terrain: tactical.terrain,
    hazard: tactical.hazard,
    safeMiss: tactical.safeMiss,
    modeReason: `Shortest calibrated modeled shot is ${Math.round(referenceEvaluation.modeledCarryYds)} yd, beyond this ${Math.round(targetDistanceYds)} yd target.`,
  }
}
