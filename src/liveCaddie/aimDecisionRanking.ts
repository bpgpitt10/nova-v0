import { confidenceConfig } from '../lib/confidenceConfig'
import type { ModeledAimSample } from './aimOutcomeSampling'
import type { DecisionRiskProfile } from './decisionRiskProfile'
import {
  evaluateCandidateNextStateValue,
  type CandidateNextStateValue,
} from './nextStateValue'

export type AimDecisionPolicy = {
  /**
   * Candidates within this absolute catastrophe-probability margin of the
   * safest authoritative choice may compete on expected future strokes.
   */
  catastropheToleranceAboveBest: number
  /** @deprecated Next-state value replaces target-fit carry gating. Retained for API compatibility. */
  carryGapToleranceAboveBestYds: number
  /**
   * @deprecated A hard authoritative-support cliff is intentionally no longer
   * used for club ranking. Retained for compatibility with older callers.
   */
  minimumAuthoritativeSupportShots: number
  /**
   * Below this support, a club remains visible but cannot outrank a comparison-
   * ready alternative. This is a cold-start floor, not a maturity threshold.
   */
  minimumComparisonSupportShots?: number
  /**
   * Even equally confident models should not flip recommendations over a few
   * thousandths of a stroke. This is an indifference band, not an EV penalty.
   */
  evIndifferenceBaseStrokes?: number
  /**
   * Extra indifference room granted to a more confident model when the raw-EV
   * leader is less certain. At a 100-point confidence gap this is the maximum
   * additional stroke gap that can still be treated as statistically indifferent.
   */
  confidenceIndifferenceMaxStrokes?: number
}

export const DEFAULT_AIM_DECISION_POLICY: AimDecisionPolicy = {
  catastropheToleranceAboveBest: 0.02,
  carryGapToleranceAboveBestYds: 12,
  minimumAuthoritativeSupportShots: 5,
  minimumComparisonSupportShots: confidenceConfig.insufficientData.minIncludedShots,
  evIndifferenceBaseStrokes: 0.015,
  confidenceIndifferenceMaxStrokes: 0.10,
}

export type RiskRankableAim = {
  aimOffsetYds: number
  riskProfile: DecisionRiskProfile | null
  /** Canonical deterministic core cloud. Used to compute next-shot state value. */
  modeledSamples?: readonly ModeledAimSample[]
  /** Optional precomputed value, useful for proofs and diagnostics. */
  stateValue?: CandidateNextStateValue | null
  /** Legacy V0 utility is diagnostic only and is never used for authoritative ranking. */
  score: number | null
}

export type RankedAimChoice<T extends RiskRankableAim> = {
  candidate: T
  rank: number
  withinCatastropheGuardrail: boolean
  decisionReason: string
}

export const nextStateValueForAimCandidate = (candidate: RiskRankableAim): CandidateNextStateValue | null => {
  if (typeof candidate.stateValue !== 'undefined') return candidate.stateValue
  if (!candidate.riskProfile || !candidate.modeledSamples) return null
  return evaluateCandidateNextStateValue(candidate.modeledSamples, candidate.riskProfile)
}

const compareAimValue = <T extends RiskRankableAim>(
  a: { candidate: T; stateValue: CandidateNextStateValue; risk: DecisionRiskProfile },
  b: { candidate: T; stateValue: CandidateNextStateValue; risk: DecisionRiskProfile },
) => {
  const aValue = a.stateValue.expectedFutureStrokes!
  const bValue = b.stateValue.expectedFutureStrokes!
  if (Math.abs(aValue - bValue) > 1e-9) return aValue - bValue
  if (Math.abs(a.risk.catastrophe - b.risk.catastrophe) > 1e-9) {
    return a.risk.catastrophe - b.risk.catastrophe
  }
  if (Math.abs(a.risk.unknown - b.risk.unknown) > 1e-9) return a.risk.unknown - b.risk.unknown
  return Math.abs(a.candidate.aimOffsetYds) - Math.abs(b.candidate.aimOffsetYds)
}

/**
 * Rank lateral aims for a single club.
 *
 * Catastrophe remains a policy guardrail, not an additive score. Inside the
 * safe set, the authoritative objective is now expected future strokes from
 * the exact distribution of next-shot states. Success/severity and the legacy
 * V0 utility remain diagnostics only.
 */
export const rankRiskAwareAimCandidates = <T extends RiskRankableAim>(
  candidates: readonly T[],
  policy: AimDecisionPolicy = DEFAULT_AIM_DECISION_POLICY,
): RankedAimChoice<T>[] => {
  const evaluated = candidates.map((candidate) => ({
    candidate,
    risk: candidate.riskProfile,
    stateValue: nextStateValueForAimCandidate(candidate),
  }))
  const usable = evaluated.filter(
    (row): row is {
      candidate: T
      risk: DecisionRiskProfile
      stateValue: CandidateNextStateValue & { expectedFutureStrokes: number }
    } => row.risk != null && row.stateValue?.expectedFutureStrokes != null,
  )
  const unavailable = evaluated.filter(
    (row) => row.risk == null || row.stateValue?.expectedFutureStrokes == null,
  )

  if (usable.length === 0) {
    return [...evaluated]
      .sort((a, b) => {
        const aCat = a.risk?.catastrophe ?? Number.POSITIVE_INFINITY
        const bCat = b.risk?.catastrophe ?? Number.POSITIVE_INFINITY
        if (Math.abs(aCat - bCat) > 1e-9) return aCat - bCat
        const aUnknown = a.risk?.unknown ?? Number.POSITIVE_INFINITY
        const bUnknown = b.risk?.unknown ?? Number.POSITIVE_INFINITY
        if (Math.abs(aUnknown - bUnknown) > 1e-9) return aUnknown - bUnknown
        return Math.abs(a.candidate.aimOffsetYds) - Math.abs(b.candidate.aimOffsetYds)
      })
      .map((row, index) => ({
        candidate: row.candidate,
        rank: index + 1,
        withinCatastropheGuardrail: false,
        decisionReason: 'Next-state value unavailable; diagnostic risk ordering only. Recommendation is not authoritative.',
      }))
  }

  const minCatastrophe = Math.min(...usable.map((row) => row.risk.catastrophe))
  const guardrail = minCatastrophe + policy.catastropheToleranceAboveBest
  const safe = usable
    .filter((row) => row.risk.catastrophe <= guardrail + 1e-9)
    .sort(compareAimValue)
  const outside = usable
    .filter((row) => row.risk.catastrophe > guardrail + 1e-9)
    .sort((a, b) => {
      const catastropheDelta = a.risk.catastrophe - b.risk.catastrophe
      return Math.abs(catastropheDelta) > 1e-9 ? catastropheDelta : compareAimValue(a, b)
    })

  const rankedUsable: RankedAimChoice<T>[] = [...safe, ...outside].map((row, index) => ({
    candidate: row.candidate,
    rank: index + 1,
    withinCatastropheGuardrail: row.risk.catastrophe <= guardrail + 1e-9,
    decisionReason: index === 0
      ? `Within ${(policy.catastropheToleranceAboveBest * 100).toFixed(0)} pts of the safest catastrophe rate; lowest expected future strokes (${row.stateValue.expectedFutureStrokes.toFixed(3)}) in the safe set.`
      : row.risk.catastrophe > guardrail + 1e-9
        ? 'Rejected by the catastrophe guardrail before next-state value comparison.'
        : `Safe-set alternative with higher expected future strokes (${row.stateValue.expectedFutureStrokes.toFixed(3)}).`,
  }))

  const unavailableRows: RankedAimChoice<T>[] = unavailable.map((row, index) => ({
    candidate: row.candidate,
    rank: rankedUsable.length + index + 1,
    withinCatastropheGuardrail: false,
    decisionReason: 'Next-state value unavailable for this aim; not eligible ahead of value-ready choices.',
  }))

  return [...rankedUsable, ...unavailableRows]
}

export type ClubAimChoice<T extends RiskRankableAim> = {
  club: string
  /** Retained for diagnostics; no longer a strategic ranking gate. */
  modeledCarryYds: number
  /** Retained for diagnostics; no longer a strategic ranking gate. */
  targetDistanceYds: number
  supportShots: number
  supportingSessions?: number
  bestCandidate: T | null
}

export type ClubDecisionStrength = 'clear' | 'lean' | 'toss-up' | 'provisional'

export type RankedClubAimChoice<T extends RiskRankableAim, C extends ClubAimChoice<T>> = {
  evaluation: C
  rank: number
  /** Compatibility field. Next-state V1 does not use target-fit gating. */
  targetFit: boolean
  withinCatastropheGuardrail: boolean
  decisionReason: string
  /** 0–1 confidence from the same shot/session evidence targets used elsewhere in Looper. */
  modelConfidence: number
  decisionStrength: ClubDecisionStrength
  /** Positive means this row's EV is worse than the raw lowest-EV safe option. */
  evDeltaToRawBest: number | null
}

const policyMinimumComparisonSupport = (policy: AimDecisionPolicy) =>
  policy.minimumComparisonSupportShots ?? confidenceConfig.insufficientData.minIncludedShots

const policyBaseIndifference = (policy: AimDecisionPolicy) =>
  policy.evIndifferenceBaseStrokes ?? DEFAULT_AIM_DECISION_POLICY.evIndifferenceBaseStrokes!

const policyConfidenceIndifference = (policy: AimDecisionPolicy) =>
  policy.confidenceIndifferenceMaxStrokes ?? DEFAULT_AIM_DECISION_POLICY.confidenceIndifferenceMaxStrokes!

/**
 * Graduated evidence confidence. Five shots no longer flip a binary switch from
 * provisional to fully trusted. The existing Looper evidence targets are used:
 * 20 included shots and 3 supporting sessions, with the same 65/35 weighting.
 */
export const clubModelConfidence = (
  supportShots: number,
  supportingSessions = 1,
) => {
  const targetShots = Math.max(1, confidenceConfig.dataConfidence.targetIncludedShots)
  const targetSessions = Math.max(1, confidenceConfig.dataConfidence.targetSessions)
  const shotEvidence = Math.min(1, Math.max(0, supportShots) / targetShots)
  const sessionEvidence = Math.min(1, Math.max(0, supportingSessions) / targetSessions)
  return (
    shotEvidence * confidenceConfig.dataConfidence.shotEvidenceWeight +
    sessionEvidence * confidenceConfig.dataConfidence.sessionEvidenceWeight
  )
}

type ValueReadyClubRow<T extends RiskRankableAim, C extends ClubAimChoice<T>> = {
  evaluation: C
  candidate: T
  risk: DecisionRiskProfile
  stateValue: CandidateNextStateValue & { expectedFutureStrokes: number }
  modelConfidence: number
}

const rawValueCompare = <T extends RiskRankableAim, C extends ClubAimChoice<T>>(
  a: ValueReadyClubRow<T, C>,
  b: ValueReadyClubRow<T, C>,
) => {
  const valueDelta = a.stateValue.expectedFutureStrokes - b.stateValue.expectedFutureStrokes
  if (Math.abs(valueDelta) > 1e-9) return valueDelta
  const catastropheDelta = a.risk.catastrophe - b.risk.catastrophe
  if (Math.abs(catastropheDelta) > 1e-9) return catastropheDelta
  const unknownDelta = a.risk.unknown - b.risk.unknown
  if (Math.abs(unknownDelta) > 1e-9) return unknownDelta
  const confidenceDelta = b.modelConfidence - a.modelConfidence
  if (Math.abs(confidenceDelta) > 1e-9) return confidenceDelta
  return b.evaluation.supportShots - a.evaluation.supportShots
}

/**
 * How much worse a higher-confidence candidate may be on raw EV and still be
 * treated as indistinguishable from the raw-EV leader. Confidence never buys a
 * better EV; it only resolves differences too small to trust given the evidence.
 */
const indifferenceThresholdAgainstRawBest = <
  T extends RiskRankableAim,
  C extends ClubAimChoice<T>,
>(
  rawBest: ValueReadyClubRow<T, C>,
  challenger: ValueReadyClubRow<T, C>,
  policy: AimDecisionPolicy,
) => {
  const confidenceAdvantage = Math.max(0, challenger.modelConfidence - rawBest.modelConfidence)
  return (
    policyBaseIndifference(policy) +
    confidenceAdvantage * policyConfidenceIndifference(policy)
  )
}

const confidenceAwareSafeOrder = <
  T extends RiskRankableAim,
  C extends ClubAimChoice<T>,
>(
  rows: readonly ValueReadyClubRow<T, C>[],
  policy: AimDecisionPolicy,
) => {
  const remaining = [...rows]
  const ordered: ValueReadyClubRow<T, C>[] = []

  while (remaining.length > 0) {
    const rawBest = [...remaining].sort(rawValueCompare)[0]
    const rawBestValue = rawBest.stateValue.expectedFutureStrokes
    const indistinguishable = remaining.filter((row) => {
      const gap = row.stateValue.expectedFutureStrokes - rawBestValue
      return gap <= indifferenceThresholdAgainstRawBest(rawBest, row, policy) + 1e-9
    })
    indistinguishable.sort((a, b) => {
      const confidenceDelta = b.modelConfidence - a.modelConfidence
      if (Math.abs(confidenceDelta) > 1e-9) return confidenceDelta
      return rawValueCompare(a, b)
    })
    const chosen = indistinguishable[0] ?? rawBest
    ordered.push(chosen)
    remaining.splice(remaining.indexOf(chosen), 1)
  }

  return ordered
}

/**
 * Rank club + aim recommendations on the value of where the full shot
 * distribution leaves the player next.
 *
 * 1) Keep only truly cold-start clubs (<4 shots by default) behind comparison-ready clubs.
 * 2) Apply the catastrophe guardrail.
 * 3) Inside the safe set, calculate exact EV for every club.
 * 4) When EVs are effectively indistinguishable, prefer the better-supported
 *    player model rather than pretending a 0.004-stroke gap is meaningful.
 *
 * There is intentionally no carry-gap/target-fit gate here. A Driver leaving
 * 175 yards and a 3W leaving 200 yards must be allowed to compete directly;
 * the next-state value function prices that difference instead of an arbitrary
 * distance-target heuristic.
 */
export const rankRiskAwareClubChoices = <
  T extends RiskRankableAim,
  C extends ClubAimChoice<T>,
>(
  evaluations: readonly C[],
  policy: AimDecisionPolicy = DEFAULT_AIM_DECISION_POLICY,
): RankedClubAimChoice<T, C>[] => {
  const comparisonReady = (evaluation: C) =>
    evaluation.supportShots >= policyMinimumComparisonSupport(policy)

  const evaluated = evaluations.map((evaluation) => {
    const candidate = evaluation.bestCandidate
    return {
      evaluation,
      candidate,
      risk: candidate?.riskProfile ?? null,
      stateValue: candidate ? nextStateValueForAimCandidate(candidate) : null,
      modelConfidence: clubModelConfidence(
        evaluation.supportShots,
        evaluation.supportingSessions ?? 1,
      ),
    }
  })
  const usable = evaluated.filter(
    (row): row is ValueReadyClubRow<T, C> =>
      row.candidate != null && row.risk != null && row.stateValue?.expectedFutureStrokes != null,
  )
  const unavailable = evaluated.filter(
    (row) => row.candidate == null || row.risk == null || row.stateValue?.expectedFutureStrokes == null,
  )

  if (usable.length === 0) {
    return [...evaluated]
      .sort((a, b) => Number(comparisonReady(b.evaluation)) - Number(comparisonReady(a.evaluation)))
      .map((row, index) => ({
        evaluation: row.evaluation,
        rank: index + 1,
        targetFit: false,
        withinCatastropheGuardrail: false,
        decisionReason: 'Next-state value unavailable; no authoritative club recommendation.',
        modelConfidence: row.modelConfidence,
        decisionStrength: 'provisional',
        evDeltaToRawBest: null,
      }))
  }

  const ready = usable.filter((row) => comparisonReady(row.evaluation))
  const comparisonPool = ready.length > 0 ? ready : usable
  const coldStart = ready.length > 0
    ? usable.filter((row) => !comparisonReady(row.evaluation))
    : []

  const minCatastrophe = Math.min(...comparisonPool.map((row) => row.risk.catastrophe))
  const catastropheGuardrail = minCatastrophe + policy.catastropheToleranceAboveBest

  const safePool = comparisonPool.filter(
    (row) => row.risk.catastrophe <= catastropheGuardrail + 1e-9,
  )
  const rawBestSafe = [...safePool].sort(rawValueCompare)[0] ?? null
  const safe = confidenceAwareSafeOrder(safePool, policy)
  const catastropheRejected = comparisonPool
    .filter((row) => row.risk.catastrophe > catastropheGuardrail + 1e-9)
    .sort((a, b) => {
      const catastropheDelta = a.risk.catastrophe - b.risk.catastrophe
      return Math.abs(catastropheDelta) > 1e-9 ? catastropheDelta : rawValueCompare(a, b)
    })
  coldStart.sort(rawValueCompare)

  const rankedUsable = [...safe, ...catastropheRejected, ...coldStart]
  const winner = rankedUsable[0] ?? null
  const rawBestValue = rawBestSafe?.stateValue.expectedFutureStrokes ?? null

  const safeIndifferencePeers = winner && rawBestSafe
    ? safePool.filter((row) => {
        if (row === winner) return false
        const lower = row.stateValue.expectedFutureStrokes <= winner.stateValue.expectedFutureStrokes
          ? row
          : winner
        const higher = lower === row ? winner : row
        const gap = higher.stateValue.expectedFutureStrokes - lower.stateValue.expectedFutureStrokes
        return gap <= indifferenceThresholdAgainstRawBest(lower, higher, policy) + 1e-9
      })
    : []

  const winnerStrength: ClubDecisionStrength = !winner
    ? 'provisional'
    : safeIndifferencePeers.length > 0
      ? 'toss-up'
      : winner.modelConfidence < 0.55
        ? 'lean'
        : (() => {
            const nextSafe = safe.find((row) => row !== winner)
            if (!nextSafe) return 'clear'
            const gap = Math.abs(
              nextSafe.stateValue.expectedFutureStrokes - winner.stateValue.expectedFutureStrokes,
            )
            return gap < 0.05 ? 'lean' : 'clear'
          })()

  const usableRows: RankedClubAimChoice<T, C>[] = rankedUsable.map((row, index) => {
    const isColdStart = ready.length > 0 && !comparisonReady(row.evaluation)
    const withinCatastropheGuardrail =
      !isColdStart && row.risk.catastrophe <= catastropheGuardrail + 1e-9
    const evDeltaToRawBest = rawBestValue == null
      ? null
      : row.stateValue.expectedFutureStrokes - rawBestValue

    let decisionReason: string
    let decisionStrength: ClubDecisionStrength = index === 0 ? winnerStrength : 'clear'

    if (index === 0 && rawBestSafe && row !== rawBestSafe) {
      const rawGap = row.stateValue.expectedFutureStrokes - rawBestSafe.stateValue.expectedFutureStrokes
      const threshold = indifferenceThresholdAgainstRawBest(rawBestSafe, row, policy)
      decisionReason =
        `Toss-up: raw EV favors ${rawBestSafe.evaluation.club} by ${rawGap.toFixed(3)} strokes, ` +
        `inside the ${threshold.toFixed(3)} confidence-adjusted indifference band; ` +
        `preferred the stronger player model (${(row.modelConfidence * 100).toFixed(0)}% vs ${(rawBestSafe.modelConfidence * 100).toFixed(0)}% confidence).`
      decisionStrength = 'toss-up'
    } else if (index === 0) {
      const nextSafe = safe.find((candidate) => candidate !== row)
      const gap = nextSafe
        ? nextSafe.stateValue.expectedFutureStrokes - row.stateValue.expectedFutureStrokes
        : null
      const confidenceNote = `player-model confidence ${(row.modelConfidence * 100).toFixed(0)}%`
      decisionReason = decisionStrength === 'toss-up'
        ? `Toss-up: lowest raw EV (${row.stateValue.expectedFutureStrokes.toFixed(3)}), but another safe club falls inside the confidence-aware indifference band; ${confidenceNote}.`
        : decisionStrength === 'lean'
          ? `Lean: lowest safe expected future strokes (${row.stateValue.expectedFutureStrokes.toFixed(3)})${gap == null ? '' : ` by ${gap.toFixed(3)}`}; ${confidenceNote}.`
          : `Clear: lowest safe expected future strokes (${row.stateValue.expectedFutureStrokes.toFixed(3)})${gap == null ? '' : ` by ${gap.toFixed(3)}`}; ${confidenceNote}.`
    } else if (isColdStart) {
      decisionReason =
        `Provisional cold start: ${row.evaluation.supportShots} Stock shots is below the ` +
        `${policyMinimumComparisonSupport(policy)}-shot comparison floor; model confidence ${(row.modelConfidence * 100).toFixed(0)}%.`
      decisionStrength = 'provisional'
    } else if (!withinCatastropheGuardrail) {
      decisionReason = 'Rejected by the catastrophe guardrail before expected-future-strokes comparison.'
    } else if (winner && safeIndifferencePeers.includes(row)) {
      decisionReason =
        `Toss-up alternative: expected future strokes (${row.stateValue.expectedFutureStrokes.toFixed(3)}) fall inside the winner's confidence-aware indifference band; model confidence ${(row.modelConfidence * 100).toFixed(0)}%.`
      decisionStrength = 'toss-up'
    } else {
      decisionReason =
        `Safe-set alternative with higher expected future strokes (${row.stateValue.expectedFutureStrokes.toFixed(3)}); model confidence ${(row.modelConfidence * 100).toFixed(0)}%.`
    }

    return {
      evaluation: row.evaluation,
      rank: index + 1,
      targetFit: true,
      withinCatastropheGuardrail,
      decisionReason,
      modelConfidence: row.modelConfidence,
      decisionStrength,
      evDeltaToRawBest,
    }
  })

  unavailable.sort(
    (a, b) => Number(comparisonReady(b.evaluation)) - Number(comparisonReady(a.evaluation)),
  )
  const unavailableRows: RankedClubAimChoice<T, C>[] = unavailable.map((row, index) => ({
    evaluation: row.evaluation,
    rank: usableRows.length + index + 1,
    targetFit: false,
    withinCatastropheGuardrail: false,
    decisionReason: 'Next-state value unavailable for this club; not eligible ahead of value-ready choices.',
    modelConfidence: row.modelConfidence,
    decisionStrength: 'provisional',
    evDeltaToRawBest: null,
  }))

  return [...usableRows, ...unavailableRows]
}
