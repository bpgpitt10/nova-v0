import { useState } from 'react'
import {
  COMPANION_DOWNLOAD_URL,
  COMPANION_RELEASES_PAGE,
  companionUpdateNotice,
  isWindowsBrowser,
} from '../lib/companionRelease'
import { useCompanionPresence } from '../lib/useCompanionPresence'
import './CompanionUpdateNotice.css'

/**
 * The red box for a companion update that matters: a bug fix that affects
 * play, or a companion too old for this version of Looper. Small updates stay
 * a quiet chip. It says what was fixed in one line, what's new in one line,
 * and leaves the rest to the release notes.
 *
 * An important update can be put away for this visit and comes back on the
 * next one. A required update can't.
 */

const DISMISSED_KEY = 'looper.companion-update-dismissed'

const dismissedRelease = (): string | null => {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

export function CompanionUpdateNotice() {
  const presence = useCompanionPresence()
  const [dismissed, setDismissed] = useState<string | null>(dismissedRelease)
  if (presence.status !== 'connected') return null
  const notice = companionUpdateNotice(presence.release, presence.latest)
  if (!notice) return null
  const required = notice.level === 'required'
  if (!required && dismissed === notice.release) return null

  const dismiss = () => {
    setDismissed(notice.release)
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, notice.release)
    } catch {
      // it stays away until the page is reloaded
    }
  }

  return (
    <aside className="companion-update-notice" role="alert">
      <div className="companion-update-notice__text">
        <strong className="companion-update-notice__title">
          {required ? 'Update your Looper Companion to keep playing' : 'Important Looper Companion update'}
        </strong>
        {notice.bugFix ? <span className="companion-update-notice__line">Bug fix: {notice.bugFix}</span> : null}
        {notice.feature ? <span className="companion-update-notice__line">New: {notice.feature}</span> : null}
        {required && !notice.bugFix ? (
          <span className="companion-update-notice__line">
            This companion{notice.installed ? ` (${notice.installed})` : ''} is too old for this version of Looper.
          </span>
        ) : null}
        <span className="companion-update-notice__how">
          Download {notice.release} on your GSPro PC and run the installer. It replaces the one you have.
        </span>
      </div>
      <div className="companion-update-notice__actions">
        <a className="companion-update-notice__download" href={isWindowsBrowser() ? COMPANION_DOWNLOAD_URL : COMPANION_RELEASES_PAGE}>
          Download {notice.release}
        </a>
        <a className="companion-update-notice__notes" href={COMPANION_RELEASES_PAGE} rel="noreferrer" target="_blank">
          Full release notes
        </a>
        {required ? null : (
          <button className="companion-update-notice__later" onClick={dismiss} type="button">Later</button>
        )}
      </div>
    </aside>
  )
}
