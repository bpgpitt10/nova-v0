import { useMemo } from 'react'
import type { CourseSurfaceClassification, CoursePointYds } from '../courseGeometry/types'
import type {
  AimCandidateEvaluation,
  ClubAimEvaluation,
} from '../liveCaddie/aimOptimization'
import {
  clubModelConfidence,
  nextStateValueForAimCandidate,
} from '../liveCaddie/aimDecisionRanking'
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

const stateValueFor = (candidate: AimCandidateEvaluation | null | undefined) =>
  candidate ? nextStateValueForAimCandidate(candidate) : null

const projectedFromReason = (candidate: AimCandidateEvaluation | null | undefined) => {
  const match = candidate?.decisionReason?.match(/expected future strokes \((\d+(?:\.\d+)?)\)/i)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

const projectedStrokes = (candidate: AimCandidateEvaluation | null | undefined) => {
  const value = stateValueFor(candidate)?.expectedFutureStrokes
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : projectedFromReason(candidate)
}

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

const formatYards = (value: number | null | undefined, digits = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)} yd` : '—'

const signedYards = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${value >= 0 ? '+' : ''}${value.toFixed(1)} yd`
    : '—'

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

const surfaceProbability = (
  candidate: AimCandidateEvaluation,
  kinds: CourseSurfaceClassification[],
) => kinds.reduce(
  (sum, kind) => sum + (candidate.riskProfile?.bySurface[kind] ?? 0),
  0,
)

const modelDataLabel = (evaluation: ClubAimEvaluation) => {
  const confidence = Math.round(
    clubModelConfidence(evaluation.supportShots, evaluation.supportingSessions) * 100,
  )
  return `${confidence}% · ${evaluation.supportShots} shots · ${evaluation.supportingSessions} sess`
}

const conditionPart = (label: string, detail: string) => (
  <span className="live-decision-condition" key={label}>
    <b>{label}</b>
    <span>{detail}</span>
  </span>
)

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

  const altitudeDetail = viewedEvaluation.airAltitudeFt != null
    ? `${Math.round(viewedEvaluation.airAltitudeFt).toLocaleString()} ft ASL → ${signedYards(viewedEvaluation.altitudeCarryDeltaYds)} carry`
    : `${signedYards(viewedEvaluation.altitudeCarryDeltaYds)} carry`
  const elevationDetail = `${signedYards(viewedEvaluation.elevationCarryDeltaYds)} carry`
  const windCarry = viewedEvaluation.windCarryDeltaYds ?? 0
  const windLateral = viewedEvaluation.windLateralDeltaYds ?? 0
  const windDetail = Math.abs(windCarry) < 0.05 && Math.abs(windLateral) < 0.05
    ? 'calm assumption'
    : `${signedYards(windCarry)} carry · ${signedYards(windLateral)} lateral`
  const surfaceDetail = `${viewedEvaluation.surfaceLabel} → ${signedYards(viewedEvaluation.surfaceCarryDeltaYds)} carry`

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
            <table className="live-decision-table live-club-decision-table">
              <thead>
                <tr>
                  <th>Club</th>
                  <th className="numeric">Total</th>
                  <th className="numeric">Carry</th>
                  <th>Best aim</th>
                  <th className="numeric">Exp. leave</th>
                  <th className="numeric">Success</th>
                  <th className="numeric">Manageable</th>
                  <th className="numeric">Trouble</th>
                  <th className="numeric">Catastrophe</th>
                  <th className="numeric">Mishit</th>
                  <th>Model data</th>
                  <th className="numeric">Proj. strokes</th>
                  <th className="numeric">Δ to rec</th>
                </tr>
              </thead>
              <tbody>
                {rankedClubs.map((evaluation) => {
                  const candidate = evaluation.bestCandidate
                  const risk = candidate?.riskProfile ?? null
                  const stateValue = stateValueFor(candidate)
                  const projected = projectedStrokes(candidate)
                  const isRecommended = evaluation === recommendation
                  const screened = evaluation.withinCatastropheGuardrail === false
                  return (
                    <tr
                      key={evaluation.club}
                      className={`${isRecommended ? 'recommended ' : ''}${screened ? 'screened' : ''}`}
                    >
                      <td>
                        <strong>{evaluation.club}</strong>
                        {isRecommended ? <small>REC</small> : screened ? <small>SCREENED</small> : null}
                      </td>
                      <td className="numeric strong">{formatYards(evaluation.modeledTotalYds)}</td>
                      <td className="numeric">{formatYards(evaluation.modeledCarryYds)}</td>
                      <td>{aimLabel(candidate?.aimOffsetYds)}</td>
                      <td className="numeric strong">{formatYards(stateValue?.meanDistanceToPinYds)}</td>
                      <td className="numeric">{pct(risk?.success)}</td>
                      <td className="numeric">{pct(risk?.manageable)}</td>
                      <td className="numeric">{pct(risk?.seriousTrouble)}</td>
                      <td className="numeric">{pct(risk?.catastrophe)}</td>
                      <td className="numeric">{pct(risk?.mishitProbability)}</td>
                      <td className="model-data">{modelDataLabel(evaluation)}</td>
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

            <div className="live-decision-conditions" aria-label="Conditions applied to these aim lines">
              {conditionPart('Altitude', altitudeDetail)}
              {conditionPart('Elevation', elevationDetail)}
              {conditionPart('Wind', windDetail)}
              {conditionPart('Surface', surfaceDetail)}
            </div>
            <div className="live-decision-condition-note">
              Flight-condition adjustments above are shared across these lateral aim lines; the table below exposes the different landing outcomes that drive the line choice.
            </div>

            <div className="live-decision-table-scroll">
              <table className="live-decision-table live-aim-decision-table">
                <thead>
                  <tr>
                    <th>Aim</th>
                    <th className="numeric">Elev. effect</th>
                    <th>Expected finish</th>
                    <th className="numeric">Exp. leave</th>
                    <th className="numeric">Fairway / green</th>
                    <th className="numeric">Rough</th>
                    <th className="numeric">Bunker</th>
                    <th className="numeric">Woods / recovery</th>
                    <th className="numeric">Penalty</th>
                    <th className="numeric">Catastrophe</th>
                    <th className="numeric">Proj. strokes</th>
                    <th className="numeric">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {aimOptions.map((candidate) => {
                    const risk = candidate.riskProfile
                    const stateValue = stateValueFor(candidate)
                    const projected = projectedStrokes(candidate)
                    const isBest = candidate === viewedEvaluation.bestCandidate
                    const isViewed = candidate === inspectedCandidate || (!inspectedCandidate && isBest)
                    const screened = candidate.withinCatastropheGuardrail === false
                    const fairwayOrGreen = surfaceProbability(candidate, ['fairway', 'green', 'tee'])
                    const rough = surfaceProbability(candidate, ['rough'])
                    const bunker = surfaceProbability(candidate, ['bunker'])
                    const recovery = stateValue?.byCondition.recovery?.probability
                      ?? surfaceProbability(candidate, ['deep-rough'])
                    const penalty = surfaceProbability(candidate, ['water', 'penalty'])
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
                        <td className="numeric">{signedYards(viewedEvaluation.elevationCarryDeltaYds)}</td>
                        <td>{expectedFinishLabel(candidate, ball, target)}</td>
                        <td className="numeric strong">{formatYards(stateValue?.meanDistanceToPinYds)}</td>
                        <td className="numeric">{pct(fairwayOrGreen)}</td>
                        <td className="numeric">{pct(rough)}</td>
                        <td className="numeric">{pct(bunker)}</td>
                        <td className="numeric">{pct(recovery)}</td>
                        <td className="numeric">{pct(penalty)}</td>
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
