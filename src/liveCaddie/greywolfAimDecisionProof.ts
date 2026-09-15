import { loadGreywolfHoleGeometry } from '../courseGeometry/greywolfCourseLoader'
import type { CoursePointYds } from '../courseGeometry/types'
import type { SavedSession } from '../types'
import { evaluateAimLab } from './aimOptimization'
import {
  GREYWOLF_HOLE_08_GSPRO_PIN_DISTANCE_YDS,
  GREYWOLF_HOLE_08_PROOF_BALL,
} from './greywolfDecisionProof'

const distanceYds = (a: CoursePointYds, b: CoursePointYds) =>
  Math.hypot(a[0] - b[0], a[1] - b[1])

export type GreywolfAimDecisionProof = {
  scenario: {
    course: string
    holeNumber: number
    source: string
    ball: CoursePointYds
    target: CoursePointYds
    targetDistanceYds: number
    retainedGsproPinDistanceYds: number
    neutralConditions: true
  }
  recommendation: {
    club: string
    modeledCarryYds: number
    carryGapYds: number
    aimOffsetYds: number
    targetFit: boolean | null
    withinCatastropheGuardrail: boolean | null
    clubDecisionReason: string | null
    aimDecisionReason: string | null
    corePreferred: number | null
    fullRiskSuccess: number | null
    fullRiskManageable: number | null
    fullRiskSeriousTrouble: number | null
    fullRiskCatastrophe: number | null
    fullRiskUnknown: number | null
    tailProbability: number | null
  } | null
  clubRanking: Array<{
    rank: number | null
    club: string
    modeledCarryYds: number
    carryGapYds: number
    targetFit: boolean | null
    catastropheGuardrail: boolean | null
    bestAimOffsetYds: number | null
    success: number | null
    seriousTrouble: number | null
    catastrophe: number | null
    decisionReason: string | null
  }>
  aimSweep: Array<{
    rank: number | null
    aimOffsetYds: number
    catastropheGuardrail: boolean | null
    corePreferred: number | null
    success: number | null
    manageable: number | null
    seriousTrouble: number | null
    catastrophe: number | null
    unknown: number | null
    expectedSeverity: number | null
    tailProbability: number | null
    legacyScore: number | null
    decisionReason: string | null
  }>
  notes: string[]
}

/**
 * Replay the first real Greywolf proof through the same risk-aware evaluator
 * now used by Aim Lab. It intentionally uses neutral conditions so the proof
 * isolates Course x Player decision behavior from wind/elevation/lie physics.
 */
export const buildGreywolfHole08AimDecisionProof = async (
  sessions: SavedSession[],
  nowMs = Date.now(),
): Promise<GreywolfAimDecisionProof> => {
  const hole = await loadGreywolfHoleGeometry(8)
  const target = hole.markers.pin
  if (!target) throw new Error('Greywolf Hole 8 full-risk proof requires a canonical green target.')

  const targetDistanceYds = distanceYds(GREYWOLF_HOLE_08_PROOF_BALL, target)
  const evaluations = evaluateAimLab(
    sessions,
    hole,
    GREYWOLF_HOLE_08_PROOF_BALL,
    target,
    nowMs,
  )
  const selected = evaluations[0] ?? null
  const best = selected?.bestCandidate ?? null
  const risk = best?.riskProfile ?? null
  const notes: string[] = [
    'Neutral conditions: wind, elevation and lie transforms are intentionally excluded.',
    'Historical live state retained a 151 yd GSPro pin distance but not the exact historical pin coordinate; the canonical green marker is the strategic target.',
  ]

  const targetVsGsproDelta = targetDistanceYds - GREYWOLF_HOLE_08_GSPRO_PIN_DISTANCE_YDS
  if (Math.abs(targetVsGsproDelta) > 8) {
    notes.push(
      `Canonical target differs from the retained GSPro pin distance by ${targetVsGsproDelta.toFixed(1)} yd; treat this as a strategic replay, not exact historical-pin reconstruction.`,
    )
  }
  if (risk && risk.unknown > 0.05) {
    notes.push('Recommended choice still has >5% full-risk probability on unmapped geometry.')
  }

  return {
    scenario: {
      course: hole.courseName,
      holeNumber: 8,
      source: 'Greywolf GSPro round-215, 2026-09-12',
      ball: GREYWOLF_HOLE_08_PROOF_BALL,
      target,
      targetDistanceYds,
      retainedGsproPinDistanceYds: GREYWOLF_HOLE_08_GSPRO_PIN_DISTANCE_YDS,
      neutralConditions: true,
    },
    recommendation: selected && best ? {
      club: selected.club,
      modeledCarryYds: selected.modeledCarryYds,
      carryGapYds: selected.carryGapYds,
      aimOffsetYds: best.aimOffsetYds,
      targetFit: selected.targetFit,
      withinCatastropheGuardrail: selected.withinCatastropheGuardrail,
      clubDecisionReason: selected.decisionReason,
      aimDecisionReason: best.decisionReason,
      corePreferred: best.surfaceOutcomes?.preferred ?? null,
      fullRiskSuccess: risk?.success ?? null,
      fullRiskManageable: risk?.manageable ?? null,
      fullRiskSeriousTrouble: risk?.seriousTrouble ?? null,
      fullRiskCatastrophe: risk?.catastrophe ?? null,
      fullRiskUnknown: risk?.unknown ?? null,
      tailProbability: risk?.tailProbability ?? null,
    } : null,
    clubRanking: evaluations.map((evaluation) => ({
      rank: evaluation.decisionRank,
      club: evaluation.club,
      modeledCarryYds: evaluation.modeledCarryYds,
      carryGapYds: evaluation.carryGapYds,
      targetFit: evaluation.targetFit,
      catastropheGuardrail: evaluation.withinCatastropheGuardrail,
      bestAimOffsetYds: evaluation.bestCandidate?.aimOffsetYds ?? null,
      success: evaluation.bestCandidate?.riskProfile?.success ?? null,
      seriousTrouble: evaluation.bestCandidate?.riskProfile?.seriousTrouble ?? null,
      catastrophe: evaluation.bestCandidate?.riskProfile?.catastrophe ?? null,
      decisionReason: evaluation.decisionReason,
    })),
    aimSweep: selected?.candidates
      .slice()
      .sort((a, b) => (a.decisionRank ?? Number.POSITIVE_INFINITY) - (b.decisionRank ?? Number.POSITIVE_INFINITY))
      .map((candidate) => ({
        rank: candidate.decisionRank,
        aimOffsetYds: candidate.aimOffsetYds,
        catastropheGuardrail: candidate.withinCatastropheGuardrail,
        corePreferred: candidate.surfaceOutcomes?.preferred ?? null,
        success: candidate.riskProfile?.success ?? null,
        manageable: candidate.riskProfile?.manageable ?? null,
        seriousTrouble: candidate.riskProfile?.seriousTrouble ?? null,
        catastrophe: candidate.riskProfile?.catastrophe ?? null,
        unknown: candidate.riskProfile?.unknown ?? null,
        expectedSeverity: candidate.riskProfile?.expectedSeverity ?? null,
        tailProbability: candidate.riskProfile?.tailProbability ?? null,
        legacyScore: candidate.score,
        decisionReason: candidate.decisionReason,
      })) ?? [],
    notes,
  }
}
