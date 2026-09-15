import type { DecisionRiskProfile } from './decisionRiskProfile'

export type AimDecisionPolicy = {
  /**
   * Aim points within this absolute catastrophe-probability margin of the
   * safest aim are allowed to compete on success and severity.
   */
  catastropheToleranceAboveBest: number
  /**
   * Club selection first establishes which clubs can actually perform the
   * intended shot. A club is target-fit when its absolute modeled carry gap is
   * within this many yards of the best carry fit in the bag.
   */
  carryGapToleranceAboveBestYds: number
}

export const DEFAULT_AIM_DECISION_POLICY: AimDecisionPolicy = {
  catastropheToleranceAboveBest: 0.02,
  carryGapToleranceAboveBestYds: 12,
}

export type RiskRankableAim = {
  aimOffsetYds: number
  riskProfile: DecisionRiskProfile | null
  /** Legacy V0 utility remains a final deterministic tie-breaker only. */
  score: number | null
}

export type RankedAimChoice<T extends RiskRankableAim> = {
  candidate: T
  rank: number
  withinCatastropheGuardrail: boolean
  decisionReason: string
}

const compareRiskUtility = <T extends RiskRankableAim>(a: T, b: T) => {
  const aRisk = a.riskProfile!
  const bRisk = b.riskProfile!

  if (Math.abs(aRisk.success - bRisk.success) > 1e-9) {
    return bRisk.success - aRisk.success
  }
  if (Math.abs(aRisk.seriousTrouble - bRisk.seriousTrouble) > 1e-9) {
    return aRisk.seriousTrouble - bRisk.seriousTrouble
  }
  if (Math.abs(aRisk.unknown - bRisk.unknown) > 1e-9) {
    return aRisk.unknown - bRisk.unknown
  }
  if (Math.abs(aRisk.expectedSeverity - bRisk.expectedSeverity) > 1e-9) {
    return aRisk.expectedSeverity - bRisk.expectedSeverity
  }

  const aScore = a.score ?? Number.NEGATIVE_INFINITY
  const bScore = b.score ?? Number.NEGATIVE_INFINITY
  if (Math.abs(aScore - bScore) > 1e-9) return bScore - aScore

  return Math.abs(a.aimOffsetYds) - Math.abs(b.aimOffsetYds)
}

/**
 * Rank lateral aims for a single club.
 *
 * Catastrophe is a guardrail rather than a weighted term. Once an aim is close
 * enough to the safest catastrophe rate, the engine chooses the best golf
 * outcome inside that safe set: success first, then serious trouble, unknown
 * geometry, expected severity and finally the legacy V0 utility score.
 */
export const rankRiskAwareAimCandidates = <T extends RiskRankableAim>(
  candidates: readonly T[],
  policy: AimDecisionPolicy = DEFAULT_AIM_DECISION_POLICY,
): RankedAimChoice<T>[] => {
  const usable = candidates.filter(
    (candidate): candidate is T & { riskProfile: DecisionRiskProfile } =>
      candidate.riskProfile != null,
  )
  const unavailable = candidates.filter((candidate) => candidate.riskProfile == null)

  if (usable.length === 0) {
    return [...candidates]
      .sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY))
      .map((candidate, index) => ({
        candidate,
        rank: index + 1,
        withinCatastropheGuardrail: true,
        decisionReason: index === 0
          ? 'Full-risk profile unavailable; fell back to the legacy V0 utility score.'
          : 'Full-risk profile unavailable; legacy V0 utility fallback.',
      }))
  }

  const minCatastrophe = Math.min(...usable.map((candidate) => candidate.riskProfile.catastrophe))
  const guardrail = minCatastrophe + policy.catastropheToleranceAboveBest
  const safe = usable
    .filter((candidate) => candidate.riskProfile.catastrophe <= guardrail + 1e-9)
    .sort(compareRiskUtility)
  const outside = usable
    .filter((candidate) => candidate.riskProfile.catastrophe > guardrail + 1e-9)
    .sort((a, b) => {
      const catastropheDelta = a.riskProfile.catastrophe - b.riskProfile.catastrophe
      return Math.abs(catastropheDelta) > 1e-9 ? catastropheDelta : compareRiskUtility(a, b)
    })
  unavailable.sort(
    (a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY),
  )

  const rankedUsable: RankedAimChoice<T>[] = [...safe, ...outside].map((candidate, index) => ({
    candidate,
    rank: index + 1,
    withinCatastropheGuardrail: candidate.riskProfile.catastrophe <= guardrail + 1e-9,
    decisionReason: index === 0
      ? `Within ${(policy.catastropheToleranceAboveBest * 100).toFixed(0)} pts of the safest catastrophe rate; best success/severity profile inside that guardrail.`
      : candidate.riskProfile.catastrophe > guardrail + 1e-9
        ? 'Rejected by the catastrophe guardrail before success/severity comparison.'
        : 'Safe-set alternative with a weaker success/severity profile.',
  }))
  const unavailableRows: RankedAimChoice<T>[] = unavailable.map((candidate, index) => ({
    candidate,
    rank: rankedUsable.length + index + 1,
    withinCatastropheGuardrail: false,
    decisionReason: 'Full-risk profile unavailable for this aim; not eligible ahead of modeled choices.',
  }))

  return [...rankedUsable, ...unavailableRows]
}

export type ClubAimChoice<T extends RiskRankableAim> = {
  club: string
  modeledCarryYds: number
  targetDistanceYds: number
  bestCandidate: T | null
}

export type RankedClubAimChoice<T extends RiskRankableAim, C extends ClubAimChoice<T>> = {
  evaluation: C
  rank: number
  targetFit: boolean
  withinCatastropheGuardrail: boolean
  decisionReason: string
}

/**
 * Rank club + aim recommendations without allowing a short layup to win merely
 * because it is safest. First establish the set of clubs that can perform the
 * intended shot, then apply the same catastrophe guardrail used for aim.
 */
export const rankRiskAwareClubChoices = <
  T extends RiskRankableAim,
  C extends ClubAimChoice<T>,
>(
  evaluations: readonly C[],
  policy: AimDecisionPolicy = DEFAULT_AIM_DECISION_POLICY,
): RankedClubAimChoice<T, C>[] => {
  const usable = evaluations.filter(
    (evaluation): evaluation is C & { bestCandidate: T & { riskProfile: DecisionRiskProfile } } =>
      evaluation.bestCandidate?.riskProfile != null,
  )
  const unavailable = evaluations.filter((evaluation) => evaluation.bestCandidate?.riskProfile == null)

  if (usable.length === 0) {
    return [...evaluations]
      .sort((a, b) =>
        (b.bestCandidate?.score ?? Number.NEGATIVE_INFINITY) -
        (a.bestCandidate?.score ?? Number.NEGATIVE_INFINITY),
      )
      .map((evaluation, index) => ({
        evaluation,
        rank: index + 1,
        targetFit: true,
        withinCatastropheGuardrail: true,
        decisionReason: index === 0
          ? 'Full-risk profile unavailable; fell back to the legacy V0 utility score.'
          : 'Full-risk profile unavailable; legacy V0 utility fallback.',
      }))
  }

  const carryGap = (evaluation: C) =>
    Math.abs(evaluation.modeledCarryYds - evaluation.targetDistanceYds)
  const bestCarryGap = Math.min(...usable.map(carryGap))
  const carryGuardrail = bestCarryGap + policy.carryGapToleranceAboveBestYds
  const targetFit = usable.filter((evaluation) => carryGap(evaluation) <= carryGuardrail + 1e-9)
  const nonTargetFit = usable.filter((evaluation) => carryGap(evaluation) > carryGuardrail + 1e-9)

  const minCatastrophe = Math.min(
    ...targetFit.map((evaluation) => evaluation.bestCandidate.riskProfile.catastrophe),
  )
  const catastropheGuardrail = minCatastrophe + policy.catastropheToleranceAboveBest

  const compareClub = (
    a: C & { bestCandidate: T & { riskProfile: DecisionRiskProfile } },
    b: C & { bestCandidate: T & { riskProfile: DecisionRiskProfile } },
  ) => {
    const aRisk = a.bestCandidate.riskProfile
    const bRisk = b.bestCandidate.riskProfile
    if (Math.abs(aRisk.success - bRisk.success) > 1e-9) return bRisk.success - aRisk.success
    if (Math.abs(aRisk.seriousTrouble - bRisk.seriousTrouble) > 1e-9) {
      return aRisk.seriousTrouble - bRisk.seriousTrouble
    }
    if (Math.abs(aRisk.unknown - bRisk.unknown) > 1e-9) return aRisk.unknown - bRisk.unknown
    if (Math.abs(aRisk.expectedSeverity - bRisk.expectedSeverity) > 1e-9) {
      return aRisk.expectedSeverity - bRisk.expectedSeverity
    }
    const carryDelta = carryGap(a) - carryGap(b)
    if (Math.abs(carryDelta) > 1e-9) return carryDelta
    return (b.bestCandidate.score ?? Number.NEGATIVE_INFINITY) -
      (a.bestCandidate.score ?? Number.NEGATIVE_INFINITY)
  }

  const safe = targetFit
    .filter((evaluation) => evaluation.bestCandidate.riskProfile.catastrophe <= catastropheGuardrail + 1e-9)
    .sort(compareClub)
  const catastropheRejected = targetFit
    .filter((evaluation) => evaluation.bestCandidate.riskProfile.catastrophe > catastropheGuardrail + 1e-9)
    .sort((a, b) => {
      const catastropheDelta =
        a.bestCandidate.riskProfile.catastrophe - b.bestCandidate.riskProfile.catastrophe
      return Math.abs(catastropheDelta) > 1e-9 ? catastropheDelta : compareClub(a, b)
    })
  nonTargetFit.sort((a, b) => carryGap(a) - carryGap(b))

  const rankedUsable = [...safe, ...catastropheRejected, ...nonTargetFit]
  const usableRows: RankedClubAimChoice<T, C>[] = rankedUsable.map((evaluation, index) => {
    const isTargetFit = carryGap(evaluation) <= carryGuardrail + 1e-9
    const withinCatastropheGuardrail = isTargetFit &&
      evaluation.bestCandidate.riskProfile.catastrophe <= catastropheGuardrail + 1e-9
    return {
      evaluation,
      rank: index + 1,
      targetFit: isTargetFit,
      withinCatastropheGuardrail,
      decisionReason: index === 0
        ? `Target-fit club; within ${(policy.catastropheToleranceAboveBest * 100).toFixed(0)} pts of the safest catastrophe rate; best success/severity profile in the safe set.`
        : !isTargetFit
          ? `Outside the target-fit carry guardrail (best gap + ${policy.carryGapToleranceAboveBestYds} yd).`
          : !withinCatastropheGuardrail
            ? 'Target-fit, but rejected by the catastrophe guardrail.'
            : 'Target-fit safe-set alternative with a weaker success/severity profile.',
    }
  })

  unavailable.sort(
    (a, b) =>
      (b.bestCandidate?.score ?? Number.NEGATIVE_INFINITY) -
      (a.bestCandidate?.score ?? Number.NEGATIVE_INFINITY),
  )
  const unavailableRows: RankedClubAimChoice<T, C>[] = unavailable.map((evaluation, index) => ({
    evaluation,
    rank: usableRows.length + index + 1,
    targetFit: false,
    withinCatastropheGuardrail: false,
    decisionReason: 'Full-risk profile unavailable for this club; not eligible ahead of modeled choices.',
  }))

  return [...usableRows, ...unavailableRows]
}
