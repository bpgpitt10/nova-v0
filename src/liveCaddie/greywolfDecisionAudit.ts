import {
  analyzeTacticalStation,
  classifyPoint,
  fairwayCorridorAtForwardY,
} from '../courseGeometry/geometry'
import { loadGreywolfHoleGeometry } from '../courseGeometry/greywolfCourseLoader'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import type { SavedSession } from '../types'
import { evaluateAimLab } from './aimOptimization'
import {
  buildNaturalLandingClubComparisons,
  type NaturalLandingClubComparison,
} from './naturalLandingDiagnostics'

export type GreywolfDecisionAuditScenarioKind = 'tee-strategy' | 'approach-150'
export type GreywolfDecisionAuditStatus = 'clear' | 'review' | 'missing'

export type GreywolfDecisionAuditScenario = {
  id: string
  holeNumber: number
  par: number | null
  kind: GreywolfDecisionAuditScenarioKind
  label: string
  ball: CoursePointYds
  target: CoursePointYds
  targetDistanceYds: number
  ballSurface: CourseSurfaceClassification
  targetSurface: CourseSurfaceClassification
  tactical: {
    fairwayWidthYds: number | null
    nearestTroubleYds: number | null
    nearestPenaltyYds: number | null
    safeSide: 'left' | 'center' | 'right' | 'unknown'
  } | null
  /**
   * Side-by-side natural tee-club distributions. These are deliberately not
   * ranked against each other until a strokes-gained/value layer exists.
   */
  naturalClubComparisons: NaturalLandingClubComparison[]
  recommendation: {
    club: string
    modeledCarryYds: number
    carryGapYds: number
    supportShots: number
    aimOffsetYds: number
    targetFit: boolean | null
    withinCatastropheGuardrail: boolean | null
    success: number | null
    manageable: number | null
    seriousTrouble: number | null
    catastrophe: number | null
    unknown: number | null
    tailProbability: number | null
    clubDecisionReason: string | null
    aimDecisionReason: string | null
  } | null
  status: GreywolfDecisionAuditStatus
  reviewReasons: string[]
}

export type GreywolfDecisionAudit = {
  scenarios: GreywolfDecisionAuditScenario[]
  summary: {
    holesCovered: number
    scenarioCount: number
    clearCount: number
    reviewCount: number
    missingCount: number
    boundaryAimCount: number
    elevatedCatastropheCount: number
    highUnknownCount: number
    thinSupportCount: number
    naturalClubComparisonCount: number
  }
}

const pointDistance = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(b[0] - a[0], b[1] - a[1])

const interpolatedReferenceRight = (
  hole: CourseHoleGeometry,
  forwardYds: number,
) => {
  const tee = hole.markers.tee
  const pin = hole.markers.pin
  if (!pin || Math.abs(pin[1] - tee[1]) < 1e-9) return tee[0]
  const t = Math.max(0, Math.min(1, (forwardYds - tee[1]) / (pin[1] - tee[1])))
  return tee[0] + (pin[0] - tee[0]) * t
}

const fairwayPoints = (hole: CourseHoleGeometry) => {
  const start = Math.ceil(Math.max(hole.bounds.minY, hole.markers.tee[1] + 10) / 5) * 5
  const end = Math.floor(hole.bounds.maxY / 5) * 5
  const points: CoursePointYds[] = []

  for (let forward = start; forward <= end; forward += 5) {
    const corridor = fairwayCorridorAtForwardY(
      hole,
      forward,
      interpolatedReferenceRight(hole, forward),
    )
    if (!corridor) continue
    points.push([corridor.centerRightYds, forward])
  }

  return points
}

const nearestFairwayPointByDistance = (
  hole: CourseHoleGeometry,
  reference: CoursePointYds,
  desiredDistanceYds: number,
  predicate: (point: CoursePointYds) => boolean = () => true,
) => {
  const candidates = fairwayPoints(hole).filter(predicate)
  if (candidates.length === 0) return null
  return candidates.sort(
    (a, b) =>
      Math.abs(pointDistance(reference, a) - desiredDistanceYds) -
      Math.abs(pointDistance(reference, b) - desiredDistanceYds),
  )[0]
}

const buildScenarioInputs = (hole: CourseHoleGeometry) => {
  const pin = hole.markers.pin
  if (!pin) return []

  const tee = hole.markers.tee
  const teeToPin = pointDistance(tee, pin)
  const scenarios: Array<{
    kind: GreywolfDecisionAuditScenarioKind
    label: string
    ball: CoursePointYds
    target: CoursePointYds
  }> = []

  if (hole.par === 3 || teeToPin <= 260) {
    scenarios.push({
      kind: 'tee-strategy',
      label: 'Tee → green',
      ball: tee,
      target: pin,
    })
  } else {
    const landing = nearestFairwayPointByDistance(
      hole,
      tee,
      220,
      (point) => pointDistance(point, pin) >= 55,
    )
    if (landing) {
      scenarios.push({
        kind: 'tee-strategy',
        label: 'Tee → ~220 yd fairway landing zone',
        ball: tee,
        target: landing,
      })
    }
  }

  if (hole.par !== 3 && teeToPin > 220) {
    const approachBall = nearestFairwayPointByDistance(
      hole,
      pin,
      150,
      (point) => pointDistance(tee, point) >= 45,
    )
    if (approachBall) {
      const approachDistance = pointDistance(approachBall, pin)
      if (approachDistance >= 90 && approachDistance <= 210) {
        scenarios.push({
          kind: 'approach-150',
          label: `Fairway → green (~${Math.round(approachDistance)} yd)`,
          ball: approachBall,
          target: pin,
        })
      }
    }
  }

  return scenarios
}

const auditScenario = (
  sessions: SavedSession[],
  hole: CourseHoleGeometry,
  input: ReturnType<typeof buildScenarioInputs>[number],
  nowMs: number,
): GreywolfDecisionAuditScenario => {
  const targetDistanceYds = pointDistance(input.ball, input.target)
  const evaluations = evaluateAimLab(sessions, hole, input.ball, input.target, nowMs)
  const selected = evaluations[0] ?? null
  const best = selected?.bestCandidate ?? null
  const risk = best?.riskProfile ?? null
  const ballSurface = classifyPoint(hole, input.ball).kind
  const targetSurface = classifyPoint(hole, input.target).kind
  const station = input.kind === 'tee-strategy' && targetSurface === 'fairway'
    ? analyzeTacticalStation(hole, input.target[1], input.target[0])
    : null
  const naturalClubComparisons = input.kind === 'tee-strategy' && targetSurface === 'fairway'
    ? buildNaturalLandingClubComparisons(sessions, hole, input.ball, nowMs)
    : []
  const reviewReasons: string[] = []

  if (!selected || !best) {
    reviewReasons.push('No usable club + aim recommendation.')
  } else {
    if (selected.targetFit === false) {
      reviewReasons.push('Selected club is outside the target-fit carry guardrail.')
    }
    if (Math.abs(selected.carryGapYds) > 15) {
      reviewReasons.push(`Selected carry gap is ${selected.carryGapYds.toFixed(1)} yd.`)
    }
    if (Math.abs(best.aimOffsetYds) >= selected.aimSearchHalfWidthYds - 0.1) {
      reviewReasons.push(`Best aim hits the ±${selected.aimSearchHalfWidthYds.toFixed(0)} yd search boundary.`)
    }
    if ((risk?.catastrophe ?? 0) > 0.08) {
      reviewReasons.push(`Catastrophe probability is ${((risk?.catastrophe ?? 0) * 100).toFixed(1)}%.`)
    }
    if ((risk?.unknown ?? 0) > 0.08) {
      reviewReasons.push(`Unknown-geometry probability is ${((risk?.unknown ?? 0) * 100).toFixed(1)}%.`)
    }
    if (selected.supportShots < 5) {
      reviewReasons.push(`Selected club has thin Stock support (${selected.supportShots} shots).`)
    }
  }

  if (targetSurface === 'unknown') {
    reviewReasons.push('Strategic target lands on unmapped geometry.')
  }
  if (input.kind === 'approach-150' && ballSurface !== 'fairway') {
    reviewReasons.push(`Synthetic approach origin classified as ${ballSurface}, not fairway.`)
  }

  const status: GreywolfDecisionAuditStatus = !selected || !best
    ? 'missing'
    : reviewReasons.length > 0
      ? 'review'
      : 'clear'

  return {
    id: `greywolf-h${hole.holeNumber}-${input.kind}`,
    holeNumber: hole.holeNumber,
    par: hole.par ?? null,
    kind: input.kind,
    label: input.label,
    ball: input.ball,
    target: input.target,
    targetDistanceYds,
    ballSurface,
    targetSurface,
    tactical: station ? {
      fairwayWidthYds: station.fairwayCorridor?.widthYds ?? null,
      nearestTroubleYds: station.nearestTroubleYds,
      nearestPenaltyYds: station.nearestPenaltyYds,
      safeSide: station.safeSide,
    } : null,
    naturalClubComparisons,
    recommendation: selected && best ? {
      club: selected.club,
      modeledCarryYds: selected.modeledCarryYds,
      carryGapYds: selected.carryGapYds,
      supportShots: selected.supportShots,
      aimOffsetYds: best.aimOffsetYds,
      targetFit: selected.targetFit,
      withinCatastropheGuardrail: selected.withinCatastropheGuardrail,
      success: risk?.success ?? null,
      manageable: risk?.manageable ?? null,
      seriousTrouble: risk?.seriousTrouble ?? null,
      catastrophe: risk?.catastrophe ?? null,
      unknown: risk?.unknown ?? null,
      tailProbability: risk?.tailProbability ?? null,
      clubDecisionReason: selected.decisionReason,
      aimDecisionReason: best.decisionReason,
    } : null,
    status,
    reviewReasons,
  }
}

/**
 * Course-wide neutral-condition audit. This remains a broad behavior sweep,
 * not a claim that these synthetic positions reconstruct a played round.
 * The legacy ~220 yd tee target is retained only as a regression baseline.
 * Long-hole tee scenarios additionally persist non-authoritative club-specific
 * natural landing comparisons for the future strokes-gained evaluator.
 */
export const buildGreywolfCourseDecisionAudit = async (
  sessions: SavedSession[],
  nowMs = Date.now(),
): Promise<GreywolfDecisionAudit> => {
  const scenarios: GreywolfDecisionAuditScenario[] = []

  for (let holeNumber = 1; holeNumber <= 18; holeNumber += 1) {
    const hole = await loadGreywolfHoleGeometry(holeNumber)
    for (const input of buildScenarioInputs(hole)) {
      scenarios.push(auditScenario(sessions, hole, input, nowMs))
    }
  }

  const holesCovered = new Set(scenarios.map((scenario) => scenario.holeNumber)).size
  return {
    scenarios,
    summary: {
      holesCovered,
      scenarioCount: scenarios.length,
      clearCount: scenarios.filter((scenario) => scenario.status === 'clear').length,
      reviewCount: scenarios.filter((scenario) => scenario.status === 'review').length,
      missingCount: scenarios.filter((scenario) => scenario.status === 'missing').length,
      boundaryAimCount: scenarios.filter((scenario) => {
        const recommendation = scenario.recommendation
        if (!recommendation) return false
        const evaluation = scenario.kind === 'tee-strategy'
          ? scenario.naturalClubComparisons.find((item) => item.club === recommendation.club)
          : null
        const halfWidth = evaluation?.aimSearchHalfWidthYds ?? 15
        return Math.abs(recommendation.aimOffsetYds) >= halfWidth - 0.1
      }).length,
      elevatedCatastropheCount: scenarios.filter((scenario) =>
        (scenario.recommendation?.catastrophe ?? 0) > 0.08,
      ).length,
      highUnknownCount: scenarios.filter((scenario) =>
        (scenario.recommendation?.unknown ?? 0) > 0.08,
      ).length,
      thinSupportCount: scenarios.filter((scenario) =>
        (scenario.recommendation?.supportShots ?? Number.POSITIVE_INFINITY) < 5,
      ).length,
      naturalClubComparisonCount: scenarios.reduce(
        (sum, scenario) => sum + scenario.naturalClubComparisons.length,
        0,
      ),
    },
  }
}
