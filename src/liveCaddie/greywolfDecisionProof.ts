import { classifyPoint } from '../courseGeometry/geometry'
import { loadGreywolfHoleGeometry } from '../courseGeometry/greywolfCourseLoader'
import type { CoursePointYds } from '../courseGeometry/types'
import type { SavedSession } from '../types'
import {
  buildDecisionPlayerModels,
  evaluateAndRankDecisionCandidates,
  type DecisionCandidate,
  type DecisionPlayerClubModel,
  type RankedDecisionCandidate,
} from './decisionEngine'

export const GREYWOLF_HOLE_08_PROOF_BALL: CoursePointYds = [-61.5, 255.7]
export const GREYWOLF_HOLE_08_GSPRO_PIN_DISTANCE_YDS = 151

const PROOF_AIM_OFFSETS_YDS = [-15, -12, -9, -6, -3, 0, 3, 6, 9, 12, 15] as const
const MIN_STOCK_SUPPORT_SHOTS = 8

const distanceYds = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(a[0] - b[0], a[1] - b[1])

const unit = (from: CoursePointYds, to: CoursePointYds): CoursePointYds => {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy)
  return length > 1e-9 ? [dx / length, dy / length] : [0, 1]
}

const rightOf = (forward: CoursePointYds): CoursePointYds => [forward[1], -forward[0]]

export const buildLateralAimCandidates = (
  ball: CoursePointYds,
  target: CoursePointYds,
  offsetsYds: readonly number[] = PROOF_AIM_OFFSETS_YDS,
): DecisionCandidate[] => {
  const forward = unit(ball, target)
  const right = rightOf(forward)

  return offsetsYds.map((offsetYds) => ({
    id: offsetYds === 0
      ? 'target-center'
      : `target-${Math.abs(offsetYds)}-${offsetYds < 0 ? 'left' : 'right'}`,
    aimOffsetYds: offsetYds,
    aimPoint: [
      target[0] + right[0] * offsetYds,
      target[1] + right[1] * offsetYds,
    ],
  }))
}

const pickNearestSupportedStockClub = (
  models: DecisionPlayerClubModel[],
  targetDistanceYds: number,
) => {
  const supported = models.filter(
    (model) =>
      model.supportShots >= MIN_STOCK_SUPPORT_SHOTS &&
      model.samples.length >= MIN_STOCK_SUPPORT_SHOTS,
  )
  const pool = supported.length > 0 ? supported : models.filter((model) => model.samples.length > 0)

  return pool.reduce<DecisionPlayerClubModel | null>((best, model) => {
    if (!best) return model
    return Math.abs(model.stockCarryYds - targetDistanceYds) <
      Math.abs(best.stockCarryYds - targetDistanceYds)
      ? model
      : best
  }, null)
}

export type GreywolfDecisionProof = {
  scenario: {
    courseId: string
    courseName: string
    holeNumber: number
    source: string
    ball: CoursePointYds
    target: CoursePointYds
    targetBasis: 'osm-green-centroid'
    targetDistanceYds: number
    gsproPinDistanceYds: number
    targetVsGsproPinDistanceDeltaYds: number
    targetSurface: string
    liveTransform: 'neutral'
  }
  player: {
    club: string
    stockCarryYds: number
    carryToTargetDeltaYds: number
    supportShots: number
    supportingSessions: number
    empiricalSamples: number
    mishitSamples: number
    severeMishitSamples: number
    unclassifiedSamples: number
  }
  recommendation: RankedDecisionCandidate | null
  candidates: RankedDecisionCandidate[]
  notes: string[]
}

/**
 * First end-to-end Looper caddie proof.
 *
 * The ball position and nominal 151-yard live pin distance are retained from
 * the September 12, 2026 Greywolf GSPro round. The canonical OSM green centroid
 * is used as the strategic target because the historical live-state artifact
 * retained pin distance but not an exact historical pin coordinate.
 *
 * This proof is intentionally Stock/100% and neutral-conditions only. It tests
 * the player x geometry decision seam before wind/elevation/lie or 90-100%
 * shot-intent search are allowed to expand the problem.
 */
export const buildGreywolfHole08DecisionProof = async (
  sessions: SavedSession[],
  nowMs = Date.now(),
): Promise<GreywolfDecisionProof> => {
  const hole = await loadGreywolfHoleGeometry(8)
  const target = hole.markers.pin
  if (!target) {
    throw new Error('Greywolf Hole 8 proof requires a canonical green target.')
  }

  const targetDistanceYds = distanceYds(GREYWOLF_HOLE_08_PROOF_BALL, target)
  const models = buildDecisionPlayerModels(sessions, nowMs)
  const player = pickNearestSupportedStockClub(models, targetDistanceYds)
  if (!player) {
    throw new Error('Greywolf Hole 8 proof could not find a usable Stock player model.')
  }

  const candidates = buildLateralAimCandidates(GREYWOLF_HOLE_08_PROOF_BALL, target)
  const ranked = evaluateAndRankDecisionCandidates(
    player,
    {
      hole,
      ball: GREYWOLF_HOLE_08_PROOF_BALL,
      target,
      goal: 'green',
    },
    candidates,
    {
      carryDeltaYds: 0,
      lateralDeltaYds: 0,
      source: 'neutral',
      notes: ['First proof intentionally excludes wind, elevation and lie transforms.'],
    },
  )

  const qualityCounts = player.samples.reduce(
    (counts, sample) => {
      counts[sample.quality] += 1
      return counts
    },
    { normal: 0, mishit: 0, severe_mishit: 0, unclassified: 0 },
  )
  const notes: string[] = []
  const distanceDelta = targetDistanceYds - GREYWOLF_HOLE_08_GSPRO_PIN_DISTANCE_YDS

  if (Math.abs(distanceDelta) > 8) {
    notes.push(
      `Canonical green-center target is ${Math.abs(distanceDelta).toFixed(1)} yd ${distanceDelta > 0 ? 'farther than' : 'closer than'} the retained GSPro pin distance; do not treat it as the exact historical pin.`,
    )
  }
  if (ranked[0]?.allShots && ranked[0].allShots.surface.unknown > 0.05) {
    notes.push('Recommended candidate still has >5% outcomes on unmapped tactical geometry.')
  }

  return {
    scenario: {
      courseId: hole.courseId,
      courseName: hole.courseName,
      holeNumber: 8,
      source: 'Greywolf GSPro round-215, 2026-09-12',
      ball: GREYWOLF_HOLE_08_PROOF_BALL,
      target,
      targetBasis: 'osm-green-centroid',
      targetDistanceYds,
      gsproPinDistanceYds: GREYWOLF_HOLE_08_GSPRO_PIN_DISTANCE_YDS,
      targetVsGsproPinDistanceDeltaYds: distanceDelta,
      targetSurface: classifyPoint(hole, target).kind,
      liveTransform: 'neutral',
    },
    player: {
      club: player.club,
      stockCarryYds: player.stockCarryYds,
      carryToTargetDeltaYds: player.stockCarryYds - targetDistanceYds,
      supportShots: player.supportShots,
      supportingSessions: player.supportingSessions,
      empiricalSamples: player.samples.length,
      mishitSamples: qualityCounts.mishit,
      severeMishitSamples: qualityCounts.severe_mishit,
      unclassifiedSamples: qualityCounts.unclassified,
    },
    recommendation: ranked[0] ?? null,
    candidates: ranked,
    notes,
  }
}
