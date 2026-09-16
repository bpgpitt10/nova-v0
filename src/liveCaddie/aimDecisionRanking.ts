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
   * Thin player samples remain visible. When an adequately supported option
   * exists, under-supported clubs remain provisional rather than overruling a
   * mature player model on a tiny sample.
   */
  minimumAuthoritativeSupportShots: number
}

export const DEFAULT_AIM_DECISION_POLICY: AimDecisionPolicy = {
  catastropheToleranceAboveBest: 0.02,
  carryGapToleranceAboveBestYds: 12,
  minimumAuthoritativeSupportShots: 5,
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
  bestCandidate: T | null
}

export type RankedClubAimChoice<T extends RiskRankableAim, C extends ClubAimChoice<T>> = {
  evaluation: C
  rank: number
  /** Compatibility field. Next-state V1 does not use target-fit gating. */
  targetFit: boolean
  withinCatastropheGuardrail: boolean
  decisionReason: string
}

/**
 * Rank club + aim recommendations on the value of where the full shot
 * distribution leaves the player next.
 *
 * 1) Prefer adequately supported club models when available.
 * 2) Apply the catastrophe guardrail across those choices.
 * 3) Inside the safe set, minimize expected future strokes.
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
  const supportAdequate = (evaluation: C) =>
    evaluation.supportShots >= policy.minimumAuthoritativeSupportShots

  const evaluated = evaluations.map((evaluation) => {
    const candidate = evaluation.bestCandidate
    return {
      evaluation,
      candidate,
      risk: candidate?.riskProfile ?? null,
      stateValue: candidate ? nextStateValueForAimCandidate(candidate) : null,
    }
  })
  const usable = evaluated.filter(
    (row): row is {
      evaluation: C
      candidate: T
      risk: DecisionRiskProfile
      stateValue: CandidateNextStateValue & { expectedFutureStrokes: number }
    } => row.candidate != null && row.risk != null && row.stateValue?.expectedFutureStrokes != null,
  )
  const unavailable = evaluated.filter(
    (row) => row.candidate == null || row.risk == null || row.stateValue?.expectedFutureStrokes == null,
  )

  if (usable.length === 0) {
    return [...evaluated]
      .sort((a, b) => Number(supportAdequate(b.evaluation)) - Number(supportAdequate(a.evaluation)))
      .map((row, index) => ({
        evaluation: row.evaluation,
        rank: index + 1,
        targetFit: false,
        withinCatastropheGuardrail: false,
        decisionReason: 'Next-state value unavailable; no authoritative club recommendation.',
      }))
  }

  const supported = usable.filter((row) => supportAdequate(row.evaluation))
  const comparisonPool = supported.length > 0 ? supported : usable
  const provisional = supported.length > 0
    ? usable.filter((row) => !supportAdequate(row.evaluation))
    : []

  const minCatastrophe = Math.min(...comparisonPool.map((row) => row.risk.catastrophe))
  const catastropheGuardrail = minCatastrophe + policy.catastropheToleranceAboveBest

  const compareClubValue = (
    a: (typeof usable)[number],
    b: (typeof usable)[number],
  ) => {
    const valueDelta = a.stateValue.expectedFutureStrokes - b.stateValue.expectedFutureStrokes
    if (Math.abs(valueDelta) > 1e-9) return valueDelta
    const catastropheDelta = a.risk.catastrophe - b.risk.catastrophe
    if (Math.abs(catastropheDelta) > 1e-9) return catastropheDelta
    const unknownDelta = a.risk.unknown - b.risk.unknown
    if (Math.abs(unknownDelta) > 1e-9) return unknownDelta
    return b.evaluation.supportShots - a.evaluation.supportShots
  }

  const safe = comparisonPool
    .filter((row) => row.risk.catastrophe <= catastropheGuardrail + 1e-9)
    .sort(compareClubValue)
  const catastropheRejected = comparisonPool
    .filter((row) => row.risk.catastrophe > catastropheGuardrail + 1e-9)
    .sort((a, b) => {
      const catastropheDelta = a.risk.catastrophe - b.risk.catastrophe
      return Math.abs(catastropheDelta) > 1e-9 ? catastropheDelta : compareClubValue(a, b)
    })
  provisional.sort((a, b) => {
    const catastropheDelta = a.risk.catastrophe - b.risk.catastrophe
    return Math.abs(catastropheDelta) > 1e-9 ? catastropheDelta : compareClubValue(a, b)
  })

  const rankedUsable = [...safe, ...catastropheRejected, ...provisional]
  const usableRows: RankedClubAimChoice<T, C>[] = rankedUsable.map((row, index) => {
    const isSupported = supportAdequate(row.evaluation)
    const thinDeprioritized = supported.length > 0 && !isSupported
    const withinCatastropheGuardrail =
      !thinDeprioritized && row.risk.catastrophe <= catastropheGuardrail + 1e-9

    let decisionReason: string
    if (index === 0) {
      decisionReason = isSupported
        ? `Adequately supported (${row.evaluation.supportShots} shots); inside the catastrophe guardrail; lowest expected future strokes (${row.stateValue.expectedFutureStrokes.toFixed(3)}).`
        : `No adequately supported alternative; provisional selection from ${row.evaluation.supportShots} Stock shots with lowest safe expected future strokes (${row.stateValue.expectedFutureStrokes.toFixed(3)}).`
    } else if (thinDeprioritized) {
      decisionReason = `Provisional: ${row.evaluation.supportShots} Stock shots is below the ${policy.minimumAuthoritativeSupportShots}-shot support guardrail; supported value-ready clubs rank ahead.`
    } else if (!withinCatastropheGuardrail) {
      decisionReason = 'Rejected by the catastrophe guardrail before expected-future-strokes comparison.'
    } else {
      decisionReason = `Safe-set alternative with higher expected future strokes (${row.stateValue.expectedFutureStrokes.toFixed(3)}).`
    }

    return {
      evaluation: row.evaluation,
      rank: index + 1,
      targetFit: true,
      withinCatastropheGuardrail,
      decisionReason,
    }
  })

  unavailable.sort(
    (a, b) => Number(supportAdequate(b.evaluation)) - Number(supportAdequate(a.evaluation)),
  )
  const unavailableRows: RankedClubAimChoice<T, C>[] = unavailable.map((row, index) => ({
    evaluation: row.evaluation,
    rank: usableRows.length + index + 1,
    targetFit: false,
    withinCatastropheGuardrail: false,
    decisionReason: 'Next-state value unavailable for this club; not eligible ahead of value-ready choices.',
  }))

  return [...usableRows, ...unavailableRows]
}
