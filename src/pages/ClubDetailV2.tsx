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
  launch?: number
  hla?: number
  spin?: number
  smashFactor?: number
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

type StockPureMetricRow = {
  key: string
  label: string
  stock: string
  pure: string
}

type ClubDetailV2Props = {
  clubLabel: string
  score: string
  call: string
  swingsIncludedCount: number
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
  metricSessionSeries: Partial<Record<MetricKey, Array<{ label: string; value: number }>>>
  defaultMetric: MetricKey
}

const linePath = (
  values: number[],
  xScale: (index: number) => number,
  yScale: (value: number) => number,
) =>
  values
    .map((value, index) => {
      const x = xScale(index)
      const y = yScale(value)
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')

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

const metricUnitLabel = (key: MetricKey) => {
  switch (key) {
    case 'carry':
    case 'totalDistance':
    case 'peakHeight':
    case 'dispersion':
      return 'Yards'
    case 'spin':
      return 'RPM'
    case 'ballSpeed':
      return 'MPH'
    case 'smashFactor':
      return 'Ratio'
    case 'patternStability':
    case 'distanceWindow':
      return 'Score'
    case 'hla':
    case 'spinAxis':
    case 'clubPath':
    case 'faceToPath':
    case 'launch':
    case 'descent':
      return 'Degrees'
  }
}

const comparisonValue = (
  value: number | undefined,
  unit: 'yd' | 'rpm' | 'deg',
  digits = 1,
) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—'
  }
  if (unit === 'rpm') {
    return `${Math.round(value)} rpm`
  }
  if (unit === 'deg') {
    return `${value.toFixed(digits)}°`
  }
  return `${value.toFixed(digits)} yd`
}

const comparisonRatioValue = (value: number | undefined) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—'
  }
  return value.toFixed(2)
}

const directionalComparisonValue = (
  value: number | undefined,
  unit: 'yd' | 'deg',
  digits = 1,
) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—'
  }

  const abs = Math.abs(value)
  const suffix = abs < 0.05 ? '' : value < 0 ? ' L' : ' R'
  const formatted =
    unit === 'deg' ? `${abs.toFixed(digits)}°` : `${abs.toFixed(digits)} yd`
  return `${formatted}${suffix}`
}

export default function ClubDetailV2({
  clubLabel,
  score,
  call,
  swingsIncludedCount,
  callClassName,
  looperRead,
  componentBreakdown,
  dispersionChart,
  shotProfiles,
  heatmapMetrics: _heatmapMetrics,
  patternInsight,
  performanceDrivers,
  metricModels,
  metricSessionSeries,
  defaultMetric,
}: ClubDetailV2Props) {
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>(defaultMetric)
  const [chartMode, setChartMode] = useState<'shots' | 'sessions'>('shots')
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

  const selectedSeries = selectedModel?.series ?? []
  const chartSvg = useMemo(() => {
    if (!selectedModel) {
      return <div className="club-v2-empty">Not enough points yet.</div>
    }

    const sessionPoints = metricSessionSeries[selectedModel.key] ?? []
    const points =
      chartMode === 'sessions'
        ? sessionPoints.map((point) => ({ xLabel: point.label, value: point.value }))
        : selectedSeries.map((value, index) => ({ xLabel: `${index + 1}`, value }))

    if (points.length === 0) {
      return <div className="club-v2-empty">Not enough points yet.</div>
    }

    const width = 920
    const height = 304
    const padding = { top: 18, right: 10, bottom: 44, left: 42 }
    const chartWidth = width - padding.left - padding.right
    const chartHeight = height - padding.top - padding.bottom

    const values = points.map((point) => point.value)
    const rawMin = Math.min(...values)
    const rawMax = Math.max(...values)
    const range = Math.max(rawMax - rawMin, 1)
    const yMin = rawMin - range * 0.12
    const yMax = rawMax + range * 0.12
    const yRange = Math.max(yMax - yMin, 1)

    const xScale = (index: number) =>
      padding.left +
      (points.length === 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth)
    const yScale = (value: number) =>
      padding.top + ((yMax - value) / yRange) * chartHeight

    const yTicks = Array.from({ length: 5 }, (_, idx) => {
      const value = yMin + (idx / 4) * yRange
      return { value, y: yScale(value) }
    })
    const xTicks = Array.from({ length: Math.min(5, points.length) }, (_, idx) => {
      if (points.length === 1) {
        return { index: 0, label: '1' }
      }
      const index = Math.round((idx / (Math.min(5, points.length) - 1)) * (points.length - 1))
      return { index, label: points[index].xLabel }
    }).filter((tick, idx, arr) => arr.findIndex((t) => t.index === tick.index) === idx)

    const average =
      values.reduce((sum, value) => sum + value, 0) / values.length

    const smoothingWindow = (() => {
      if (chartMode === 'sessions') {
        return Math.min(3, points.length)
      }
      if (points.length >= 11) {
        return 11
      }
      if (points.length >= 7) {
        return 7
      }
      return Math.min(points.length, 5)
    })()

    const trendValues = points.map((_, index, rows) => {
      const start = Math.max(0, index - smoothingWindow + 1)
      const window = rows.slice(start, index + 1).map((row) => row.value)
      return window.reduce((sum, value) => sum + value, 0) / window.length
    })

    const unit = metricUnitLabel(selectedModel.key)
    const averageLabel = (() => {
      if (unit === 'RPM' || unit === 'Score') {
        return `${Math.round(average)}`
      }
      if (unit === 'Ratio') {
        return average.toFixed(2)
      }
      return average.toFixed(1)
    })()

    const averageSuffix =
      unit === 'Yards'
        ? ' yd'
        : unit === 'RPM'
          ? ' rpm'
          : unit === 'Degrees'
            ? '°'
            : unit === 'MPH'
              ? ' mph'
              : ''

    return (
      <svg className="club-v2-trend-svg" viewBox={`0 0 ${width} ${height}`}>
        {yTicks.map((tick, index) => (
          <g key={`y-grid-${index}`}>
            <line
              className="club-v2-trend-gridline"
              x1={padding.left}
              x2={width - padding.right}
              y1={tick.y}
              y2={tick.y}
            />
            <text className="club-v2-trend-y-label" x={padding.left - 8} y={tick.y}>
              {tick.value.toFixed(1)}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => {
          const x = xScale(tick.index)
          return (
            <g key={`x-${tick.index}`}>
              <line
                className="club-v2-trend-tick"
                x1={x}
                x2={x}
                y1={height - padding.bottom}
                y2={height - padding.bottom + 6}
              />
              <text className="club-v2-trend-x-label" x={x} y={height - padding.bottom + 18}>
                {tick.label}
              </text>
            </g>
          )
        })}
        <line
          className="club-v2-trend-axis"
          x1={padding.left}
          x2={padding.left}
          y1={padding.top}
          y2={height - padding.bottom}
        />
        <line
          className="club-v2-trend-axis"
          x1={padding.left}
          x2={width - padding.right}
          y1={height - padding.bottom}
          y2={height - padding.bottom}
        />
        <path
          className="club-v2-trend-raw-path"
          d={linePath(values, xScale, yScale)}
        />
        {values.map((value, index) => (
          <circle
            className="club-v2-trend-point"
            cx={xScale(index)}
            cy={yScale(value)}
            key={`p-${index}`}
            r="2.8"
          />
        ))}
        <path
          className="club-v2-trend-trendline"
          d={linePath(trendValues, xScale, yScale)}
        />
        <line
          className="club-v2-trend-average"
          x1={padding.left}
          x2={width - padding.right}
          y1={yScale(average)}
          y2={yScale(average)}
        />
        <text
          className="club-v2-trend-average-label"
          x={width - padding.right}
          y={yScale(average) - 6}
        >
          Average: {averageLabel}
          {averageSuffix}
        </text>
        <text className="club-v2-trend-axis-title" x={width / 2} y={height - 8}>
          {chartMode === 'sessions' ? 'Session' : 'Shot #'}
        </text>
        <text
          className="club-v2-trend-axis-title"
          transform={`translate(14 ${height / 2}) rotate(-90)`}
        >
          {metricUnitLabel(selectedModel.key)}
        </text>
      </svg>
    )
  }, [chartMode, metricSessionSeries, selectedModel, selectedSeries])

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

  const stockPureRows = useMemo<StockPureMetricRow[]>(
    () => [
      {
        key: 'carry',
        label: 'Carry',
        stock: comparisonValue(shotProfiles.mostLikely?.carry, 'yd', 1),
        pure: comparisonValue(shotProfiles.bestAvailable?.carry, 'yd', 1),
      },
      {
        key: 'total-distance',
        label: 'Total Distance',
        stock: comparisonValue(shotProfiles.mostLikely?.total, 'yd', 1),
        pure: comparisonValue(shotProfiles.bestAvailable?.total, 'yd', 1),
      },
      {
        key: 'offline',
        label: 'Offline',
        stock: directionalComparisonValue(shotProfiles.mostLikely?.offlineMean, 'yd', 1),
        pure: directionalComparisonValue(shotProfiles.bestAvailable?.offlineMean, 'yd', 1),
      },
      {
        key: 'launch-vla',
        label: 'Launch (VLA)',
        stock: comparisonValue(shotProfiles.mostLikely?.launch, 'deg', 1),
        pure: comparisonValue(shotProfiles.bestAvailable?.launch, 'deg', 1),
      },
      {
        key: 'start-line-hla',
        label: 'Start Line (HLA)',
        stock: directionalComparisonValue(shotProfiles.mostLikely?.hla, 'deg', 1),
        pure: directionalComparisonValue(shotProfiles.bestAvailable?.hla, 'deg', 1),
      },
      {
        key: 'spin',
        label: 'Spin',
        stock: comparisonValue(shotProfiles.mostLikely?.spin, 'rpm'),
        pure: comparisonValue(shotProfiles.bestAvailable?.spin, 'rpm'),
      },
      {
        key: 'smash-factor',
        label: 'Smash Factor',
        stock: comparisonRatioValue(shotProfiles.mostLikely?.smashFactor),
        pure: comparisonRatioValue(shotProfiles.bestAvailable?.smashFactor),
      },
    ],
    [shotProfiles.bestAvailable, shotProfiles.mostLikely],
  )

  const heatmapOverlayModel = useMemo(() => {
    const stockProfile = shotProfiles.mostLikely
    const pureProfile = shotProfiles.bestAvailable
    const profiles = [stockProfile, pureProfile].filter(
      (profile): profile is NonNullable<typeof profile> => Boolean(profile),
    )
    if (profiles.length === 0) {
      return { stockEllipse: null, pureEllipse: null }
    }

    const xEnvelope = Math.max(
      ...profiles.map(
        (profile) => Math.abs(profile.offlineMean ?? 0) + Math.max(profile.dispersion ?? 0, 2),
      ),
      8,
    )
    const xExtent = Math.max(10, xEnvelope * 1.5)

    const referenceCarry = stockProfile?.carry ?? pureProfile?.carry ?? 0
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

    const xScale = (offlineYd: number) => 50 + (offlineYd / xExtent) * 40
    const yScale = (carryYd: number) => 90 - ((carryYd - yMin) / yRange) * 80
    const xRadiusScale = (dispersionYd: number) => (dispersionYd / xExtent) * 40
    const yRadiusScale = (carryVarYd: number) => (carryVarYd / yRange) * 80

    const buildEllipse = (profile: ShotProfileSnapshot | null) => {
      if (!profile) {
        return null
      }
      return {
        cx: xScale(profile.offlineMean ?? 0),
        cy: yScale(profile.carry ?? referenceCarry),
        rx: Math.max(3.5, xRadiusScale(Math.max(profile.dispersion ?? 2, 2))),
        ry: Math.max(
          3.5,
          yRadiusScale(Math.max(profile.carryVariability ?? profile.dispersionVariability ?? 2, 2)),
        ),
      }
    }

    return {
      stockEllipse: buildEllipse(stockProfile),
      pureEllipse: buildEllipse(pureProfile),
    }
  }, [shotProfiles.bestAvailable, shotProfiles.mostLikely])

  return (
    <section className="club-detail-v2" id="club-detail-overview">
      <article className="dashboard-card club-detail-looper-read">
        <div className="club-detail-score-col">
          <div className="club-detail-score-anchor">
            <span className="club-detail-score-label">Score</span>
            <span className="club-v2-score-line">
              <span className="club-detail-score-value looper-read-score">{score}</span>
              <span className="club-v2-score-club">{clubLabel}</span>
            </span>
            <span className={callClassName ?? 'club-v2-call-pill'}>{call}</span>
          </div>
          <div className="club-v2-swings-included club-card-trend">
            {swingsIncludedCount} Swings Included
          </div>
        </div>

        <div className="club-detail-read-col">
          <div className="section-kicker">The Looper&apos;s Read</div>
          <h3 className="club-detail-read-title">THE LOOPER&apos;S READ</h3>
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
        <article className="dashboard-card club-v2-heatmap-card">
          <div className="club-v2-heatmap-visual-stack">
            {dispersionChart}
            {(heatmapOverlayModel.stockEllipse || heatmapOverlayModel.pureEllipse) && (
              <div
                aria-hidden="true"
                className="club-v2-heatmap-profile-overlay"
              >
                <svg viewBox="0 0 100 100">
                  {heatmapOverlayModel.stockEllipse && (
                    <g>
                      <ellipse
                        cx={heatmapOverlayModel.stockEllipse.cx}
                        cy={heatmapOverlayModel.stockEllipse.cy}
                        fill="rgba(244, 201, 90, 0.07)"
                        rx={heatmapOverlayModel.stockEllipse.rx}
                        ry={heatmapOverlayModel.stockEllipse.ry}
                        stroke="rgba(244, 201, 90, 0.5)"
                        strokeWidth="0.25"
                      />
                      <text
                        className="club-v2-heatmap-overlay-label stock"
                        x={heatmapOverlayModel.stockEllipse.cx}
                        y={heatmapOverlayModel.stockEllipse.cy - heatmapOverlayModel.stockEllipse.ry - 1.6}
                      >
                        Stock
                      </text>
                    </g>
                  )}
                  {heatmapOverlayModel.pureEllipse && (
                    <g>
                      <ellipse
                        cx={heatmapOverlayModel.pureEllipse.cx}
                        cy={heatmapOverlayModel.pureEllipse.cy}
                        fill="rgba(126, 234, 162, 0.07)"
                        rx={heatmapOverlayModel.pureEllipse.rx}
                        ry={heatmapOverlayModel.pureEllipse.ry}
                        stroke="rgba(126, 234, 162, 0.54)"
                        strokeWidth="0.25"
                      />
                      <text
                        className="club-v2-heatmap-overlay-label pure"
                        x={heatmapOverlayModel.pureEllipse.cx}
                        y={heatmapOverlayModel.pureEllipse.cy}
                      >
                        Pure
                      </text>
                    </g>
                  )}
                </svg>
              </div>
            )}
          </div>
        </article>
        <article className="dashboard-card club-v2-heatmap-metrics">
          <div className="club-v2-pattern-insight">
            <div className="club-v2-pattern-title">Miss Pattern</div>
            <div className="club-v2-pattern-lines">
              {patternInsight.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
          <div className="club-v2-stock-pure-panel">
            <div className="club-v2-stock-pure-header">
              <span>Stock</span>
              <span>Pure</span>
            </div>
            <div className="club-v2-stock-pure-divider" />
            <div className="club-v2-stock-pure-rows">
              {stockPureRows.map((row) => (
                <div className="club-v2-stock-pure-row" key={row.key}>
                  <div className="club-v2-stock-pure-label">{row.label}</div>
                  <div className="club-v2-stock-pure-values">
                    <span className="club-v2-stock-pure-value stock">{row.stock}</span>
                    <span className="club-v2-stock-pure-value pure">{row.pure}</span>
                  </div>
                </div>
              ))}
            </div>
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
              <div className="club-v2-chart-header">
                <div className="club-v2-chart-title">Metric Trend</div>
                <div className="club-v2-chart-toggle" role="tablist" aria-label="Trend mode">
                  <button
                    className={chartMode === 'shots' ? 'is-active' : undefined}
                    onClick={() => setChartMode('shots')}
                    type="button"
                  >
                    Shots
                  </button>
                  <button
                    className={chartMode === 'sessions' ? 'is-active' : undefined}
                    onClick={() => setChartMode('sessions')}
                    type="button"
                  >
                    Sessions
                  </button>
                </div>
              </div>
              {selectedModel ? chartSvg : <div className="club-v2-empty">No selected metric.</div>}
            </div>
          </div>
        </article>
      </section>
    </section>
  )
}
