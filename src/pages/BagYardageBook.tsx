import { useMemo, useState } from 'react'
import type { Club } from '../lib/bagConfig'
import { formatMiss, type YardageBook, type YardageBookRow } from '../lib/bagYardageBook'
import './BagYardageBook.css'

type BagYardageBookProps = {
  book: YardageBook
  onOpenClub: (club: Club, variantId: string) => void
}

type CarryScale = { min: number; max: number; ticks: number[] }

const TICK_STEP = 50
const MISHIT_FLAG_RATE = 0.12

const buildScale = (book: YardageBook): CarryScale => {
  const values = book.clubs
    .flatMap((entry) => [entry.row, ...entry.variants])
    .flatMap((row) =>
      row.needsData
        ? []
        : [row.middleHalf?.low, row.middleHalf?.high, row.stock?.carry, row.pure?.carry],
    )
    .filter((value): value is number => typeof value === 'number')
  if (values.length === 0) {
    return { min: 0, max: 300, ticks: [0, 100, 200, 300] }
  }
  const min = Math.max(0, Math.floor((Math.min(...values) - 10) / TICK_STEP) * TICK_STEP)
  const max = Math.ceil((Math.max(...values) + 10) / TICK_STEP) * TICK_STEP
  const ticks: number[] = []
  for (let tick = min; tick <= max; tick += TICK_STEP) ticks.push(tick)
  return { min, max, ticks }
}

const pct = (value: number) => `${Math.round(value * 100)}%`

function CarryCell({
  value,
  tone,
}: {
  value: YardageBookRow['stock']
  tone: 'stock' | 'pure'
}) {
  if (!value) {
    return <span className="bagbook-empty">–</span>
  }
  return (
    <span className={`bagbook-carry bagbook-carry--${tone}`}>
      <strong>{Math.round(value.carry)}</strong>
      <span>/ {value.total === null ? '–' : Math.round(value.total)}</span>
    </span>
  )
}

function RangeCell({ row, scale }: { row: YardageBookRow; scale: CarryScale }) {
  const span = scale.max - scale.min || 1
  const at = (value: number) => `${((value - scale.min) / span) * 100}%`
  const band = row.middleHalf
  return (
    <div className="bagbook-range">
      <div className="bagbook-range-track" aria-hidden="true">
        <span className="bagbook-range-rule" />
        {band ? (
          <span
            className="bagbook-range-band"
            style={{ left: at(band.low), width: `calc(${at(band.high)} - ${at(band.low)})` }}
          />
        ) : null}
        {row.stock ? (
          <span className="bagbook-range-stock" style={{ left: at(row.stock.carry) }} />
        ) : null}
        {row.pure ? (
          <span className="bagbook-range-pure" style={{ left: at(row.pure.carry) }} />
        ) : null}
      </div>
      <span className="bagbook-range-text">
        {band
          ? `${Math.round(band.low)}–${Math.round(band.high)} yd (±${Math.round((band.high - band.low) / 2)})`
          : '–'}
      </span>
    </div>
  )
}

function DataRow({
  row,
  label,
  scale,
  isVariant,
  variantToggle,
  onOpen,
}: {
  row: YardageBookRow
  label: string
  scale: CarryScale
  isVariant: boolean
  variantToggle?: { open: boolean; count: number; onToggle: () => void }
  onOpen: () => void
}) {
  const call = row.trust?.call ?? 'Insufficient Data'
  const callSlug = call.toLowerCase().replace(/\s+/g, '-')
  return (
    // The whole row opens the club for mouse users; the name button is the
    // keyboard/screen-reader target, and its click simply bubbles to the row.
    <div
      className={`bagbook-row is-clickable ${isVariant ? 'is-variant' : ''}`}
      onClick={onOpen}
      role="row"
    >
      <div className="bagbook-cell bagbook-club" role="cell">
        <button
          aria-label={`Open ${label} details`}
          className="bagbook-club-open"
          type="button"
        >
          <span className="bagbook-club-name">
            {isVariant ? '↳ ' : ''}
            {label}
          </span>
          <span className="bagbook-club-sub">
            {row.swings} {row.swings === 1 ? 'swing' : 'swings'}
            {row.needsData ? ' · needs data' : ''}
          </span>
        </button>
        {variantToggle ? (
          <button
            aria-expanded={variantToggle.open}
            className="bagbook-variant-chip"
            onClick={(event) => {
              event.stopPropagation()
              variantToggle.onToggle()
            }}
            type="button"
          >
            {variantToggle.open
              ? 'Hide variants'
              : `+${variantToggle.count} variant${variantToggle.count === 1 ? '' : 's'}`}
          </button>
        ) : null}
      </div>

      {row.needsData ? (
        <div className="bagbook-cell bagbook-needs-data" role="cell">
          Not in the yardage book until it has 4 good swings. Hit a few on the range to add it.
        </div>
      ) : (
        <>
          <div className="bagbook-cell" role="cell">
            <CarryCell tone="stock" value={row.stock} />
          </div>
          <div className="bagbook-cell" role="cell">
            <CarryCell tone="pure" value={row.pure} />
          </div>
          <div className="bagbook-cell" role="cell">
            <RangeCell row={row} scale={scale} />
          </div>
          <div className="bagbook-cell bagbook-miss" role="cell">
            {formatMiss(row.missOffline)}
          </div>
          <div className="bagbook-cell bagbook-trust" role="cell">
            <span className={`caddie-call-pill caddie-call-${callSlug}`}>
              {call === 'Insufficient Data' ? 'Needs Data' : call}
            </span>
            <span className="bagbook-trust-score">
              {row.trust ? Math.round(row.trust.score) : '–'}
            </span>
          </div>
          <div className="bagbook-cell bagbook-mishits" role="cell">
            {row.mishits ? (
              <>
                <span className={row.mishits.rate >= MISHIT_FLAG_RATE ? 'is-high' : undefined}>
                  {pct(row.mishits.rate)}
                </span>
                <span className="bagbook-mishits-severe">
                  {row.mishits.severeRate > 0 ? `${pct(row.mishits.severeRate)} severe` : 'none severe'}
                </span>
              </>
            ) : (
              <span className="bagbook-empty" title="Not enough swings for the classifier yet">
                –
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default function BagYardageBook({ book, onOpenClub }: BagYardageBookProps) {
  const [showAllVariants, setShowAllVariants] = useState(false)
  const [expanded, setExpanded] = useState<Set<Club>>(() => new Set())
  const scale = useMemo(() => buildScale(book), [book])
  const anyVariants = book.clubs.some((entry) => entry.variants.length > 0)
  const span = scale.max - scale.min || 1

  const toggleClub = (club: Club) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(club)) next.delete(club)
      else next.add(club)
      return next
    })

  return (
    <section aria-label="Your bag" className="bagbook">
      <div className="bagbook-table-wrap">
        <div aria-label="Club yardages" className="bagbook-table" role="table">
          <div className="bagbook-row bagbook-head" role="row">
            <span className="bagbook-head-club" role="columnheader">
              Club
              {anyVariants ? (
                <button
                  aria-pressed={showAllVariants}
                  className={`bagbook-all-variants ${showAllVariants ? 'is-on' : ''}`}
                  onClick={() => setShowAllVariants((value) => !value)}
                  type="button"
                >
                  {showAllVariants ? 'Hide variants' : 'All variants'}
                </button>
              ) : null}
            </span>
            <span role="columnheader">Stock</span>
            <span role="columnheader">Pure</span>
            <span aria-label="Carry range" className="bagbook-scale" role="columnheader">
              {scale.ticks.map((tick) => (
                <span key={tick} style={{ left: `${((tick - scale.min) / span) * 100}%` }}>
                  {tick}
                </span>
              ))}
            </span>
            <span role="columnheader">Miss</span>
            <span role="columnheader">Trust</span>
            <span role="columnheader">Mishits</span>
          </div>

          {book.clubs.map((entry) => {
            const open = showAllVariants || expanded.has(entry.club)
            const usableVariants = entry.variants.filter((row) => !row.needsData).length
            return (
              <div className="bagbook-group" key={entry.club} role="rowgroup">
                <DataRow
                  isVariant={false}
                  label={entry.label}
                  onOpen={() => onOpenClub(entry.club, entry.row.variantId)}
                  row={entry.row}
                  scale={scale}
                  variantToggle={
                    entry.variants.length > 0
                      ? {
                          open,
                          count: usableVariants || entry.variants.length,
                          onToggle: () => toggleClub(entry.club),
                        }
                      : undefined
                  }
                />
                {open
                  ? entry.variants.map((row) => (
                      <DataRow
                        isVariant
                        key={row.variantId}
                        label={row.variantName}
                        onOpen={() => onOpenClub(entry.club, row.variantId)}
                        row={row}
                        scale={scale}
                      />
                    ))
                  : null}
              </div>
            )
          })}
        </div>
      </div>

      <p className="bagbook-footnote">
        <span>
          <strong>150</strong> / 157 = carry / total
        </span>
        <span>
          <i className="bagbook-legend-band" aria-hidden="true" />
          middle 50% of carries
        </span>
        <span>
          <i className="bagbook-legend-stock" aria-hidden="true" />
          Stock
        </span>
        <span>
          <i className="bagbook-legend-pure" aria-hidden="true" />
          Pure
        </span>
        <span>Mishits are left out of Stock and Pure. Trust is the Caddie Score.</span>
      </p>
    </section>
  )
}
