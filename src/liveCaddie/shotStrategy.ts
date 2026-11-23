import type { CourseGreenDetail } from '../courseGeometry/courseGreenDetail'
import { classifyPoint } from '../courseGeometry/geometry'
import type { CourseHoleGeometry, CoursePointYds } from '../courseGeometry/types'
import type { ClubAimEvaluation } from './aimOptimization'
import { buildAimShotFrame } from './aimDescriptorFrame'
import { buildCourseGreenApproachTarget } from './greenTargeting'
import { buildShotStrategyTacticalRead, type TerrainKind } from './shotStrategyTerrain'

export type ShotStrategyRead = {
  active: true
  /** Internal adjustment proxy only. Never surface this club as Looper's recommendation. */
  referenceEvaluation: ClubAimEvaluation
  target: CoursePointYds
  targetDistanceYds: number
  effectiveDistanceYds: number
  effectiveLateralChangeYds: number
  adjustmentScale: number
  aimOffsetYds: number
  aimInstruction: string
  terrain: string
  terrainKind: TerrainKind
  terrainHighSide: 'left' | 'right' | null
  terrainFall: string | null
  hazard: string | null
  safeMiss: string
  modeReason: string
  /**
   * Where the shot can land and still be on the green: from the front of the green (2 yd onto it,
   * or past sand or water on the line) to the target, in the same playing yards as
   * `effectiveDistanceYds`. `fromYds` is null when Looper's green outline can't be trusted for the
   * front edge. Null when the target isn't on Looper's green.
   */
  carryWindow: { fromYds: number | null; toYds: number; frontDoubtful: boolean; pastTrouble: 'bunker' | 'water' | null } | null
}

/** Land at least this far onto the green; and this far past sand or water on the line. */
const WINDOW_ONTO_GREEN_YDS = 2
const WINDOW_CLEAR_TROUBLE_YDS = 2.5
/** Looper's green starting closer than this to the target is probably a short outline (see chipOptions). */
const WINDOW_EDGE_DOUBT_YDS = 7

const carryWindowFor = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  target: CoursePointYds,
  targetDistanceYds: number,
  /** Playing yards per real yard on this shot. */
  playRatio: number,
): ShotStrategyRead['carryWindow'] => {
  if (!(targetDistanceYds > 1)) return null
  const dx = (target[0] - ball[0]) / targetDistanceYds
  const dy = (target[1] - ball[1]) / targetDistanceYds
  const kindAt = (carry: number) => classifyPoint(hole, [ball[0] + dx * carry, ball[1] + dy * carry]).kind
  if (kindAt(targetDistanceYds) !== 'green') return null
  // The green the target sits on: walk back from the target to where it starts.
  let greenStarts = targetDistanceYds
  for (let carry = targetDistanceYds; carry >= 0; carry -= 0.5) {
    if (kindAt(carry) !== 'green') break
    greenStarts = carry
  }
  let troubleEnds: number | null = null
  let trouble: 'bunker' | 'water' | null = null
  for (let carry = 0.5; carry < greenStarts; carry += 0.5) {
    const kind = kindAt(carry)
    if (kind === 'bunker' || kind === 'water' || kind === 'penalty') {
      troubleEnds = carry
      trouble = kind === 'bunker' ? 'bunker' : 'water'
    }
  }
  const toYds = targetDistanceYds * playRatio
  const frontDoubtful = targetDistanceYds - greenStarts < WINDOW_EDGE_DOUBT_YDS
  if (frontDoubtful) return { fromYds: null, toYds, frontDoubtful, pastTrouble: null }
  const onto = greenStarts + WINDOW_ONTO_GREEN_YDS
  const clear = troubleEnds == null ? 0 : troubleEnds + WINDOW_CLEAR_TROUBLE_YDS
  const from = Math.min(targetDistanceYds, Math.max(onto, clear))
  return { fromYds: from * playRatio, toYds, frontDoubtful, pastTrouble: troubleEnds != null && clear >= onto - 1e-9 ? trouble : null }
}

/**
 * Where the shortest club stops being a full swing (Brian, 23 Nov). A few yards
 * under its carry is still that club with a little taken off, so the normal
 * recommendation stays: within 5% of its carry, and never less than 3 yd.
 * Below that it is a partial wedge and the player picks the shot.
 * The top of the zone is each player's own shortest club, not a fixed 90 yd.
 */
export const FULL_CLUB_MARGIN_SHARE = 0.05
export const FULL_CLUB_MARGIN_MIN_YDS = 3

export const fullClubFloorYds = (shortestCarryYds: number) =>
  shortestCarryYds - Math.max(FULL_CLUB_MARGIN_MIN_YDS, shortestCarryYds * FULL_CLUB_MARGIN_SHARE)

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
  if (Math.abs(offset) < 0.5) return { offset, text: 'target line' }
  return {
    offset,
    text: `${Math.abs(offset).toFixed(Math.abs(offset) >= 10 ? 0 : 1)} yd ${offset < 0 ? 'left' : 'right'}`,
  }
}

export const buildUnderRangeShotStrategy = ({
  evaluations,
  hole,
  ball,
  target,
  pin,
  greenDetail,
  trustedPin = false,
}: {
  evaluations: ClubAimEvaluation[]
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  pin: CoursePointYds | null
  greenDetail: CourseGreenDetail | null
  /** LiDAR pin-based tactical shifting requires an exact, source-validated pin. */
  trustedPin?: boolean
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
  // Preserve the LIVE planning target when pin registration is approximate.
  // Precise green-LiDAR shaping is permitted only on an exact GSPro pin.
  const pinPoint = pin ?? target
  const greenGuidance = trustedPin && greenDetail && pin
    ? buildCourseGreenApproachTarget({
        hole,
        ball,
        pin,
        detail: greenDetail,
        exactPin: true,
      })
    : null
  const strategyTarget = greenGuidance?.target ?? target
  const targetDistanceYds = distance(ball, strategyTarget)
  if (targetDistanceYds >= fullClubFloorYds(referenceEvaluation.modeledCarryYds)) {
    return null
  }

  // We still want Looper's environmental ledger without pretending the shortest
  // calibrated club is the shot. Use its flight response only as an adjustment
  // proxy, then remove club dispersion / outcome claims from the player surface.
  const adjustmentScale = Math.max(
    0,
    Math.min(1, targetDistanceYds / Math.max(1, referenceEvaluation.stockCarryYds)),
  )
  const carryDeltaYds = (
    referenceEvaluation.modeledCarryYds - referenceEvaluation.stockCarryYds
  ) * adjustmentScale
  const effectiveDistanceYds = Math.max(0, targetDistanceYds - carryDeltaYds)
  const effectiveLateralChangeYds = (
    referenceEvaluation.modeledLateralBiasYds - referenceEvaluation.lateralBiasYds
  ) * adjustmentScale

  const tactical = buildShotStrategyTacticalRead(
    hole,
    ball,
    pinPoint,
    trustedPin ? greenDetail : null,
  )
  const aim = formatAimInstruction(ball, pinPoint, strategyTarget)

  return {
    active: true,
    referenceEvaluation,
    target: strategyTarget,
    targetDistanceYds,
    effectiveDistanceYds,
    effectiveLateralChangeYds,
    adjustmentScale,
    aimOffsetYds: aim.offset,
    aimInstruction: aim.text,
    terrain: tactical.terrain,
    terrainKind: tactical.terrainKind,
    terrainHighSide: tactical.terrainHighSide,
    terrainFall: tactical.terrainFall,
    hazard: tactical.hazard,
    safeMiss: tactical.safeMiss,
    carryWindow: carryWindowFor(hole, ball, strategyTarget, targetDistanceYds,
      targetDistanceYds > 0 ? effectiveDistanceYds / targetDistanceYds : 1),
    modeReason: `Shortest calibrated modeled shot is ${Math.round(referenceEvaluation.modeledCarryYds)} yd, beyond this ${Math.round(targetDistanceYds)} yd target.`,
  }
}
