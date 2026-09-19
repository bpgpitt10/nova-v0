import { useMemo } from 'react'
import type { CoursePointYds } from '../courseGeometry/types'
import type {
  AimCandidateEvaluation,
  ClubAimEvaluation,
} from '../liveCaddie/aimOptimization'
import { nextStateValueForAimCandidate } from '../liveCaddie/aimDecisionRanking'
import './LiveDecisionDetails.css'

type LiveDecisionDetailsProps = {
  evaluations: ClubAimEvaluation[]
  viewedEvaluation: ClubAimEvaluation | null
  inspectedCandidate: AimCandidateEvaluation | null
  ball: CoursePointYds
  target: CoursePointYds
  onInspectAim: (aimOffsetYds: number) => void
}

const pct = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const percentage = value * 100
  if (percentage > 0 && percentage < 1) return '<1%'
  return `${Math.round(percentage)}%`
}

const aimLabel = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) < 0.05) {
    return 'Center line'
  }
  return `${Math.abs(value).toFixed(Math.abs(value) >= 10 ? 0 : 1)} yd ${value < 0 ? 'left' : 'right'}`
}

const projectedStrokes = (candidate: AimCandidateEvaluation | null | undefined) =>
  candidate ? nextStateValueForAimCandidate(candidate)?.expectedFutureStrokes ?? null : null

const formatProjected = (value: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—'

const formatDelta = (value: number | null, baseline: number | null) => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    typeof baseline !== 'number' ||
    !Number.isFinite(baseline)
  ) return '—'
  const delta = value - baseline
  if (Math.abs(delta) < 0.0005) return '—'
  return `${delta > 0 ? '+' : ''}${delta.toFixed(3)}`
}

const expectedFinishLabel = (
  candidate: AimCandidateEvaluation,
  ball: CoursePointYds,
  target: CoursePointYds,
) => {
  const dx = target[0] - ball[0]
  const dy = target[1] - ball[1]
  const length = Math.hypot(dx, dy)
  if (length < 1e-9) return '—'

  const forwardX = dx / length
  const forwardY = dy / length
  const rightX = forwardY
  const rightY = -forwardX
  const landingDx = candidate.meanLanding[0] - ball[0]
  const landingDy = candidate.meanLanding[1] - ball[1]
  const lateralYds = landingDx * rightX + landingDy * rightY

  if (Math.abs(lateralYds) < 0.05) return 'Center line'
  return `${Math.abs(lateralYds).toFixed(Math.abs(lateralYds) >= 10 ? 0 : 1)} yd ${lateralYds < 0 ? 'left' : 'right'}`
}

export default function LiveDecisionDetails({
  evaluations,
  viewedEvaluation,
  inspectedCandidate,
  ball,
  target,
  onInspectAim,
}: LiveDecisionDetailsProps) {
  const rankedClubs = useMemo(
    () => [...evaluations]
      .filter((evaluation) => evaluation.decisionRank != null)
      .sort((left, right) => (left.decisionRank ?? 999) - (right.decisionRank ?? 999)),
    [evaluations],
  )

  const aimOptions = useMemo(
    () => viewedEvaluation
      ? [...viewedEvaluation.candidates]
          .filter((candidate) => candidate.decisionRank != null)
          .sort((left, right) => (left.decisionRank ?? 999) - (right.decisionRank ?? 999))
          .slice(0, 5)
      : [],
    [viewedEvaluation],
  )

  if (rankedClubs.length === 0 || !viewedEvaluation) return null

  const recommendation = rankedClubs[0] ?? null
  const recommendationProjected = projectedStrokes(recommendation?.bestCandidate)
  const viewedBestProjected = projectedStrokes(viewedEvaluation.bestCandidate)
  const viewedAim = inspectedCandidate ?? viewedEvaluation.bestCandidate

  return (
    <details className="live-decision-details">
      <summary>
        <span className="live-decision-details-title">WHY THIS SHOT</span>
        <span className="live-decision-details-summary">
          {viewedEvaluation.club}
          {viewedAim ? ` · ${aimLabel(viewedAim.aimOffsetYds)}` : ''}
          {` · ${rankedClubs.length} club${rankedClubs.length === 1 ? '' : 's'} ranked`}
        </span>
      </summary>

      <div className="live-decision-details-body">
        <section className="live-decision-table-section">
          <div className="live-decision-table-heading">
            <div>
              <span className="live-kicker">CLUB OPTIONS</span>
              <h3>Club comparison</h3>
            </div>
            <small>Lower projected strokes is better</small>
          </div>
          <div className="live-decision-table-scroll">
            <table className="live-decision-table">
              <thead>
                <tr>
                  <th className="numeric">Total dist</th>
                  <th>Club</th>
                  <th>Best aim</th>
                  <th className="numeric">Success</th>
                  <th className="numeric">Trouble</th>
                  <th className="numeric">Catastrophe</th>
                  <th className="numeric">Proj. strokes</th>
                  <th className="numeric">Δ to rec</th>
                </tr>
              </thead>
              <tbody>
                {rankedClubs.map((evaluation) => {
                  const candidate = evaluation.bestCandidate
                  const risk = candidate?.riskProfile ?? null
                  const projected = projectedStrokes(candidate)
                  const isRecommended = evaluation === recommendation
                  const screened = evaluation.withinCatastropheGuardrail === false
                  return (
                    <tr
                      key={evaluation.club}
                      className={`${isRecommended ? 'recommended ' : ''}${screened ? 'screened' : ''}`}
                    >
                      <td className="numeric strong">{Math.round(evaluation.modeledTotalYds)} yd</td>
                      <td>
                        <strong>{evaluation.club}</strong>
                        {isRecommended ? <small>REC</small> : screened ? <small>SCREENED</small> : null}
                      </td>
                      <td>{aimLabel(candidate?.aimOffsetYds)}</td>
                      <td className="numeric">{pct(risk?.success)}</td>
                      <td className="numeric">{pct(risk?.seriousTrouble)}</td>
                      <td className="numeric">{pct(risk?.catastrophe)}</td>
                      <td className="numeric strong">{formatProjected(projected)}</td>
                      <td className="numeric">{formatDelta(projected, recommendationProjected)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        {aimOptions.length > 0 ? (
          <section className="live-decision-table-section">
            <div className="live-decision-table-heading">
              <div>
                <span className="live-kicker">{viewedEvaluation.club} AIM OPTIONS</span>
                <h3>Same club, different line</h3>
              </div>
              <small>Click a row to preview it on the map</small>
            </div>
            <div className="live-decision-table-scroll">
              <table className="live-decision-table live-aim-decision-table">
                <thead>
                  <tr>
                    <th>Aim</th>
                    <th>Expected finish</th>
                    <th className="numeric">Success</th>
                    <th className="numeric">Trouble</th>
                    <th className="numeric">Catastrophe</th>
                    <th className="numeric">Proj. strokes</th>
                    <th className="numeric">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {aimOptions.map((candidate) => {
                    const risk = candidate.riskProfile
                    const projected = projectedStrokes(candidate)
                    const isBest = candidate === viewedEvaluation.bestCandidate
                    const isViewed = candidate === inspectedCandidate || (!inspectedCandidate && isBest)
                    const screened = candidate.withinCatastropheGuardrail === false
                    return (
                      <tr
                        key={candidate.aimOffsetYds}
                        className={`${isViewed ? 'viewed ' : ''}${isBest ? 'recommended ' : ''}${screened ? 'screened' : ''}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`Preview ${aimLabel(candidate.aimOffsetYds)} aim line`}
                        onClick={() => onInspectAim(candidate.aimOffsetYds)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onInspectAim(candidate.aimOffsetYds)
                          }
                        }}
                      >
                        <td>
                          <strong>{aimLabel(candidate.aimOffsetYds)}</strong>
                          {isBest ? <small>BEST LINE</small> : screened ? <small>SCREENED</small> : null}
                        </td>
                        <td>{expectedFinishLabel(candidate, ball, target)}</td>
                        <td className="numeric">{pct(risk?.success)}</td>
                        <td className="numeric">{pct(risk?.seriousTrouble)}</td>
                        <td className="numeric">{pct(risk?.catastrophe)}</td>
                        <td className="numeric strong">{formatProjected(projected)}</td>
                        <td className="numeric">{formatDelta(projected, viewedBestProjected)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </details>
  )
}
