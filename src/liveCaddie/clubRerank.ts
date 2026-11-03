import { sortClubIds, type Club } from '../lib/bagConfig'
import { rankRiskAwareClubChoices } from './aimDecisionRanking'
import type { ClubAimEvaluation } from './aimOptimization'

/**
 * Final club ranking over the whole bag. Run once on all clubs, whether they
 * were evaluated in one worker or split across several (each club's own
 * evaluation does not depend on the other clubs).
 */
export const rerankClubs = <E extends ClubAimEvaluation>(evaluations: readonly E[]): E[] => {
  // Bag order, as one worker would have produced them: ties then break the same way.
  const order = sortClubIds(evaluations.map((evaluation) => evaluation.club as Club))
  const sorted = [...evaluations].sort((a, b) => order.indexOf(a.club as Club) - order.indexOf(b.club as Club))
  const reset: E[] = sorted.map((evaluation) => ({
    ...evaluation,
    decisionRank: null,
    targetFit: null,
    withinCatastropheGuardrail: null,
    decisionReason: null,
  }))
  const ranked = rankRiskAwareClubChoices(reset)
  ranked.forEach((row) => {
    row.evaluation.decisionRank = row.rank
    row.evaluation.targetFit = row.targetFit
    row.evaluation.withinCatastropheGuardrail = row.withinCatastropheGuardrail
    row.evaluation.decisionReason = row.decisionReason
  })
  return ranked.map((row) => row.evaluation)
}
