import type { CourseHoleGeometry, CoursePointYds } from '../courseGeometry/types'
import {
  evaluateAimLab,
  type AimLabEnvironment,
  type ClubAimEvaluation,
} from '../liveCaddie/aimOptimization'
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

const stripHeavySamples = (evaluations: ClubAimEvaluation[]): ClubAimEvaluation[] =>
  evaluations.map((evaluation) => {
    const candidates = evaluation.candidates.map((candidate) => ({
      ...candidate,
      // The playing UI uses contours, risk-tail landings and empirical shots.
      // Keeping all 2,048 core samples per candidate would make the worker
      // response unnecessarily large and expensive to structured-clone.
      modeledSamples: [],
    }))
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
