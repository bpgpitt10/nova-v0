import type { ReactNode } from 'react'
import type { ClubAimEvaluation } from '../liveCaddie/aimOptimization'
import './LiveCaddieMapPolish.css'
import './LiveCaddieIA.css'
import './LiveCaddieDesignTune.css'
import { outcomeTiles } from '../liveCaddie/outcomeShares'

const OUTCOME_PLACEHOLDER = ['Success', 'Manageable', 'Trouble', 'Catastrophe']
  .map((label) => ({ label, percent: 0, text: '—' }))

type ConditionsMathPanelProps = {
  evaluation: ClubAimEvaluation | null
  windMph: number
  windRelativeDeg: number
  hasLiveWind: boolean
  elevationDeltaFt: number | null
  lieUpDownDeg?: number | null
  lieLeftRightDeg?: number | null
  strategyMode?: boolean
  strategyEffectiveDistanceYds?: number | null
  strategyEffectiveLateralYds?: number | null
  strategyAdjustmentScale?: number
  /** GSPro-only course: unmapped ground shows as "In play", not trouble. */
  unmappedInPlay?: boolean
  /** Read GSPro's wind again now (gusty days swirl). */
  onRefreshWind?: () => void
  windRefreshing?: boolean
  /**
   * The engine's numbers for the pick and the alternatives, serialized, so the
   * Arm bridge (liveClubAttribution) can record them with the decision.
   */
  decisionOptions?: string | null
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

const upDownLie = (value: number | null | undefined) => {
  if (!finite(value)) return '—'
  if (Math.abs(value) < 0.05) return '0.0° UP'
  return `${Math.abs(value).toFixed(1)}° ${value > 0 ? 'UP' : 'DOWN'}`
}

const leftRightLie = (value: number | null | undefined) => {
  if (!finite(value)) return '—'
  if (Math.abs(value) < 0.05) return '0.0° RIGHT'
  // Live Caddie's model convention is +LEFT / -RIGHT.
  return `${Math.abs(value).toFixed(1)}° ${value > 0 ? 'LEFT' : 'RIGHT'}`
}

function AdjustmentRow({
  label,
  distance,
  lateral,
  detail,
  muted = false,
  action = null,
}: {
  label: string
  distance: string
  lateral: string
  detail: string
  muted?: boolean
  action?: ReactNode
}) {
  return (
    <div className={`live-condition-row${muted ? ' muted' : ''}`}>
      <span className="live-condition-factor">{label}{action}</span>
      <strong className="live-condition-distance">{distance}</strong>
      <strong className="live-condition-lateral">{lateral}</strong>
      <small>{detail}</small>
    </div>
  )
}

/** Where the wind comes from, relative to the shot line, in golfer words:
 * 0° = straight in your face, 90° = from your right, 180° = from behind. */
const windFromWords = (relativeFromDeg: number): string => {
  const d = ((relativeFromDeg % 360) + 360) % 360
  const side = d < 180 ? 'right' : 'left'
  const off = d < 180 ? d : 360 - d // 0 = ahead, 90 = side, 180 = behind
  if (off < 22.5) return 'straight ahead (into you)'
  if (off > 157.5) return 'behind (helping)'
  if (off < 67.5) return `ahead and ${side} (into you, off the ${side})`
  if (off <= 112.5) return `the ${side}`
  return `behind and ${side} (helping, off the ${side})`
}

export default function ConditionsMathPanel({
  unmappedInPlay = false,
  onRefreshWind,
  windRefreshing = false,
  evaluation,
  windMph,
  windRelativeDeg,
  hasLiveWind,
  elevationDeltaFt,
  lieUpDownDeg = null,
  lieLeftRightDeg = null,
  strategyMode = false,
  strategyEffectiveDistanceYds = null,
  strategyEffectiveLateralYds = null,
  strategyAdjustmentScale = 1,
  decisionOptions = null,
}: ConditionsMathPanelProps) {
  const rawCarryDelta = evaluation
    ? evaluation.modeledCarryYds - evaluation.stockCarryYds
    : null
  const rawLateralDelta = evaluation
    ? evaluation.modeledLateralBiasYds - evaluation.lateralBiasYds
    : null
  const adjustmentScale = strategyMode
    ? Math.max(0, Math.min(1, strategyAdjustmentScale))
    : 1
  const carryDelta = finite(rawCarryDelta) ? rawCarryDelta * adjustmentScale : null
  const lateralDelta = finite(rawLateralDelta) ? rawLateralDelta * adjustmentScale : null

  // The operative flight model applies wind + landing elevation together. For the
  // player-facing ledger, show Wind as its isolated delta and assign the remaining
  // airborne delta to Elevation. That residual includes any wind/elevation
  // interaction, so the visible rows reconcile exactly to the modeled net instead
  // of hiding part of the adjustment in the combined trajectory.
  const rawWindCarryDelta = evaluation ? (evaluation.windCarryDeltaYds ?? 0) : null
  const rawWindLateralDelta = evaluation ? (evaluation.windLateralDeltaYds ?? 0) : null
  const rawElevationCarryLedgerDelta = evaluation
    ? evaluation.airborneCarryDeltaYds - (rawWindCarryDelta ?? 0)
    : null
  const windCarryDelta = finite(rawWindCarryDelta) ? rawWindCarryDelta * adjustmentScale : null
  const windLateralDelta = finite(rawWindLateralDelta) ? rawWindLateralDelta * adjustmentScale : null
  const elevationCarryLedgerDelta = finite(rawElevationCarryLedgerDelta)
    ? rawElevationCarryLedgerDelta * adjustmentScale
    : null
  const combinedPhysicsLateralDelta = evaluation
    ? evaluation.airborneLateralDeltaYds - evaluation.altitudeLateralDeltaYds
    : null
  const rawElevationLateralLedgerDelta = evaluation && finite(combinedPhysicsLateralDelta)
    ? combinedPhysicsLateralDelta - (rawWindLateralDelta ?? 0)
    : null
  const elevationLateralLedgerDelta = finite(rawElevationLateralLedgerDelta)
    ? rawElevationLateralLedgerDelta * adjustmentScale
    : null

  const elevationAware = evaluation as LandingElevationAwareEvaluation | null
  const modeledLandingElevationDeltaFt = strategyMode
    ? elevationDeltaFt
    : finite(elevationAware?.landingElevationDeltaFt)
      ? elevationAware.landingElevationDeltaFt
      : elevationDeltaFt
  const risk = evaluation?.bestCandidate?.riskProfile ?? null

  const windDetail = hasLiveWind
    ? `${windMph.toFixed(1)} mph from ${windFromWords(windRelativeDeg)} (${windRelativeDeg.toFixed(0)}°)`
    : 'No live wind input · model assumes calm'
  const elevationDetail = finite(modeledLandingElevationDeltaFt)
    ? `${modeledLandingElevationDeltaFt >= 0 ? '+' : ''}${modeledLandingElevationDeltaFt.toFixed(0)} ft to modeled carry landing${hasLiveWind ? ' · includes air interaction' : ''}`
    : 'No terrain elevation available'
  const altitudeDetail = evaluation?.airAltitudeFt != null
    ? `${Math.round(evaluation.airAltitudeFt).toLocaleString()} ft ASL · air density`
    : 'Base altitude unavailable'
  const hasLie = finite(lieUpDownDeg) || finite(lieLeftRightDeg)
  const lieUpDownLabel = upDownLie(lieUpDownDeg)
  const lieLeftRightLabel = leftRightLie(lieLeftRightDeg)
  const lieDetail = hasLie ? 'GSPro minimap lie input' : 'Lie angle not captured yet'

  const outcomeDetails = risk ? [
    ['Bunker', risk.bySurface.bunker ?? 0],
    ['Woods', risk.bySurface['deep-rough'] ?? 0],
    ['Water', risk.bySurface.water ?? 0],
    ['Penalty', risk.bySurface.penalty ?? 0],
  ].filter(([, value]) => typeof value === 'number' && value > 0.002) as Array<[string, number]> : []

  return (
    <div className="live-conditions-shell">
      <section
        className={`live-expected-shot-block${strategyMode ? ' live-strategy-shot-block' : ''}`}
        data-shot-variant={strategyMode ? 'strategy' : evaluation?.variant ?? undefined}
        data-stock-carry-yds={!strategyMode && evaluation ? String(evaluation.stockCarryYds) : undefined}
        data-planned-carry-yds={!strategyMode && evaluation ? String(evaluation.stockCarryYds) : undefined}
        data-modeled-carry-yds={!strategyMode && evaluation ? String(evaluation.modeledCarryYds) : undefined}
        data-decision-options={!strategyMode && decisionOptions ? decisionOptions : undefined}
      >
        <div className="live-expected-shot-heading">
          <span>{strategyMode ? 'SHOT REQUIREMENT' : 'EXPECTED SHOT'}</span>
        </div>

        <div className="live-shot-stat-grid">
          {strategyMode ? (
            <>
              <div>
                <span>Playing distance</span>
                <strong>{finite(strategyEffectiveDistanceYds) ? `${Math.round(strategyEffectiveDistanceYds)} yd` : '—'}</strong>
              </div>
              <div>
                <span>L/R change</span>
                <strong>{lateralYards(strategyEffectiveLateralYds)}</strong>
              </div>
              <div>
                <span>Club</span>
                <strong>Player choice</strong>
              </div>
            </>
          ) : (
            <>
              <div>
                <span>Carry</span>
                <strong>{evaluation ? `${Math.round(evaluation.modeledCarryYds)} yd` : '—'}</strong>
              </div>
              <div>
                <span>Total</span>
                <strong>{evaluation ? `${Math.round(evaluation.expectedTotalYds ?? evaluation.modeledTotalYds)} yd` : '—'}</strong>
              </div>
              <div>
                <span>Expected finish</span>
                <strong>{evaluation ? baselineLateral(evaluation.modeledLateralBiasYds) : '—'}</strong>
              </div>
            </>
          )}
        </div>

        {!strategyMode ? (
          <>
            <div className="live-hero-outcomes">
              {(outcomeTiles(risk, unmappedInPlay ? 'in-play' : 'trouble') ?? OUTCOME_PLACEHOLDER).map((tile) => (
                <div key={tile.label} className={`outcome-${tile.label.toLowerCase()}`}><strong>{tile.text}</strong><span>{tile.label}</span></div>
              ))}
            </div>

            {outcomeDetails.length > 0 ? (
              <div className="live-hero-outcome-detail">
                {outcomeDetails.map(([label, value]) => <span key={label}>{label} {pct(value)}</span>)}
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="live-conditions-panel">
        <div className="live-conditions-heading">
          <span>{strategyMode ? 'SHOT ADJUSTMENTS' : 'WHY THIS SHOT'}</span>
          <strong>
            {strategyMode && finite(strategyEffectiveDistanceYds)
              ? `Plays ${Math.round(strategyEffectiveDistanceYds)} yd · ${lateralSummary(strategyEffectiveLateralYds)}`
              : evaluation
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
            distance={evaluation ? signedYards(evaluation.altitudeCarryDeltaYds * adjustmentScale) : '—'}
            lateral={evaluation ? lateralYards(evaluation.altitudeLateralDeltaYds * adjustmentScale) : '—'}
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
            action={onRefreshWind ? (
              <button type="button" className={`live-condition-refresh${windRefreshing ? ' is-refreshing' : ''}`}
                disabled={windRefreshing} onClick={onRefreshWind}
                aria-label="Refresh wind" title="Read GSPro's wind again (it swirls on gusty days)">
                <span aria-hidden="true">↻</span>
              </button>
            ) : null}
          />
          <AdjustmentRow
            label="Surface"
            distance={evaluation ? signedYards(evaluation.surfaceCarryDeltaYds * adjustmentScale) : '—'}
            lateral={evaluation ? lateralYards(evaluation.surfaceLateralDeltaYds * adjustmentScale) : '—'}
            detail={evaluation?.surfaceLabel ?? 'Surface unavailable'}
          />
          <AdjustmentRow
            label="Lie"
            distance={hasLie ? lieUpDownLabel : '—'}
            lateral={hasLie ? lieLeftRightLabel : '—'}
            detail={lieDetail}
            muted={!hasLie}
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
