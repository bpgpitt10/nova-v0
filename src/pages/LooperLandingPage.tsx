import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  isGsproAccessAvailable,
  loadGsproDirectoryHandle,
  queryGsproDirectoryPermission,
} from '../adapters/browserGsproAccess'
import { isCompanionGsproDirectoryHandle } from '../adapters/companionGsproFiles'
import { readLooperCompanionStatus } from '../adapters/looperCompanion'
import { markGsproConnectedOnAccount, readGsproConnectedOnAccount } from '../cloud/supabaseClient'
import { CompanionDownloadLinks, CompanionInstallSteps } from '../components/CompanionChip'
import { companionSeenBefore } from '../lib/companionPresence'
import {
  COMPANION_DOWNLOAD_URL,
  COMPANION_RELEASES_PAGE,
  companionUpdateState,
  fetchLatestCompanionRelease,
  formatReleaseSize,
  isWindowsBrowser,
  type CompanionLatest,
  type CompanionUpdateState,
} from '../lib/companionRelease'
import {
  captureBrowserGsproSessionBaseline,
  GSPRO_SESSION_BASELINE_PARAM,
  isBrowserGsproRuntimePrepared,
  prepareBrowserGsproRuntime,
} from '../adapters/browserGsproLive'
import { activeBagClubIds, getClubDisplayName, type Club } from '../lib/bagConfig'
import {
  getShotVariantsForClub,
  resolveShotVariantId,
  STOCK_SHOT_VARIANT_ID,
} from '../lib/shotVariants'
import {
  LEGACY_SESSION_FEED_PARAM,
  SESSION_SOURCE_PARAM,
  legacyFeedModeForSessionSource,
} from '../lib/sessionSources'
import './LooperLandingPage.css'

import looperLogoWhite from '../assets/LooperLogo.webp'

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'unavailable'
  | 'up-to-date'
  | 'available'
  | 'installing'
  | 'installed'
  | 'error'

type GsproConnectionState =
  | 'checking'
  | 'connected'
  | 'not-connected'
  | 'needs-permission'
  | 'unsupported'
  | 'error'

type LooperLandingPageProps = {
  installAvailableUpdate?: () => void
  onRetryUpdateCheck?: () => void
  updateError?: string | null
  updateStatus?: UpdateStatus
}

const GSPRO_ONBOARDING_KEY = 'looper-gspro-onboarding-complete-v1'

const navigateWithinApp = (path: string) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const formatShotVariantName = (name: string) =>
  name.length > 24 ? `${name.slice(0, 21)}...` : name

const readOnboardingComplete = () => {
  if (typeof window === 'undefined') {
    return false
  }
  try {
    return window.localStorage.getItem(GSPRO_ONBOARDING_KEY) === '1'
  } catch {
    return false
  }
}

const markOnboardingComplete = () => {
  try {
    window.localStorage.setItem(GSPRO_ONBOARDING_KEY, '1')
  } catch {
    // local persistence is a convenience only
  }
}

// "Not now" on the install prompt lasts for this browser session only: it comes
// back next visit until the account has connected GSPro somewhere.
const WELCOME_DISMISSED_SESSION_KEY = 'looper-welcome-dismissed-v1'

const welcomeDismissedThisSession = () => {
  try {
    return window.sessionStorage.getItem(WELCOME_DISMISSED_SESSION_KEY) === '1'
  } catch {
    return false
  }
}

const dismissWelcomeForSession = () => {
  markOnboardingComplete()
  try {
    window.sessionStorage.setItem(WELCOME_DISMISSED_SESSION_KEY, '1')
  } catch {
    // session persistence is a convenience only
  }
}

/** Show the install prompt? Asked of the account; the old per-browser flag is only the offline fallback. */
const shouldPromptForCompanion = async () => {
  if (welcomeDismissedThisSession()) return false
  const account = await readGsproConnectedOnAccount()
  return account ? !account.connected : !readOnboardingComplete()
}

export default function LooperLandingPage({
  installAvailableUpdate,
  onRetryUpdateCheck,
  updateError = null,
  updateStatus = 'idle',
}: LooperLandingPageProps = {}) {
  const [selectedClub, setSelectedClub] = useState<Club>(() => activeBagClubIds[0] ?? '7i')
  const [selectedShotVariantId, setSelectedShotVariantId] = useState<string>(
    STOCK_SHOT_VARIANT_ID,
  )
  const [gsproState, setGsproState] = useState<GsproConnectionState>('checking')
  const [gsproViaCompanion, setGsproViaCompanion] = useState(false)
  const [rangeOpen, setRangeOpen] = useState(
    () => new URLSearchParams(window.location.search).get('openRange') === '1',
  )
  const [showWelcome, setShowWelcome] = useState(false)
  const [welcomeLinkCopied, setWelcomeLinkCopied] = useState(false)
  // Companion distribution: the newest published build and how the running one compares.
  const [companionLatest, setCompanionLatest] = useState<CompanionLatest | null>(null)
  const [companionRelease, setCompanionRelease] = useState<string | null>(null)
  const onWindows = useMemo(() => isWindowsBrowser(), [])
  // A companion has answered in this browser before: silence means "not running", not "not installed".
  const seenBefore = useMemo(() => companionSeenBefore() != null, [gsproState])
  useEffect(() => {
    void fetchLatestCompanionRelease().then(setCompanionLatest)
  }, [])
  const [isStartingSession, setIsStartingSession] = useState(false)
  const [sessionStartError, setSessionStartError] = useState<string | null>(null)
  const shotVariants = useMemo(() => getShotVariantsForClub(selectedClub), [selectedClub])

  useEffect(() => {
    if (activeBagClubIds.length === 0) {
      return
    }
    if (!activeBagClubIds.includes(selectedClub)) {
      setSelectedClub(activeBagClubIds[0])
    }
  }, [selectedClub])

  useEffect(() => {
    if (!shotVariants.some((variant) => variant.id === selectedShotVariantId)) {
      setSelectedShotVariantId(STOCK_SHOT_VARIANT_ID)
    }
  }, [selectedShotVariantId, shotVariants])

  const refreshGsproStatus = useCallback(async () => {
    if (!(await isGsproAccessAvailable())) {
      // A phone, Firefox or Safari: Looper can't reach GSPro from here, but a new
      // player still needs to be told to install the companion on their GSPro PC.
      setGsproState('unsupported')
      setShowWelcome(await shouldPromptForCompanion())
      return
    }

    setGsproState('checking')

    try {
      const handle = await loadGsproDirectoryHandle()
      const viaCompanion = isCompanionGsproDirectoryHandle(handle)
      setGsproViaCompanion(viaCompanion)
      if (viaCompanion) {
        void readLooperCompanionStatus().then(
          (status) => setCompanionRelease((status as { release?: string }).release ?? status.version ?? null),
          () => setCompanionRelease(null),
        )
      }
      if (!handle) {
        setGsproState('not-connected')
        setShowWelcome(await shouldPromptForCompanion())
        return
      }

      markOnboardingComplete()
      void markGsproConnectedOnAccount()
      setShowWelcome(false)

      const permission = await queryGsproDirectoryPermission(handle, 'readwrite')
      if (permission !== 'granted') {
        setGsproState('needs-permission')
        return
      }

      const prepared = isBrowserGsproRuntimePrepared() || (await prepareBrowserGsproRuntime())
      setGsproState(prepared ? 'connected' : 'needs-permission')
    } catch (error) {
      console.error('[GSPro Connection] landing status check failed', error)
      setGsproState('error')
      setShowWelcome(false)
    }
  }, [])

  useEffect(() => {
    void refreshGsproStatus()

    const refreshOnFocus = () => void refreshGsproStatus()
    window.addEventListener('focus', refreshOnFocus)
    return () => window.removeEventListener('focus', refreshOnFocus)
  }, [refreshGsproStatus])

  const updateState: CompanionUpdateState = gsproViaCompanion ? companionUpdateState(companionRelease, companionLatest) : 'unknown'
  const downloadLabel = companionLatest
    ? `Download the companion (Windows${formatReleaseSize(companionLatest.sizeBytes) ? `, ${formatReleaseSize(companionLatest.sizeBytes)}` : ''})`
    : 'Download the companion (Windows)'

  const connectGspro = (openRangeAfter = false) => {
    const suffix = openRangeAfter ? '&return=range' : ''
    window.location.assign(`/?gsproSetup=1${suffix}`)
  }

  const choosePracticeRange = () => {
    setSessionStartError(null)
    if (gsproState !== 'connected') {
      connectGspro(true)
      return
    }
    setRangeOpen(true)
  }

  const startSession = async () => {
    setIsStartingSession(true)
    setSessionStartError(null)

    try {
      const prepared = isBrowserGsproRuntimePrepared() || (await prepareBrowserGsproRuntime())
      if (!prepared) {
        setGsproState('needs-permission')
        setIsStartingSession(false)
        connectGspro(true)
        return
      }

      const params = new URLSearchParams({
        [SESSION_SOURCE_PARAM]: 'gspro',
        [LEGACY_SESSION_FEED_PARAM]: legacyFeedModeForSessionSource('gspro'),
        club: selectedClub,
        variant: resolveShotVariantId(selectedShotVariantId),
      })

      const baselineRowId = await captureBrowserGsproSessionBaseline()
      params.set(GSPRO_SESSION_BASELINE_PARAM, String(baselineRowId))
      navigateWithinApp(`/session-intelligence?${params.toString()}`)
    } catch (error) {
      console.error('[GSPro Connection] could not start practice range session', error)
      setGsproState('needs-permission')
      setSessionStartError(
        'Looper lost access to GSPro. Reconnect the GSPro folder, then start the session again.',
      )
      setIsStartingSession(false)
    }
  }

  const continueToDashboardFromWelcome = () => {
    dismissWelcomeForSession()
    setShowWelcome(false)
    navigateWithinApp('/bag')
  }

  const copyWelcomeLink = async () => {
    try {
      await navigator.clipboard.writeText(COMPANION_DOWNLOAD_URL)
      setWelcomeLinkCopied(true)
      window.setTimeout(() => setWelcomeLinkCopied(false), 2500)
    } catch {
      window.prompt('Copy this link:', COMPANION_DOWNLOAD_URL)
    }
  }

  const updateStatusContent = (() => {
    switch (updateStatus) {
      case 'error':
        return (
          <>
            <span>Update check failed ·</span>
            <button onClick={onRetryUpdateCheck} title={updateError ?? undefined} type="button">
              Retry
            </button>
          </>
        )
      case 'available':
        return installAvailableUpdate ? (
          <>
            <span>Update available ·</span>
            <button onClick={installAvailableUpdate} type="button">
              Install
            </button>
          </>
        ) : null
      case 'installing':
        return <span>Installing update...</span>
      case 'installed':
        return <span>Update installed. Restart The Looper to finish.</span>
      case 'checking':
        return <span>Checking for updates...</span>
      default:
        return null
    }
  })()

  const connectionCallout = (() => {
    if (gsproState === 'checking') {
      return <div className="looper-landing-gspro-status is-checking">Checking GSPro connection…</div>
    }

    if (gsproState === 'connected') {
      return (
        <button
          className="looper-landing-gspro-status is-connected"
          onClick={() => connectGspro(false)}
          type="button"
        >
          <span className="looper-landing-status-dot" aria-hidden="true" />
          {gsproViaCompanion ? 'GSPro connected · Companion' : 'GSPro connected'}
          {updateState === 'update-available' && companionLatest ? (
            <a className="looper-landing-update" href={COMPANION_RELEASES_PAGE} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank">
              · update available ({companionLatest.release})
            </a>
          ) : null}
        </button>
      )
    }

    if (gsproState === 'unsupported') {
      return (
        <div className="looper-landing-gspro-status is-neutral">
          The Looper Companion runs on your GSPro PC: start it there and this page connects.{' '}
          <CompanionDownloadLinks compact />
        </div>
      )
    }

    const heading =
      gsproState === 'needs-permission'
        ? 'GSPro connection needs attention'
        : gsproState === 'error'
          ? 'Looper could not verify GSPro'
          : 'GSPro not connected'

    return (
      <div className="looper-landing-gspro-line is-warn" role="status">
        <span className="looper-landing-status-dot is-warn" aria-hidden="true" />
        <strong>{heading}</strong>
        <span>
          {seenBefore
            ? 'The companion is installed on this PC but isn’t running. Start it from the Start menu or the tray; this page reconnects on its own. '
            : onWindows
              ? 'Looper needs the companion, a small app on this PC that reads your GSPro shots. '
              : 'The companion runs on your GSPro PC. '}
          {seenBefore ? <>Reinstall: <CompanionDownloadLinks compact /></> : <CompanionDownloadLinks compact={!onWindows} />}
        </span>
        <button onClick={() => connectGspro(false)} type="button">
          {gsproState === 'not-connected' ? 'Connect GSPro' : 'Reconnect'}
        </button>
      </div>
    )
  })()

  return (
    <main className="looper-landing-page">
      <div className="looper-landing-shell">
        <section className="looper-landing-panel" aria-label="Looper entry">
          <img alt="The Looper" className="looper-landing-logo" src={looperLogoWhite} />

          {connectionCallout}
          {updateState === 'needs-update' && companionLatest ? (
            <p className="looper-landing-needs-update" role="status">
              Your Looper Companion is too old for this version of Looper.{' '}
              <a href={onWindows ? COMPANION_DOWNLOAD_URL : COMPANION_RELEASES_PAGE} rel="noreferrer" target="_blank">Get {companionLatest.release}</a>
              {' '}on your GSPro PC, then start it again.
            </p>
          ) : null}

          {/* Big screens: takes the slack so the modes sit near the bottom of the view. */}
          <div className="looper-landing-spacer" aria-hidden="true" />

          <div className="looper-landing-mode-grid" aria-label="GSPro modes">
            <button
              className={`looper-landing-mode-card looper-landing-mode-card--range ${rangeOpen ? 'is-selected' : ''}`}
              onClick={choosePracticeRange}
              type="button"
            >
              <span className="looper-landing-mode-kicker">GSPro</span>
              <strong>Practice Range</strong>
              <span className="looper-landing-mode-copy">
                Capture shots, build your club data, and review the session live.
              </span>
              <span className="looper-landing-mode-action">
                Start practice <span aria-hidden="true">→</span>
              </span>
            </button>

            <button
              className="looper-landing-mode-card looper-landing-mode-card--caddie"
              onClick={() => navigateWithinApp('/round-setup')}
              type="button"
            >
              <span className="looper-landing-mode-kicker">GSPro</span>
              <strong>Live Caddie</strong>
              <span className="looper-landing-mode-copy">
                Start a round for live club, target, and risk guidance.
              </span>
              <span className="looper-landing-mode-action">
                Start a round <span aria-hidden="true">→</span>
              </span>
            </button>

            <div className="looper-landing-mode-card looper-landing-mode-card--review">
              <span className="looper-landing-mode-kicker">Review</span>
              <strong>Yardage Book</strong>
              <span className="looper-landing-mode-copy">
                Your bag&apos;s yardages, every round shot by shot, and where you lose strokes.
              </span>
              <span className="looper-landing-mode-links">
                <a className="looper-landing-mode-action" href="/bag">
                  Bag <span aria-hidden="true">→</span>
                </a>
                <a className="looper-landing-mode-action" href="/rounds">
                  Rounds <span aria-hidden="true">→</span>
                </a>
                <a className="looper-landing-mode-action" href="/rounds/game">
                  Your game <span aria-hidden="true">→</span>
                </a>
              </span>
            </div>
          </div>

          {rangeOpen && gsproState === 'connected' ? (
            <section className="looper-landing-range-setup" aria-label="Practice Range setup">
              <div className="looper-landing-range-heading">
                <div>
                  <span>Practice Range</span>
                  <strong>Choose what you’re working on.</strong>
                </div>
                <button onClick={() => setRangeOpen(false)} type="button">Close</button>
              </div>

              {import.meta.env.DEV ? (
                <button
                  className="looper-landing-dev-session"
                  onClick={() =>
                    navigateWithinApp(
                      `/session-intelligence?source=mock&feed=mock&variant=${encodeURIComponent(resolveShotVariantId(selectedShotVariantId))}`,
                    )
                  }
                  type="button"
                >
                  DEV: Open SimRead Test Session
                </button>
              ) : null}

              <div className="looper-landing-club-variant-row">
                <label className="looper-landing-session-field">
                  <span className="looper-landing-field-label">Club</span>
                  <span className="looper-landing-select-wrap">
                    <select
                      id="landing-club-select"
                      onChange={(event) => setSelectedClub(event.target.value as Club)}
                      value={selectedClub}
                    >
                      {activeBagClubIds.map((club) => (
                        <option key={club} value={club}>
                          {getClubDisplayName(club)}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>

                <label className="looper-landing-session-field">
                  <span className="looper-landing-field-label">Variant</span>
                  <span className="looper-landing-select-wrap">
                    <select
                      aria-label="Shot variant"
                      onChange={(event) => setSelectedShotVariantId(event.target.value)}
                      title={
                        shotVariants.find((variant) => variant.id === selectedShotVariantId)
                          ?.name
                      }
                      value={selectedShotVariantId}
                    >
                      {shotVariants.map((variant) => (
                        <option key={variant.id} value={variant.id}>
                          {formatShotVariantName(variant.name)}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
              </div>

              <button
                className="looper-landing-start"
                disabled={isStartingSession}
                onClick={() => void startSession()}
                type="button"
              >
                {isStartingSession ? 'Starting…' : 'Start Practice'}
              </button>

              {sessionStartError ? (
                <p className="looper-landing-start-error" role="alert">
                  {sessionStartError}
                </p>
              ) : null}
            </section>
          ) : null}

          <nav className="looper-landing-links" aria-label="More">
            <a href="/bag-setup?returnTo=%2Flooper">Edit Bag</a>
            <a href="/data-management">Manage Data</a>
          </nav>

          {updateStatusContent ? (
            <div className="looper-landing-update-status" aria-live="polite">
              {updateStatusContent}
            </div>
          ) : null}
        </section>
      </div>

      {showWelcome ? (
        <div className="looper-welcome-backdrop" role="presentation">
          <section
            aria-labelledby="looper-welcome-title"
            aria-modal="true"
            className="looper-welcome-card"
            role="dialog"
          >
            <img alt="The Looper" className="looper-welcome-logo" src={looperLogoWhite} />
            <span className="looper-welcome-kicker">Welcome to The Looper</span>
            {onWindows ? (
              <>
                <h1 id="looper-welcome-title">Install the companion. Then just play.</h1>
                <p>
                  Looper reads your GSPro shots through the Looper Companion, a small app that runs on this PC next to GSPro. Download it, follow the steps below, and this page connects on its own.
                </p>
                <a className="looper-welcome-primary" href={COMPANION_DOWNLOAD_URL} onClick={dismissWelcomeForSession}>
                  {downloadLabel}
                </a>
                <CompanionInstallSteps className="looper-welcome-steps" />
              </>
            ) : (
              <>
                <h1 id="looper-welcome-title">Open Looper on your GSPro PC.</h1>
                <p>
                  Looper works next to GSPro on your Windows sim PC, and this isn't it. On that PC, go to <strong>thelooper.golf</strong> and sign in with this account. You'll get a one-click install for the Looper Companion, the small app that reads your shots.
                </p>
                <p className="looper-welcome-note">
                  Nothing to install on this device. Want the installer link for later?{' '}
                  <button className="looper-landing-link" onClick={() => void copyWelcomeLink()} type="button">
                    {welcomeLinkCopied ? 'Link copied' : 'Copy it'}
                  </button>
                </p>
              </>
            )}
            <button
              className="looper-welcome-secondary"
              onClick={continueToDashboardFromWelcome}
              type="button"
            >
              Go to Dashboard
            </button>
          </section>
        </div>
      ) : null}
    </main>
  )
}
