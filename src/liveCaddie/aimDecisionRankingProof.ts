import type { DecisionRiskProfile } from './decisionRiskProfile'
import type { CandidateNextStateValue } from './nextStateValue'
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

const value = (expectedFutureStrokes: number): CandidateNextStateValue => ({
  modelId: 'broadie-2012-next-state-v1',
  expectedFutureStrokes,
  valuedProbability: 1,
  unresolvedProbability: 0,
  provisionalProbability: 0,
  meanDistanceToPinYds: null,
  coreContribution: expectedFutureStrokes,
  tailContribution: 0,
  byCondition: {},
})

type ProofAim = RiskRankableAim & { id: string }

const aim = (
  id: string,
  aimOffsetYds: number,
  profile: DecisionRiskProfile,
  expectedFutureStrokes: number,
): ProofAim => ({
  id,
  aimOffsetYds,
  riskProfile: profile,
  stateValue: value(expectedFutureStrokes),
  score: 0,
})

export type AimDecisionRankingProofResult = {
  id: string
  description: string
  expectedWinner: string
  actualWinner: string | null
  passed: boolean
}

export const runAimDecisionRankingProofs = (): AimDecisionRankingProofResult[] => {
  const openFairway = rankRiskAwareAimCandidates([
    aim('left', -6, risk({ success: 0.8, seriousTrouble: 0.03 }), 3.20),
    aim('center', 0, risk({ success: 0.84, seriousTrouble: 0.03 }), 3.12),
    aim('right', 6, risk({ success: 0.79, seriousTrouble: 0.03 }), 3.18),
  ])[0]?.candidate.id ?? null

  const hazardEdge = rankRiskAwareAimCandidates([
    aim('attack', 0, risk({ success: 0.9, catastrophe: 0.08 }), 2.95),
    aim('safe-left', -9, risk({ success: 0.78, catastrophe: 0.01 }), 3.20),
    aim('balanced-left', -6, risk({ success: 0.82, catastrophe: 0.03 }), 3.10),
  ])[0]?.candidate.id ?? null

  const driverBeatsThreeWoodOnLeave = rankRiskAwareClubChoices([
    {
      club: 'Driver',
      modeledCarryYds: 250,
      targetDistanceYds: 220,
      supportShots: 25,
      bestCandidate: aim('driver-center', 0, risk({ success: 0.72, catastrophe: 0.02 }), 3.05),
    },
    {
      club: '3W',
      modeledCarryYds: 225,
      targetDistanceYds: 220,
      supportShots: 20,
      bestCandidate: aim('3w-center', 0, risk({ success: 0.84, catastrophe: 0.01 }), 3.19),
    },
  ])[0]?.evaluation.club ?? null

  const catastropheStillWins = rankRiskAwareClubChoices([
    {
      club: 'Driver',
      modeledCarryYds: 250,
      targetDistanceYds: 220,
      supportShots: 25,
      bestCandidate: aim('driver-center', 0, risk({ success: 0.8, catastrophe: 0.06 }), 2.98),
    },
    {
      club: '3W',
      modeledCarryYds: 225,
      targetDistanceYds: 220,
      supportShots: 20,
      bestCandidate: aim('3w-center', 0, risk({ success: 0.76, catastrophe: 0.01 }), 3.19),
    },
  ])[0]?.evaluation.club ?? null

  const supportedClubBeatsThinLuckySample = rankRiskAwareClubChoices([
    {
      club: '3W-thin',
      modeledCarryYds: 225,
      targetDistanceYds: 220,
      supportShots: 2,
      bestCandidate: aim('3w-center', 0, risk({ success: 0.93, catastrophe: 0 }), 2.95),
    },
    {
      club: 'Driver-supported',
      modeledCarryYds: 245,
      targetDistanceYds: 220,
      supportShots: 27,
      bestCandidate: aim('driver-left', -3, risk({ success: 0.78, catastrophe: 0.02 }), 3.05),
    },
  ])[0]?.evaluation.club ?? null

  return [
    {
      id: 'open-fairway-prefers-lower-next-state-cost',
      description: 'Inside the catastrophe guardrail, lowest expected future strokes wins.',
      expectedWinner: 'center',
      actualWinner: openFairway,
      passed: openFairway === 'center',
    },
    {
      id: 'hazard-rejects-attack-line',
      description: 'A lower expected-strokes line cannot buy a materially larger catastrophe tail.',
      expectedWinner: 'balanced-left',
      actualWinner: hazardEdge,
      passed: hazardEdge === 'balanced-left',
    },
    {
      id: 'driver-beats-three-wood-on-next-state-value',
      description: 'A longer safe club can beat a more accurate shorter club because its resulting next shot is easier.',
      expectedWinner: 'Driver',
      actualWinner: driverBeatsThreeWoodOnLeave,
      passed: driverBeatsThreeWoodOnLeave === 'Driver',
    },
    {
      id: 'catastrophe-guardrail-still-overrides-ev',
      description: 'Catastrophe remains a hard policy guardrail rather than an additive score term.',
      expectedWinner: '3W',
      actualWinner: catastropheStillWins,
      passed: catastropheStillWins === '3W',
    },
    {
      id: 'supported-model-beats-thin-lucky-sample',
      description: 'Thin samples remain provisional when a mature value-ready club model exists.',
      expectedWinner: 'Driver-supported',
      actualWinner: supportedClubBeatsThinLuckySample,
      passed: supportedClubBeatsThinLuckySample === 'Driver-supported',
    },
  ]
}

export const AIM_DECISION_RANKING_PROOFS = runAimDecisionRankingProofs()
export const AIM_DECISION_RANKING_PROOFS_PASS = AIM_DECISION_RANKING_PROOFS.every(
  (result) => result.passed,
)
