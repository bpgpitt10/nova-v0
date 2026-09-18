import type { CSSProperties } from 'react'
import type { ClubAimEvaluation } from '../liveCaddie/aimOptimization'
import './LiveCaddieMapPolish.css'

type ConditionsMathPanelProps = {
  evaluation: ClubAimEvaluation | null
  windMph: number
  windRelativeDeg: number
  hasLiveWind: boolean
  elevationDeltaFt: number | null
  lieUpDownDeg?: number | null
  lieLeftRightDeg?: number | null
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const signedYards = (value: number | null | undefined) =>
  finite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(1)} yd` : '—'

const lateralYards = (value: number | null | undefined) => {
  if (!finite(value)) return '—'
  if (Math.abs(value) < 0.05) return '0.0 yd'
  return `${Math.abs(value).toFixed(1)} yd ${value > 0 ? 'right' : 'left'}`
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
  if (!finite(value) || Math.abs(value) < 0.05) return 'center'
  return `${Math.abs(value).toFixed(1)} yd ${value > 0 ? 'right' : 'left'}`
}

const shellStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  marginTop: 2,
}

const summaryStyle: CSSProperties = {
  display: 'grid',
  gap: 2,
  padding: '10px 11px',
  border: '1px solid rgba(234, 179, 8, 0.3)',
  borderRadius: 10,
  background: 'rgba(234, 179, 8, 0.075)',
}

const summaryLabelStyle: CSSProperties = {
  color: '#eab308',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
}

const summaryValueStyle: CSSProperties = {
  color: '#ffffff',
  fontSize: 16,
  fontWeight: 600,
}

const columnsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 7,
}

const columnStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  border: '1px solid rgba(49, 66, 51, 0.72)',
  borderRadius: 10,
  background: 'rgba(23, 36, 25, 0.64)',
}

const columnHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minHeight: 18,
  padding: '9px 10px 8px',
  borderBottom: '1px solid rgba(49, 66, 51, 0.55)',
}

const eyebrowStyle: CSSProperties = {
  color: '#eab308',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.08em',
  lineHeight: 1.2,
  textTransform: 'uppercase',
}

const rowsStyle: CSSProperties = {
  display: 'grid',
}

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  columnGap: 8,
  rowGap: 1,
  padding: '7px 10px',
  borderBottom: '1px solid rgba(49, 66, 51, 0.38)',
}

const rowLabelStyle: CSSProperties = {
  color: '#cfd8cd',
  fontSize: 10,
  fontWeight: 500,
}

const rowValueStyle: CSSProperties = {
  color: '#ffffff',
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const rowDetailStyle: CSSProperties = {
  gridColumn: '1 / -1',
  overflow: 'hidden',
  color: '#7f907f',
  fontSize: 8,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const totalStyle: CSSProperties = {
  display: 'grid',
  gap: 2,
  padding: '9px 10px',
  background: 'rgba(14, 23, 16, 0.42)',
}

const totalLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
}

const totalLabelStyle: CSSProperties = {
  color: '#eab308',
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
}

const totalValueStyle: CSSProperties = {
  color: '#ffffff',
  fontSize: 15,
  fontWeight: 650,
  whiteSpace: 'nowrap',
}

const totalDetailStyle: CSSProperties = {
  color: '#8fa08f',
  fontSize: 8,
}

function AdjustmentRow({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail: string
}) {
  return (
    <div style={rowStyle}>
      <span style={rowLabelStyle}>{label}</span>
      <strong style={rowValueStyle}>{value}</strong>
      <small style={rowDetailStyle}>{detail}</small>
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

  const windDetail = hasLiveWind
    ? `${windMph.toFixed(1)} mph @ ${windRelativeDeg.toFixed(0)}° relative`
    : 'no live wind input · model assumes calm'
  const elevationDetail = finite(elevationDeltaFt)
    ? `${elevationDeltaFt >= 0 ? '+' : ''}${elevationDeltaFt.toFixed(0)} ft to landing target`
    : 'no terrain elevation available'
  const altitudeDetail = evaluation?.airAltitudeFt != null
    ? `${Math.round(evaluation.airAltitudeFt).toLocaleString()} ft ASL · air density`
    : 'base altitude unavailable'

  return (
    <div style={shellStyle}>
      <div style={summaryStyle}>
        <span style={summaryLabelStyle}>Modeled conditions</span>
        <strong style={summaryValueStyle}>
          {evaluation
            ? `${carrySummary(carryDelta)} · ${lateralSummary(lateralDelta)}`
            : 'Waiting for shot model'}
        </strong>
      </div>

      <div style={columnsStyle}>
        <section style={columnStyle}>
          <div style={columnHeaderStyle}>
            <span style={eyebrowStyle}>Distance adjustment</span>
          </div>
          <div style={rowsStyle}>
            <AdjustmentRow
              label="Base altitude"
              value={evaluation ? signedYards(evaluation.altitudeCarryDeltaYds) : '—'}
              detail={altitudeDetail}
            />
            <AdjustmentRow
              label="Wind"
              value={evaluation && hasLiveWind ? signedYards(evaluation.windCarryDeltaYds ?? 0) : '—'}
              detail={windDetail}
            />
            <AdjustmentRow
              label="Elevation"
              value={evaluation ? signedYards(evaluation.elevationCarryDeltaYds ?? 0) : '—'}
              detail={elevationDetail}
            />
            <AdjustmentRow
              label="Surface"
              value={evaluation ? signedYards(evaluation.surfaceCarryDeltaYds) : '—'}
              detail={evaluation?.surfaceLabel ?? 'surface unavailable'}
            />
            <AdjustmentRow
              label="Lie up / down"
              value={finite(lieUpDownDeg) ? `${lieUpDownDeg >= 0 ? '+' : ''}${lieUpDownDeg.toFixed(1)}°` : '—'}
              detail={finite(lieUpDownDeg) ? 'measured · flight effect not yet modeled' : 'lie angle not captured yet'}
            />
          </div>
          <div style={totalStyle}>
            <div style={totalLineStyle}>
              <span style={totalLabelStyle}>Net adjustment</span>
              <strong style={totalValueStyle}>{evaluation ? signedYards(carryDelta) : '—'}</strong>
            </div>
            <span style={totalDetailStyle}>
              {evaluation
                ? `Stock ${Math.round(evaluation.stockCarryYds)} → ${Math.round(evaluation.modeledCarryYds)} yd carry`
                : 'Stock → modeled carry'}
            </span>
          </div>
        </section>

        <section style={columnStyle}>
          <div style={columnHeaderStyle}>
            <span style={eyebrowStyle}>Lateral adjustment</span>
          </div>
          <div style={rowsStyle}>
            <AdjustmentRow
              label="Base altitude"
              value={evaluation ? lateralYards(evaluation.altitudeLateralDeltaYds) : '—'}
              detail={altitudeDetail}
            />
            <AdjustmentRow
              label="Wind"
              value={evaluation && hasLiveWind ? lateralYards(evaluation.windLateralDeltaYds ?? 0) : '—'}
              detail={windDetail}
            />
            <AdjustmentRow
              label="Surface"
              value={evaluation ? lateralYards(evaluation.surfaceLateralDeltaYds) : '—'}
              detail={evaluation?.surfaceLabel ?? 'surface unavailable'}
            />
            <AdjustmentRow
              label="Lie left / right"
              value={finite(lieLeftRightDeg) ? `${lieLeftRightDeg >= 0 ? '+' : ''}${lieLeftRightDeg.toFixed(1)}°` : '—'}
              detail={finite(lieLeftRightDeg) ? 'measured · flight effect not yet modeled' : 'lie angle not captured yet'}
            />
          </div>
          <div style={totalStyle}>
            <div style={totalLineStyle}>
              <span style={totalLabelStyle}>Net adjustment</span>
              <strong style={totalValueStyle}>{evaluation ? lateralYards(lateralDelta) : '—'}</strong>
            </div>
            <span style={totalDetailStyle}>
              {evaluation
                ? `Stock bias ${baselineLateral(evaluation.lateralBiasYds)} → ${baselineLateral(evaluation.modeledLateralBiasYds)}`
                : 'Stock bias → modeled shot center'}
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}
