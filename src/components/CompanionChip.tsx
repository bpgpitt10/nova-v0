import { useState } from 'react'
import { COMPANION_DOWNLOAD_URL, COMPANION_RELEASES_PAGE, formatReleaseSize } from '../lib/companionRelease'
import type { CompanionPresence } from '../lib/companionPresence'
import { useCompanionPresence } from '../lib/useCompanionPresence'
import './CompanionChip.css'

/**
 * The companion's state on every page, next to the account chip: green when
 * it's answering, amber when a newer build exists, red when it isn't there.
 * Opens to the one thing to do about it.
 */

const label = (p: CompanionPresence): { text: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } => {
  switch (p.status) {
    case 'checking': return { text: 'Companion…', tone: 'neutral' }
    case 'connected':
      if (p.update === 'needs-update') return { text: 'Companion needs update', tone: 'bad' }
      if (p.update === 'update-available') return { text: `Companion ${p.release ?? ''} · update`, tone: 'warn' }
      return { text: `Companion ${p.release ?? 'connected'}`, tone: 'ok' }
    case 'not-running': return { text: 'Companion not running', tone: 'bad' }
    case 'not-installed': return { text: 'Get the companion', tone: 'bad' }
    case 'elsewhere': return { text: 'Companion: on your GSPro PC', tone: 'neutral' }
  }
}

export function CompanionDownloadLinks({ compact = false }: { compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(COMPANION_DOWNLOAD_URL)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      window.prompt('Copy this link:', COMPANION_DOWNLOAD_URL)
    }
  }
  return (
    <span className="companion-links">
      <a href={COMPANION_DOWNLOAD_URL}>{compact ? 'Download' : 'Download the companion (Windows)'}</a>
      <span aria-hidden="true"> · </span>
      <button type="button" onClick={() => void copy()}>{copied ? 'Link copied' : 'Copy link'}</button>
    </span>
  )
}

/**
 * The companion isn't code-signed yet, so Windows SmartScreen warns on the first
 * run. One line so nobody bounces off it. Drop this once releases are signed.
 */
export function CompanionFirstRunNote({ className = 'companion-chip__fine' }: { className?: string }) {
  return (
    <p className={className}>
      Windows will warn the first time (“Windows protected your PC”): click <strong>More info</strong>, then{' '}
      <strong>Run anyway</strong>. It's our unsigned installer, not a virus.
    </p>
  )
}

export function CompanionChip() {
  const p = useCompanionPresence()
  const { text, tone } = label(p)
  const size = formatReleaseSize(p.latest?.sizeBytes)
  return (
    <details className={`companion-chip is-${tone}`}>
      <summary className="companion-chip__summary" title="Looper Companion: the small app on your GSPro PC that reads your shots">
        <span className="companion-chip__dot" aria-hidden="true" />
        <span className="companion-chip__text">{text}</span>
      </summary>
      <div className="companion-chip__menu">
        {p.status === 'connected' && p.update === 'current' ? (
          <p>Running on this PC{p.gspro === 'connected' ? ', GSPro connected' : p.gspro === 'waiting' ? ', waiting for GSPro' : ''}. You're up to date.</p>
        ) : null}
        {p.status === 'connected' && p.update === 'update-available' && p.latest ? (
          <>
            <p>You're on {p.release}; {p.latest.release} is out{size ? ` (${size})` : ''}. Download it and run the installer again; it replaces this one.</p>
            <CompanionDownloadLinks />
            <CompanionFirstRunNote />
            <p className="companion-chip__fine"><a href={COMPANION_RELEASES_PAGE} rel="noreferrer" target="_blank">What changed</a></p>
          </>
        ) : null}
        {p.status === 'connected' && p.update === 'needs-update' && p.latest ? (
          <>
            <p>This companion ({p.release}) is too old for this version of Looper. Get {p.latest.release}, run the installer, and Looper reconnects on its own.</p>
            <CompanionDownloadLinks />
            <CompanionFirstRunNote />
          </>
        ) : null}
        {p.status === 'not-running' ? (
          <>
            <p>The companion is installed on this PC but isn't answering. Start it from the Start menu (Looper Companion) or the tray; this page reconnects on its own.</p>
            <p className="companion-chip__fine">Still nothing? Reinstall: <CompanionDownloadLinks compact /></p>
          </>
        ) : null}
        {p.status === 'not-installed' ? (
          <>
            <p>Looper reads your GSPro shots through a small app on this PC. Download it, run the installer, and this page connects on its own{size ? ` (${size})` : ''}.</p>
            <CompanionDownloadLinks />
            <CompanionFirstRunNote />
          </>
        ) : null}
        {p.status === 'elsewhere' ? (
          <>
            <p>The companion runs on your GSPro PC (Windows). Open this link there, or copy it to send to that PC.</p>
            <CompanionDownloadLinks />
            <CompanionFirstRunNote />
          </>
        ) : null}
        {p.status === 'checking' ? <p>Looking for the companion…</p> : null}
      </div>
    </details>
  )
}
