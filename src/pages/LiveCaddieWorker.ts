import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import {
  evaluateAimLab,
  type AimCandidateEvaluation,
  type AimLabEnvironment,
  type ClubAimEvaluation,
} from '../liveCaddie/aimOptimization'
import type { DecisionRiskTailLanding } from '../liveCaddie/decisionRiskProfile'
import type { SavedSession } from '../types'

type LiveCaddieWorkerRequest = {
  sessions: SavedSession[]
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  environment: AimLabEnvironment
  nowMs: number
}

type LiveCaddieWorkerResponse =
  | { type: 'success'; evaluations: ClubAimEvaluation[] }
  | { type: 'error'; error: string }

const DISPLAY_OUTCOME_DOT_COUNT = 256

const displayTierForSurface = (
  kind: CourseSurfaceClassification,
): DecisionRiskTailLanding['tier'] => {
  if (kind === 'water' || kind === 'penalty') return 'catastrophe'
  if (kind === 'bunker' || kind === 'deep-rough') return 'serious_trouble'
  if (kind === 'rough') return 'manageable'
  if (kind === 'unknown') return 'unknown'
  return 'success'
}

const sampleEvenly = <T,>(items: readonly T[], count: number): T[] => {
  if (count <= 0 || items.length === 0) return []
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.min(
      items.length - 1,
      Math.floor(((index + 0.5) * items.length) / count),
    )
    return items[sourceIndex]
  })
}

const sampleWeightedTail = (
  items: readonly DecisionRiskTailLanding[],
  count: number,
): DecisionRiskTailLanding[] => {
  if (count <= 0 || items.length === 0) return []
  const totalWeight = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0)
  if (totalWeight <= 0) return sampleEvenly(items, count)

  const sampled: DecisionRiskTailLanding[] = []
  let sourceIndex = 0
  let cumulative = Math.max(0, items[0].weight)
  for (let index = 0; index < count; index += 1) {
    const target = ((index + 0.5) / count) * totalWeight
    while (sourceIndex < items.length - 1 && cumulative < target) {
      sourceIndex += 1
      cumulative += Math.max(0, items[sourceIndex].weight)
    }
    sampled.push(items[sourceIndex])
  }
  return sampled
}

/**
 * Live Caddie does not need all 2,048 modeled core samples, but a small visual
 * sample makes the percentage outcomes understandable on the course map.
 * Build a deterministic 256-dot approximation of the same full-risk mixture:
 * modeled core mass + the empirically learned planning-excluded tail.
 *
 * The worker reuses `tailLandings` only as a lightweight transport slot for the
 * playing UI. Ranking and all percentages were already computed from the full
 * canonical distributions before this display-only transformation.
 */
const buildDisplayOutcomeDots = (
  candidate: AimCandidateEvaluation,
): DecisionRiskTailLanding[] => {
  const risk = candidate.riskProfile
  if (!risk || candidate.modeledSamples.length === 0) return []

  const coreCount = Math.max(
    0,
    Math.min(
      DISPLAY_OUTCOME_DOT_COUNT,
      Math.round(DISPLAY_OUTCOME_DOT_COUNT * risk.coreProbability),
    ),
  )
  const tailCount = DISPLAY_OUTCOME_DOT_COUNT - coreCount
  const displayWeight = risk.tailProbability > 0
    ? risk.tailProbability / DISPLAY_OUTCOME_DOT_COUNT
    : 0

  const coreDots = sampleEvenly(candidate.modeledSamples, coreCount).map(
    (sample): DecisionRiskTailLanding => ({
      landing: sample.landing,
      kind: sample.kind,
      tier: displayTierForSurface(sample.kind),
      quality: 'normal',
      state: sample.state,
      weight: displayWeight,
    }),
  )

  const tailDots = sampleWeightedTail(risk.tailLandings, tailCount).map(
    (sample): DecisionRiskTailLanding => ({
      ...sample,
      weight: displayWeight,
    }),
  )

  return [...coreDots, ...tailDots]
}

const stripHeavySamples = (evaluations: ClubAimEvaluation[]): ClubAimEvaluation[] =>
  evaluations.map((evaluation) => {
    const candidates = evaluation.candidates.map((candidate) => {
      const showableOutcomeDots = (candidate.decisionRank ?? Number.POSITIVE_INFINITY) <= 4
        ? buildDisplayOutcomeDots(candidate)
        : []
      return {
        ...candidate,
        // Keep only a small full-risk display cloud for the top playable lines.
        // Sending every 2,048-point core cloud for every club/aim would make the
        // worker response unnecessarily large and expensive to structured-clone.
        modeledSamples: [],
        riskProfile: candidate.riskProfile
          ? {
              ...candidate.riskProfile,
              tailLandings: showableOutcomeDots,
            }
          : null,
      }
    })
    const bestAimOffset = evaluation.bestCandidate?.aimOffsetYds ?? null
    const bestCandidate = bestAimOffset == null
      ? null
      : candidates.find((candidate) => candidate.aimOffsetYds === bestAimOffset) ?? null

    return {
      ...evaluation,
      candidates,
      bestCandidate,
    }
  })

self.onmessage = (event: MessageEvent<LiveCaddieWorkerRequest>) => {
  try {
    const { sessions, hole, ball, target, environment, nowMs } = event.data
    const evaluations = stripHeavySamples(
      evaluateAimLab(sessions, hole, ball, target, environment, nowMs),
    )
    const response: LiveCaddieWorkerResponse = { type: 'success', evaluations }
    self.postMessage(response)
  } catch (cause) {
    const response: LiveCaddieWorkerResponse = {
      type: 'error',
      error: cause instanceof Error ? cause.message : String(cause),
    }
    self.postMessage(response)
  }
}

export {}
