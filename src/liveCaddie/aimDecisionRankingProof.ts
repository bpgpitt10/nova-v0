import type { DecisionRiskProfile } from './decisionRiskProfile'
import {
  rankRiskAwareAimCandidates,
  rankRiskAwareClubChoices,
  type RiskRankableAim,
} from './aimDecisionRanking'

const risk = ({
  success,
  seriousTrouble = 0,
  catastrophe = 0,
  manageable,
  unknown = 0,
}: {
  success: number
  seriousTrouble?: number
  catastrophe?: number
  manageable?: number
  unknown?: number
}): DecisionRiskProfile => ({
  bySurface: {},
  success,
  manageable: manageable ?? Math.max(0, 1 - success - seriousTrouble - catastrophe - unknown),
  seriousTrouble,
  catastrophe,
  unknown,
  expectedSeverity:
    (manageable ?? Math.max(0, 1 - success - seriousTrouble - catastrophe - unknown)) +
    seriousTrouble * 3 + catastrophe * 5 + unknown * 2,
  coreProbability: 1,
  tailProbability: 0,
  mishitProbability: 0,
  severeMishitProbability: 0,
  coreSampleCount: 2048,
  tailSampleCount: 0,
  tailLandings: [],
})

type ProofAim = RiskRankableAim & { id: string }

const aim = (
  id: string,
  aimOffsetYds: number,
  profile: DecisionRiskProfile,
  score = 0,
): ProofAim => ({ id, aimOffsetYds, riskProfile: profile, score })

export type AimDecisionRankingProofResult = {
  id: string
  description: string
  expectedWinner: string
  actualWinner: string | null
  passed: boolean
}

export const runAimDecisionRankingProofs = (): AimDecisionRankingProofResult[] => {
  const openFairway = rankRiskAwareAimCandidates([
    aim('left', -6, risk({ success: 0.8, seriousTrouble: 0.03 }), 70),
    aim('center', 0, risk({ success: 0.84, seriousTrouble: 0.03 }), 72),
    aim('right', 6, risk({ success: 0.79, seriousTrouble: 0.03 }), 69),
  ])[0]?.candidate.id ?? null

  const hazardEdge = rankRiskAwareAimCandidates([
    aim('attack', 0, risk({ success: 0.9, catastrophe: 0.08 }), 88),
    aim('safe-left', -9, risk({ success: 0.78, catastrophe: 0.01 }), 70),
    aim('balanced-left', -6, risk({ success: 0.82, catastrophe: 0.03 }), 79),
  ])[0]?.candidate.id ?? null

  const targetFit = rankRiskAwareClubChoices([
    {
      club: '7i-short',
      modeledCarryYds: 160,
      targetDistanceYds: 215,
      supportShots: 20,
      bestCandidate: aim('7i-center', 0, risk({ success: 0.96, catastrophe: 0 }), 92),
    },
    {
      club: '3H-fit',
      modeledCarryYds: 210,
      targetDistanceYds: 215,
      supportShots: 10,
      bestCandidate: aim('3h-center', 0, risk({ success: 0.76, catastrophe: 0.02 }), 73),
    },
  ])[0]?.evaluation.club ?? null

  const catastropheBeatsSmallCarryGain = rankRiskAwareClubChoices([
    {
      club: '8i-attack',
      modeledCarryYds: 151,
      targetDistanceYds: 151,
      supportShots: 20,
      bestCandidate: aim('8i-center', 0, risk({ success: 0.9, catastrophe: 0.06 }), 87),
    },
    {
      club: '7i-safe',
      modeledCarryYds: 159,
      targetDistanceYds: 151,
      supportShots: 20,
      bestCandidate: aim('7i-left', -6, risk({ success: 0.76, catastrophe: 0.01 }), 72),
    },
  ])[0]?.evaluation.club ?? null

  const supportedClubBeatsThinLuckySample = rankRiskAwareClubChoices([
    {
      club: '3W-thin',
      modeledCarryYds: 221,
      targetDistanceYds: 220,
      supportShots: 2,
      bestCandidate: aim('3w-center', 0, risk({ success: 0.93, catastrophe: 0 }), 94),
    },
    {
      club: 'Driver-supported',
      modeledCarryYds: 228,
      targetDistanceYds: 220,
      supportShots: 27,
      bestCandidate: aim('driver-left', -3, risk({ success: 0.78, catastrophe: 0.02 }), 73),
    },
  ])[0]?.evaluation.club ?? null

  const thinClubCanWinWhenOnlyDistanceFit = rankRiskAwareClubChoices([
    {
      club: '3H-thin',
      modeledCarryYds: 200,
      targetDistanceYds: 200,
      supportShots: 4,
      bestCandidate: aim('3h-center', 0, risk({ success: 0.76, catastrophe: 0.02 }), 74),
    },
    {
      club: '5i-supported-but-short',
      modeledCarryYds: 180,
      targetDistanceYds: 200,
      supportShots: 15,
      bestCandidate: aim('5i-center', 0, risk({ success: 0.95, catastrophe: 0 }), 92),
    },
  ])[0]?.evaluation.club ?? null

  return [
    {
      id: 'open-fairway-prefers-success',
      description: 'With equivalent catastrophe risk, choose the aim with the strongest success profile.',
      expectedWinner: 'center',
      actualWinner: openFairway,
      passed: openFairway === 'center',
    },
    {
      id: 'hazard-rejects-attack-line',
      description: 'A higher-success attack line cannot buy a materially larger catastrophe tail.',
      expectedWinner: 'balanced-left',
      actualWinner: hazardEdge,
      passed: hazardEdge === 'balanced-left',
    },
    {
      id: 'short-club-cannot-game-safety',
      description: 'A very short club cannot win merely because its landing pattern is safe.',
      expectedWinner: '3H-fit',
      actualWinner: targetFit,
      passed: targetFit === '3H-fit',
    },
    {
      id: 'catastrophe-beats-small-carry-gain',
      description: 'Among target-fit clubs, a small carry/proximity gain cannot buy a materially larger catastrophe rate.',
      expectedWinner: '7i-safe',
      actualWinner: catastropheBeatsSmallCarryGain,
      passed: catastropheBeatsSmallCarryGain === '7i-safe',
    },
    {
      id: 'supported-target-fit-beats-thin-lucky-sample',
      description: 'A two-shot club cannot outrank an adequately supported club when both reasonably fit the intended distance.',
      expectedWinner: 'Driver-supported',
      actualWinner: supportedClubBeatsThinLuckySample,
      passed: supportedClubBeatsThinLuckySample === 'Driver-supported',
    },
    {
      id: 'thin-club-remains-usable-when-only-distance-fit',
      description: 'Cold-start support does not make a club unusable when no adequately supported alternative fits the shot.',
      expectedWinner: '3H-thin',
      actualWinner: thinClubCanWinWhenOnlyDistanceFit,
      passed: thinClubCanWinWhenOnlyDistanceFit === '3H-thin',
    },
  ]
}

export const AIM_DECISION_RANKING_PROOFS = runAimDecisionRankingProofs()
export const AIM_DECISION_RANKING_PROOFS_PASS = AIM_DECISION_RANKING_PROOFS.every(
  (result) => result.passed,
)
