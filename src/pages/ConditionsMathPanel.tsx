import type { ClubAimEvaluation } from '../liveCaddie/aimOptimization'
import './LiveCaddieMapPolish.css'
import './LiveCaddieIA.css'
import './LiveCaddieDesignTune.css'

type ConditionsMathPanelProps = {
  evaluation: ClubAimEvaluation | null
  windMph: number
  windRelativeDeg: number
  hasLiveWind: boolean
  elevationDeltaFt: number | null
  lieUpDownDeg?: number | null
  lieLeftRightDeg?: number | null
}

type LandingElevationAwareEvaluation = ClubAimEvaluation & {
  landingElevationDeltaFt?: number | null
  landingElevationSource?: string | null
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const signedYards = (value: number | null | undefined) =>
  finite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(1)} yd` : '—'

const lateralYards = (value: number | null | undefined) => {
  if (!finite(value)) return '—'
  if (Math.abs(value) < 0.05) return '0.0 yd'
  return `${Math.abs(value).toFixed(1)} yd ${value > 0 ? 'R' : 'L'}`
}

const carrySummary = (value: number | null | undefined) => {
  if (!finite(value) || Math.abs(value) < 0.05) return 'no carry change'
  return `${Math.abs(value).toFixed(1)} yd ${value > 0 ? 'longer' : 'shorter'}`
}

const lateralSummary = (value: number | null | undefined) => {
  if (!finite(value) || Math.abs(value) < 0.05) return 'no lateral change'
  return `${Math.abs(value).toFixed(1)} yd ${value > 0 ? 'right' : 'left'}`
}

const baselineLateral = (value: number | null | undefined) => {
  if (!finite(value) || Math.abs(value) < 0.05) return 'Center'
  return `${Math.abs(value).toFixed(1)} yd ${value > 0 ? 'right' : 'left'}`
}

const pct = (value: number | null | undefined) => {
  if (!finite(value)) return '—'
  const percentage = value * 100
  if (percentage > 0 && percentage < 1) return '<1%'
  return `${Math.round(percentage)}%`
}

function AdjustmentRow({
  label,
  distance,
  lateral,
  detail,
  muted = false,
}: {
  label: string
  distance: string
  lateral: string
  detail: string
  muted?: boolean
}) {
  return (
    <div className={`live-condition-row${muted ? ' muted' : ''}`}>
      <span className="live-condition-factor">{label}</span>
      <strong className="live-condition-distance">{distance}</strong>
      <strong className="live-condition-lateral">{lateral}</strong>
      <small>{detail}</small>
    </div>
  )
}

export default function ConditionsMathPanel({
  evaluation,
  windMph,
  windRelativeDeg,
  hasLiveWind,
  elevationDeltaFt,
  lieUpDownDeg = null,
  lieLeftRightDeg = null,
}: ConditionsMathPanelProps) {
  const carryDelta = evaluation
    ? evaluation.modeledCarryYds - evaluation.stockCarryYds
    : null
  const lateralDelta = evaluation
    ? evaluation.modeledLateralBiasYds - evaluation.lateralBiasYds
    : null

  // The operative flight model applies wind + landing elevation together. For the
  // player-facing ledger, show Wind as its isolated delta and assign the remaining
  // airborne delta to Elevation. That residual includes any wind/elevation
  // interaction, so the visible rows reconcile exactly to the modeled net instead
  // of hiding part of the adjustment in the combined trajectory.
  const windCarryDelta = evaluation ? (evaluation.windCarryDeltaYds ?? 0) : null
  const windLateralDelta = evaluation ? (evaluation.windLateralDeltaYds ?? 0) : null
  const elevationCarryLedgerDelta = evaluation
    ? evaluation.airborneCarryDeltaYds - (windCarryDelta ?? 0)
    : null
  const combinedPhysicsLateralDelta = evaluation
    ? evaluation.airborneLateralDeltaYds - evaluation.altitudeLateralDeltaYds
    : null
  const elevationLateralLedgerDelta = evaluation && finite(combinedPhysicsLateralDelta)
    ? combinedPhysicsLateralDelta - (windLateralDelta ?? 0)
    : null

  const elevationAware = evaluation as LandingElevationAwareEvaluation | null
  const modeledLandingElevationDeltaFt = finite(elevationAware?.landingElevationDeltaFt)
    ? elevationAware.landingElevationDeltaFt
    : elevationDeltaFt
  const risk = evaluation?.bestCandidate?.riskProfile ?? null

  const windDetail = hasLiveWind
    ? `${windMph.toFixed(1)} mph @ ${windRelativeDeg.toFixed(0)}° relative`
    : 'No live wind input · model assumes calm'
  const elevationDetail = finite(modeledLandingElevationDeltaFt)
    ? `${modeledLandingElevationDeltaFt >= 0 ? '+' : ''}${modeledLandingElevationDeltaFt.toFixed(0)} ft to modeled carry landing${hasLiveWind ? ' · includes air interaction' : ''}`
    : 'No terrain elevation available'
  const altitudeDetail = evaluation?.airAltitudeFt != null
    ? `${Math.round(evaluation.airAltitudeFt).toLocaleString()} ft ASL · air density`
    : 'Base altitude unavailable'
  const lieDetail = finite(lieUpDownDeg) || finite(lieLeftRightDeg)
    ? 'Measured lie · flight effect not yet modeled'
    : 'Lie angle not captured yet'
  const lieDistance = finite(lieUpDownDeg)
    ? `${lieUpDownDeg >= 0 ? '+' : ''}${lieUpDownDeg.toFixed(1)}°`
    : '—'
  const lieLateral = finite(lieLeftRightDeg)
    ? `${lieLeftRightDeg >= 0 ? '+' : ''}${lieLeftRightDeg.toFixed(1)}°`
    : '—'

  const outcomeDetails = risk ? [
    ['Bunker', risk.bySurface.bunker ?? 0],
    ['Woods', risk.bySurface['deep-rough'] ?? 0],
    ['Water', risk.bySurface.water ?? 0],
    ['Penalty', risk.bySurface.penalty ?? 0],
  ].filter(([, value]) => typeof value === 'number' && value > 0.002) as Array<[string, number]> : []

  return (
    <div className="live-conditions-shell">
      <section className="live-expected-shot-block">
        <div className="live-expected-shot-heading">
          <span>EXPECTED SHOT</span>
        </div>

        <div className="live-shot-stat-grid">
          <div>
            <span>Carry</span>
            <strong>{evaluation ? `${Math.round(evaluation.modeledCarryYds)} yd` : '—'}</strong>
          </div>
          <div>
            <span>Total</span>
            <strong>{evaluation ? `${Math.round(evaluation.modeledTotalYds)} yd` : '—'}</strong>
          </div>
          <div>
            <span>Expected finish</span>
            <strong>{evaluation ? baselineLateral(evaluation.modeledLateralBiasYds) : '—'}</strong>
          </div>
        </div>

        <div className="live-hero-outcomes">
          <div className="outcome-success"><strong>{pct(risk?.success)}</strong><span>Success</span></div>
          <div className="outcome-manageable"><strong>{pct(risk?.manageable)}</strong><span>Manageable</span></div>
          <div className="outcome-trouble"><strong>{pct(risk?.seriousTrouble)}</strong><span>Trouble</span></div>
          <div className="outcome-catastrophe"><strong>{pct(risk?.catastrophe)}</strong><span>Catastrophe</span></div>
        </div>

        {outcomeDetails.length > 0 ? (
          <div className="live-hero-outcome-detail">
            {outcomeDetails.map(([label, value]) => <span key={label}>{label} {pct(value)}</span>)}
          </div>
        ) : null}
      </section>

      <section className="live-conditions-panel">
        <div className="live-conditions-heading">
          <span>WHY THIS SHOT</span>
          <strong>
            {evaluation
              ? `${carrySummary(carryDelta)} · ${lateralSummary(lateralDelta)}`
              : 'Waiting for shot model'}
          </strong>
        </div>

        <div className="live-condition-table-head" aria-hidden="true">
          <span>FACTOR</span>
          <strong>DISTANCE</strong>
          <strong>LATERAL</strong>
        </div>

        <div className="live-condition-rows">
          <AdjustmentRow
            label="Altitude"
            distance={evaluation ? signedYards(evaluation.altitudeCarryDeltaYds) : '—'}
            lateral={evaluation ? lateralYards(evaluation.altitudeLateralDeltaYds) : '—'}
            detail={altitudeDetail}
          />
          <AdjustmentRow
            label="Elevation"
            distance={evaluation ? signedYards(elevationCarryLedgerDelta) : '—'}
            lateral={evaluation ? lateralYards(elevationLateralLedgerDelta) : '—'}
            detail={elevationDetail}
          />
          <AdjustmentRow
            label="Wind"
            distance={evaluation && hasLiveWind ? signedYards(windCarryDelta) : '—'}
            lateral={evaluation && hasLiveWind ? lateralYards(windLateralDelta) : '—'}
            detail={windDetail}
            muted={!hasLiveWind}
          />
          <AdjustmentRow
            label="Surface"
            distance={evaluation ? signedYards(evaluation.surfaceCarryDeltaYds) : '—'}
            lateral={evaluation ? lateralYards(evaluation.surfaceLateralDeltaYds) : '—'}
            detail={evaluation?.surfaceLabel ?? 'Surface unavailable'}
          />
          <AdjustmentRow
            label="Lie"
            distance={lieDistance}
            lateral={lieLateral}
            detail={lieDetail}
            muted={!finite(lieUpDownDeg) && !finite(lieLeftRightDeg)}
          />
        </div>

        <div className="live-condition-net">
          <span>NET ADJUSTMENT</span>
          <strong>{evaluation ? signedYards(carryDelta) : '—'}</strong>
          <strong>{evaluation ? lateralYards(lateralDelta) : '—'}</strong>
        </div>
      </section>
    </div>
  )
}
