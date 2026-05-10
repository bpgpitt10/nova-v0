import type { Club } from '../lib/bagConfig'
import './TheReadLadderExportCard.css'

export type ReadLadderExportRow = {
  key: string
  club: Club
  clubLabel: string
  variantId: string
  variantLabel: string
  carry: number
  carryRange?: number
  total: number
  totalRange?: number
  offline: number
  offlineRange?: number
  score: number
  callTag: string
}

type TheReadLadderExportCardProps = {
  rows: ReadLadderExportRow[]
  generatedAt?: Date
}

const formatDateTime = (date: Date) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)

const formatMetric = (value: number) => Math.round(value).toString()

const formatRange = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? `±${Math.round(value)}` : '±—'

const formatOffline = (value: number) => {
  const rounded = Math.round(Math.abs(value))
  if (rounded === 0) {
    return '0'
  }

  return `${rounded}${value > 0 ? 'R' : 'L'}`
}

const caddieCallClassName = (callTag: string) => {
  const semanticTag = callTag === 'Needs Data' ? 'Insufficient Data' : callTag
  return `caddie-call-${semanticTag.toLowerCase().replace(/\s+/g, '-')}`
}

export default function TheReadLadderExportCard({
  generatedAt = new Date(),
  rows,
}: TheReadLadderExportCardProps) {
  const sortedRows = [...rows].sort((a, b) => a.carry - b.carry)

  return (
    <article className="the-read-export-card" aria-label="The Read ladder export">
      <header className="the-read-export-header">
        <div>
          <span className="the-read-export-brand">The Looper</span>
          <h1>The Read Ladder</h1>
          <p>Every Club Holds a Truth</p>
        </div>
        <time>{formatDateTime(generatedAt)}</time>
      </header>

      <section className="the-read-export-rows" aria-label="Carry sorted ladder">
        {sortedRows.map((row) => (
          <div className="the-read-export-row" key={row.key}>
            <div className="the-read-export-identity">
              <strong>{row.clubLabel}</strong>
              <span>{row.variantLabel}</span>
            </div>

            <div className="the-read-export-primary">
              <span>Carry</span>
              <strong>
                {formatMetric(row.carry)}
                <em>{formatRange(row.carryRange)}</em>
              </strong>
            </div>

            <div className="the-read-export-secondary">
              <div>
                <span>Total</span>
                <strong>
                  {formatMetric(row.total)}
                  <em>{formatRange(row.totalRange)}</em>
                </strong>
              </div>
              <div>
                <span>Offline</span>
                <strong>
                  {formatOffline(row.offline)}
                  <em>{formatRange(row.offlineRange)}</em>
                </strong>
              </div>
            </div>

            <div className="the-read-export-call">
              <strong>{row.score}</strong>
              <span className={`the-read-export-call-tag ${caddieCallClassName(row.callTag)}`}>
                {row.callTag}
              </span>
            </div>
          </div>
        ))}
      </section>

      <footer className="the-read-export-footer">
        <p>Based on saved shot history, stock profile, pure profile, and The Read Engine scoring.</p>
      </footer>
    </article>
  )
}
