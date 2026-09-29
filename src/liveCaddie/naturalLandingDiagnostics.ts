import { fairwayCorridorAtForwardY } from '../courseGeometry/geometry'
import type { CourseHoleGeometry, CoursePointYds } from '../courseGeometry/types'
import type { SavedSession } from '../types'
import { evaluateAimLab } from './aimOptimization'
import { buildLiveCaddieProfileSet } from './profileProvider'

export type NaturalLandingClubComparison = {
  club: string
  supportShots: number
  stockCarryYds: number
  modeledCarryYds: number
  planningTarget: CoursePointYds
  planningTargetDistanceYds: number
  carryGapYds: number
  aimSearchHalfWidthYds: number
  bestAimOffsetYds: number | null
  meanLanding: CoursePointYds | null
  success: number | null
  manageable: number | null
  seriousTrouble: number | null
  catastrophe: number | null
  unknown: number | null
  meanRawDistanceToPinYds: number | null
  penaltySampleProbability: number | null
  /** Club-to-club value remains intentionally unresolved until SG is added. */
  clubValueStatus: 'pending-strokes-gained'
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

const fairwayCenters = (hole: CourseHoleGeometry) => {
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

const naturalFairwayTarget = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  carryYds: number,
) => {
  const pin = hole.markers.pin
  const candidates = fairwayCenters(hole).filter((point) =>
    pointDistance(ball, point) >= 80 &&
    (!pin || pointDistance(point, pin) >= 45),
  )
  if (candidates.length === 0) return null
  return candidates.reduce((best, point) =>
    Math.abs(pointDistance(ball, point) - carryYds) < Math.abs(pointDistance(ball, best) - carryYds)
      ? point
      : best,
  )
}

const average = (values: number[]) =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null

/**
 * Compare tee clubs at their own natural landing corridors without assigning a
 * club-to-club winner. The eventual strokes-gained layer should consume these
 * exact landing states and decide whether extra distance is worth wider risk.
 */
export const buildNaturalLandingClubComparisons = (
  sessions: SavedSession[],
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  nowMs = Date.now(),
): NaturalLandingClubComparison[] => {
  const profileSet = buildLiveCaddieProfileSet(sessions, nowMs)
  const clubTargets: Record<string, CoursePointYds> = {}

  profileSet.clubs.forEach((profile) => {
    // Keep this diagnostic focused on genuine tee-strategy clubs. This is not
    // a strategy cutoff; shorter clubs will become relevant through SG/layup
    // logic when a hole actually rewards them.
    if (profile.stock_carry_yds < 170) return
    const target = naturalFairwayTarget(hole, ball, profile.stock_carry_yds)
    if (target) clubTargets[profile.club] = target
  })

  const entries = Object.entries(clubTargets)
  if (entries.length === 0) return []
  const fallbackTarget = entries[0][1]
  const evaluations = evaluateAimLab(
    sessions,
    hole,
    ball,
    fallbackTarget,
    { clubTargets },
    nowMs,
  )

  return evaluations
    .filter((evaluation) => clubTargets[evaluation.club] != null)
    .sort((a, b) => b.modeledCarryYds - a.modeledCarryYds)
    .map((evaluation): NaturalLandingClubComparison => {
      const best = evaluation.bestCandidate
      const risk = best?.riskProfile ?? null
      const states = best?.modeledSamples.map((sample) => sample.state) ?? []
      const rawDistances = states.flatMap((state) =>
        typeof state.distanceToPinYds === 'number' ? [state.distanceToPinYds] : [],
      )
      const penaltySamples = states.filter((state) => state.penaltyStrokeCount > 0).length

      return {
        club: evaluation.club,
        supportShots: evaluation.supportShots,
        stockCarryYds: evaluation.stockCarryYds,
        modeledCarryYds: evaluation.modeledCarryYds,
        planningTarget: evaluation.planningTarget,
        planningTargetDistanceYds: evaluation.targetDistanceYds,
        carryGapYds: evaluation.carryGapYds,
        aimSearchHalfWidthYds: evaluation.aimSearchHalfWidthYds,
        bestAimOffsetYds: best?.aimOffsetYds ?? null,
        meanLanding: best?.meanLanding ?? null,
        success: risk?.success ?? null,
        manageable: risk?.manageable ?? null,
        seriousTrouble: risk?.seriousTrouble ?? null,
        catastrophe: risk?.catastrophe ?? null,
        unknown: risk?.unknown ?? null,
        meanRawDistanceToPinYds: average(rawDistances),
        penaltySampleProbability: states.length > 0 ? penaltySamples / states.length : null,
        clubValueStatus: 'pending-strokes-gained',
      }
    })
}
