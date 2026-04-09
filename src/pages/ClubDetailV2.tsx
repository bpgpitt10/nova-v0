import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './ClubDetailV2.css'

type ComparisonDirection = 'up' | 'down'
type ComparisonTone = 'up' | 'down' | 'neutral'

export type ComponentBreakdownRow = {
  key: string
  label: string
  value?: number
  delta?: number
  direction: ComparisonDirection
  tone: ComparisonTone
}

type ShotProfileSnapshot = {
  carry?: number
  total?: number
  offlineMean?: number
  dispersion?: number
  dispersionVariability?: number
  carryVariability?: number
  spin?: number
} | null

export type ShotProfiles = {
  bestAvailable: ShotProfileSnapshot
  mostLikely: ShotProfileSnapshot
  executionGapRows: Array<{ label: string; value: string }>
  takeaway: string
}

export type DriverRow = {
  key: string
  label: string
  value?: number
  delta?: number
  direction: ComparisonDirection
  tone: ComparisonTone
  why: string
  meaning: string
}

export type MetricKey =
  | 'hla'
  | 'spinAxis'
  | 'clubPath'
  | 'faceToPath'
  | 'carry'
  | 'totalDistance'
  | 'ballSpeed'
  | 'smashFactor'
  | 'launch'
  | 'spin'
  | 'peakHeight'
  | 'descent'
  | 'dispersion'
  | 'patternStability'
  | 'distanceWindow'

export type MetricModel = {
  key: MetricKey
  group: 'direction' | 'distance' | 'flight' | 'consistency'
  label: string
  valueText: string
  deltaText: string
  trendTone: ComparisonTone
  status: string
  read: string
  trendRead: string
  chartType: 'trend' | 'distribution'
  series: number[]
}

type HeatmapMetric = {
  key: string
  label: string
  value: string
  trend: string
  tone: ComparisonTone
}

type ClubDetailV2Props = {
  clubLabel: string
  score: string
  call: string
  callClassName?: string
  looperRead: {
    primary: string
    explanation: string
    implication: string
  }
  componentBreakdown: ComponentBreakdownRow[]
  dispersionChart: ReactNode
  shotProfiles: ShotProfiles
  heatmapMetrics: HeatmapMetric[]
  patternInsight: {
    title: string
    lines: string[]
  }
  performanceDrivers: DriverRow[]
  metricModels: MetricModel[]
  defaultMetric: MetricKey
}

const sparklinePath = (values: number[], width: number, height: number) => {
  if (values.length <= 1) {
    return ''
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(max - min, 1)
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width
      const y = height - ((value - min) / range) * height
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

const distributionBars = (values: number[], bins = 10) => {
  if (values.length === 0) {
    return []
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(max - min, 1)
  const counts = new Array(bins).fill(0)
  values.forEach((value) => {
    const normalized = (value - min) / range
    const index = Math.min(bins - 1, Math.floor(normalized * bins))
    counts[index] += 1
  })
  const peak = Math.max(...counts, 1)
  return counts.map((count) => ({ count, ratio: count / peak }))
}

const toneClass = (tone: ComparisonTone) =>
  tone === 'up'
    ? 'club-v2-tone-up'
    : tone === 'down'
      ? 'club-v2-tone-down'
      : 'club-v2-tone-neutral'

const deltaLabel = (delta: number | undefined, direction: ComparisonDirection) => {
  if (typeof delta !== 'number') {
    return '—'
  }
  return `${direction === 'up' ? '↑' : '↓'} ${Math.abs(delta).toFixed(0)}`
}

const groupLabel = (group: MetricModel['group']) => {
  switch (group) {
    case 'direction':
      return 'Direction'
    case 'distance':
      return 'Distance'
    case 'flight':
      return 'Flight'
    case 'consistency':
      return 'Consistency'
  }
}

export default function ClubDetailV2({
  clubLabel,
  score,
  call,
  callClassName,
  looperRead,
  componentBreakdown,
  dispersionChart,
  shotProfiles,
  heatmapMetrics,
  patternInsight,
  performanceDrivers,
  metricModels,
  defaultMetric,
}: ClubDetailV2Props) {
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>(defaultMetric)
  const [openDriverKey, setOpenDriverKey] = useState<string | null>(null)
  const analysisRef = useRef<HTMLElement | null>(null)
  const initializedDriverRef = useRef(false)
  const selectedModel =
    metricModels.find((metric) => metric.key === selectedMetric) ?? metricModels[0] ?? null

  const groupedMetrics = useMemo(() => {
    const groups: Array<MetricModel['group']> = [
      'direction',
      'distance',
      'flight',
      'consistency',
    ]
    return groups.map((group) => ({
      group,
      rows: metricModels.filter((metric) => metric.group === group),
    }))
  }, [metricModels])

  const rankedDrivers = useMemo(
    () =>
      [...performanceDrivers].sort((left, right) => {
        const leftScore = typeof left.value === 'number' ? left.value : 101
        const rightScore = typeof right.value === 'number' ? right.value : 101
        return leftScore - rightScore
      }),
    [performanceDrivers],
  )

  useEffect(() => {
    if (initializedDriverRef.current) {
      return
    }
    if (rankedDrivers.length === 0) {
      return
    }
    setOpenDriverKey(rankedDrivers[0].key)
    initializedDriverRef.current = true
  }, [rankedDrivers])

  const onSelectMetric = (metric: MetricKey, scroll = false) => {
    setSelectedMetric(metric)
    if (scroll && analysisRef.current) {
      analysisRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const dnaOverlayModel = useMemo(() => {
    const roundUpToFive = (value: number) => Math.max(5, Math.ceil(value / 5) * 5)
    const likely = shotProfiles.mostLikely
    const best = shotProfiles.bestAvailable
    const profiles = [likely, best].filter(
      (profile): profile is NonNullable<typeof profile> => Boolean(profile),
    )
    const plot = { x: 14, y: 14, width: 412, height: 182 }
    const centerY = plot.y + plot.height / 2

    const xEnvelope = Math.max(
      ...profiles.map(
        (profile) => Math.abs(profile.offlineMean ?? 0) + Math.max(profile.dispersion ?? 0, 2),
      ),
      8,
    )
    const xExtent = roundUpToFive(xEnvelope * 1.5)
    const xScale = (yd: number) => plot.x + ((yd + xExtent) / (xExtent * 2)) * plot.width
    const xPixelsPerYard = plot.width / Math.max(xExtent * 2, 1)

    const referenceCarry = likely?.carry ?? best?.carry ?? 0
    const yMinRaw = Math.min(
      ...profiles.map(
        (profile) => (profile.carry ?? referenceCarry) - Math.max(profile.carryVariability ?? 0, 2),
      ),
      referenceCarry - 8,
    )
    const yMaxRaw = Math.max(
      ...profiles.map(
        (profile) => (profile.carry ?? referenceCarry) + Math.max(profile.carryVariability ?? 0, 2),
      ),
      referenceCarry + 8,
    )
    const yPadding = Math.max((yMaxRaw - yMinRaw) * 0.2, 4)
    const yMin = yMinRaw - yPadding
    const yMax = yMaxRaw + yPadding
    const yRange = Math.max(yMax - yMin, 1)
    const yScale = (carry: number) => plot.y + ((yMax - carry) / yRange) * plot.height
    const yVarEnvelope = Math.max(
      ...profiles.map((profile) => Math.max(profile.carryVariability ?? profile.dispersionVariability ?? 0, 2)),
      2,
    )
    const yAxisRange = roundUpToFive(Math.max(2, yVarEnvelope * 1.5))

    const buildProfile = (profile: ShotProfileSnapshot | null) => {
      if (!profile) {
        return null
      }
      const cx = xScale(profile.offlineMean ?? 0)
      const cy = yScale(profile.carry ?? referenceCarry)
      const rx = Math.max(8, (profile.dispersion ?? 2) * xPixelsPerYard)
      const ry = Math.max(
        8,
        (profile.carryVariability ?? profile.dispersionVariability ?? 2) *
          (plot.height / Math.max(yRange, 1)),
      )
      return { cx, cy, rx, ry }
    }

    const halfStep = roundUpToFive(xExtent / 2)
    const xTicks = Array.from(new Set([-xExtent, -halfStep, 0, halfStep, xExtent])).sort(
      (left, right) => left - right,
    )

    return {
      centerY,
      likelyShape: buildProfile(likely),
      bestShape: buildProfile(best),
      xScale,
      xTicks,
      yTicks: [
        {
          y: yScale(referenceCarry + yAxisRange),
          label: `+${yAxisRange.toFixed(1)} yd`,
        },
        {
          y: yScale(referenceCarry),
          label: '0',
        },
        {
          y: yScale(referenceCarry - yAxisRange),
          label: `-${yAxisRange.toFixed(1)} yd`,
        },
      ],
    }
  }, [shotProfiles.bestAvailable, shotProfiles.mostLikely])

  return (
    <section className="club-detail-v2" id="club-detail-overview">
      <article className="dashboard-card club-detail-looper-read">
        <div className="club-detail-score-col">
          <div className="club-detail-score-anchor">
            <span className="club-detail-score-label">Score</span>
            <span className="club-detail-score-value looper-read-score">{score}</span>
            <span className={callClassName ?? 'club-v2-call-pill'}>{call}</span>
          </div>
        </div>

        <div className="club-detail-read-col">
          <div className="section-kicker">The Looper&apos;s Read</div>
          <h3 className="club-detail-read-title">{clubLabel} · THE LOOPER&apos;S READ</h3>
          <p className="club-detail-read-line">{looperRead.primary}</p>
          <p className="club-detail-read-line secondary">{looperRead.explanation}</p>
          <p className="club-detail-read-line secondary">{looperRead.implication}</p>
        </div>

        <div className="club-detail-drivers-col">
          {componentBreakdown.map((row) => (
            <div className="club-detail-component-row" key={row.key}>
              <span>{row.label}</span>
              <span className="club-v2-component-value">
                <span>{typeof row.value === 'number' ? Math.round(row.value) : '-'}</span>
                <span className={toneClass(row.tone)}>{deltaLabel(row.delta, row.direction)}</span>
              </span>
            </div>
          ))}
        </div>
      </article>

      <section className="club-v2-heatmap-section" aria-label="Heatmap">
        <article className="dashboard-card club-v2-heatmap-card">{dispersionChart}</article>
        <article className="dashboard-card club-v2-heatmap-metrics">
          <div className="club-v2-pattern-insight">
            <div className="club-v2-pattern-title">{patternInsight.title}</div>
            <div className="club-v2-pattern-lines">
              {patternInsight.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
          <div className="club-v2-heatmap-metric-grid">
            {heatmapMetrics.map((metric) => (
              <div className="club-v2-heatmap-metric-card" key={metric.key}>
                <span className="club-v2-heatmap-metric-label">{metric.label}</span>
                <span className="club-v2-heatmap-metric-value">{metric.value}</span>
                <span className={`club-v2-heatmap-metric-trend ${toneClass(metric.tone)}`}>
                  {metric.trend}
                </span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="club-v2-dna-drivers" aria-label="Shot DNA and Performance Drivers">
        <article className="dashboard-card club-v2-profile-card">
          <div className="club-v2-dna-header">Shot DNA: Most Likely vs Best Available</div>
          <div className="club-v2-profile-overlay-visual">
            <svg viewBox="0 0 440 220" aria-label="Most likely versus best available overlay">
              <rect
                x="14"
                y="14"
                width="412"
                height="182"
                rx="12"
                fill="rgba(9,16,12,0.45)"
                stroke="rgba(205,218,207,0.16)"
              />
              <line
                x1="14"
                x2="426"
                y1={dnaOverlayModel.centerY}
                y2={dnaOverlayModel.centerY}
                className="club-v2-overlay-gridline"
              />
              <line
                x1={dnaOverlayModel.xScale(0)}
                x2={dnaOverlayModel.xScale(0)}
                y1="20"
                y2="190"
                className="club-v2-overlay-gridline"
              />
              {dnaOverlayModel.likelyShape && (
                <>
                  <ellipse
                    cx={dnaOverlayModel.likelyShape.cx}
                    cy={dnaOverlayModel.likelyShape.cy}
                    rx={dnaOverlayModel.likelyShape.rx}
                    ry={dnaOverlayModel.likelyShape.ry}
                    fill="rgba(244, 201, 90, 0.3)"
                    stroke="rgba(244, 201, 90, 0.74)"
                  />
                  <text
                    className="club-v2-overlay-ellipse-label likely"
                    x={dnaOverlayModel.likelyShape.cx - dnaOverlayModel.likelyShape.rx + 4}
                    y={dnaOverlayModel.likelyShape.cy - dnaOverlayModel.likelyShape.ry - 6}
                  >
                    Most Likely
                  </text>
                </>
              )}
              {dnaOverlayModel.bestShape && (
                <>
                  <ellipse
                    cx={dnaOverlayModel.bestShape.cx}
                    cy={dnaOverlayModel.bestShape.cy}
                    rx={dnaOverlayModel.bestShape.rx}
                    ry={dnaOverlayModel.bestShape.ry}
                    fill="rgba(126, 234, 162, 0.36)"
                    stroke="rgba(126, 234, 162, 0.86)"
                  />
                  <text
                    className="club-v2-overlay-ellipse-label best"
                    x={dnaOverlayModel.bestShape.cx - dnaOverlayModel.bestShape.rx + 4}
                    y={dnaOverlayModel.bestShape.cy - dnaOverlayModel.bestShape.ry - 6}
                  >
                    Best Available
                  </text>
                </>
              )}
              <g className="club-v2-overlay-axis">
                {dnaOverlayModel.xTicks.map((tick, index) => (
                  <text key={`tick-${tick}`} x={dnaOverlayModel.xScale(tick)} y="212">
                    {tick > 0 ? `+${tick}` : tick}
                    {index === 0 || index === dnaOverlayModel.xTicks.length - 1 ? ' yd' : ''}
                  </text>
                ))}
                {dnaOverlayModel.yTicks.map((tick) => (
                  <text
                    className="club-v2-overlay-axis-vertical"
                    key={`y-${tick.label}`}
                    x="20"
                    y={tick.y}
                  >
                    {tick.label}
                  </text>
                ))}
              </g>
            </svg>
          </div>
          <div className="club-v2-overlay-insight">
            <div className="club-v2-compare-grid club-v2-compare-labels">
              <span>Most Likely</span>
              <span>Best Available</span>
            </div>
            <div className="club-v2-compare-grid club-v2-compare-values">
              <span>
                {shotProfiles.mostLikely?.carry?.toFixed(1) ?? '-'} yd ±{' '}
                {shotProfiles.mostLikely?.dispersion?.toFixed(1) ?? '-'} yd
              </span>
              <span>
                {shotProfiles.bestAvailable?.carry?.toFixed(1) ?? '-'} yd ±{' '}
                {shotProfiles.bestAvailable?.dispersion?.toFixed(1) ?? '-'} yd
              </span>
            </div>
            <p className="club-v2-gap-takeaway">
              Tightening execution reduces dispersion more than distance.
            </p>
            {(() => {
              const support =
                shotProfiles.executionGapRows.find((row) => row.label === 'Dispersion') ??
                shotProfiles.executionGapRows.find((row) => row.label === 'Variability')
              if (!support) {
                return null
              }
              const numeric = Number.parseFloat(support.value.replace(/[^0-9.]/g, ''))
              const amount = Number.isFinite(numeric) ? `${numeric.toFixed(1)} yd` : support.value
              return <p className="club-v2-gap-support">~{amount} tighter pattern.</p>
            })()}
          </div>
        </article>

        <section className="dashboard-card club-v2-drivers" aria-label="Performance Drivers">
          <div className="club-v2-drivers-header">Performance Drivers</div>
          <div className="club-v2-driver-list">
            {rankedDrivers.map((driver) => (
              <button
                className={`dashboard-card club-v2-driver-card ${openDriverKey === driver.key ? 'is-open' : ''}`}
                key={driver.key}
                onClick={() =>
                  setOpenDriverKey((current) => (current === driver.key ? null : driver.key))
                }
                type="button"
              >
                <div className="club-v2-driver-head">
                  <span>{driver.label}</span>
                  <span className="club-v2-driver-value-block">
                    <span className="club-v2-driver-value">
                      {typeof driver.value === 'number' ? Math.round(driver.value) : '-'}
                    </span>
                    {typeof driver.delta === 'number' ? (
                      <span className={toneClass(driver.tone)}>
                        {driver.direction === 'up' ? '↑' : '↓'} {Math.round(Math.abs(driver.delta))}
                      </span>
                    ) : (
                      <span className="club-v2-tone-neutral">—</span>
                    )}
                    <span className="club-v2-driver-expand-indicator" aria-hidden="true">
                      {openDriverKey === driver.key ? '−' : '+'}
                    </span>
                  </span>
                </div>
                {openDriverKey === driver.key && (
                  <>
                    <p className="club-v2-driver-insight">
                      <strong>Why:</strong> {driver.why}
                    </p>
                    <p className="club-v2-driver-trend">
                      <strong>Trend:</strong> {driver.meaning}
                    </p>
                  </>
                )}
              </button>
            ))}
          </div>
        </section>
      </section>

      <section className="club-v2-analysis" aria-label="What's Driving This" ref={analysisRef}>
        <article className="dashboard-card club-v2-analysis-card">
          <div className="section-kicker">What&apos;s Driving This</div>
          {selectedModel ? (
            <>
              <div className="club-v2-read-band-head">
                <h3>
                  {selectedModel.label}
                  <span className={`club-v2-status ${toneClass(selectedModel.trendTone)}`}>
                    {selectedModel.status}
                  </span>
                </h3>
              </div>
              <p>{selectedModel.read}</p>
              <p className="club-v2-read-trend">Trend: {selectedModel.trendRead}</p>
            </>
          ) : (
            <p>No metric read available yet.</p>
          )}

          <div className="club-v2-analysis-divider" />

          <div className="club-v2-analysis-grid">
            <div className="club-v2-metric-rail">
              {groupedMetrics.map((group) => (
                <div className="club-v2-metric-group" key={group.group}>
                  <div className="club-v2-metric-group-title">{groupLabel(group.group)}</div>
                  <div className="club-v2-metric-rows">
                    {group.rows.map((row) => (
                      <button
                        className={`club-v2-metric-row ${
                          selectedModel?.key === row.key ? 'is-active' : ''
                        }`}
                        key={row.key}
                        onClick={() => onSelectMetric(row.key)}
                        type="button"
                      >
                        <span>{row.label}</span>
                        <span>{row.valueText}</span>
                        <span className={toneClass(row.trendTone)}>{row.deltaText}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="club-v2-chart-panel">
              {selectedModel ? (
                selectedModel.chartType === 'distribution' ? (
                  <div className="club-v2-distribution">
                    {distributionBars(selectedModel.series).map((bar, index) => (
                      <div className="club-v2-bar" key={`${selectedModel.key}-bar-${index}`}>
                        <span style={{ height: `${Math.max(8, bar.ratio * 100)}%` }} />
                      </div>
                    ))}
                  </div>
                ) : selectedModel.series.length > 1 ? (
                  <svg className="club-v2-trend-svg" viewBox="0 0 520 210">
                    <path
                      className="club-v2-trend-path"
                      d={sparklinePath(selectedModel.series, 480, 160)}
                      transform="translate(20,20)"
                    />
                  </svg>
                ) : (
                  <div className="club-v2-empty">Not enough points yet.</div>
                )
              ) : (
                <div className="club-v2-empty">No selected metric.</div>
              )}
            </div>
          </div>
        </article>
      </section>
    </section>
  )
}
