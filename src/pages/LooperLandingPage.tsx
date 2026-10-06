import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  isBrowserGsproAccessSupported,
  loadGsproDirectoryHandle,
  queryGsproDirectoryPermission,
} from '../adapters/browserGsproAccess'
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

import looperLogoWhite from '../assets/LooperLogoWhite.png'

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
  const [rangeOpen, setRangeOpen] = useState(
    () => new URLSearchParams(window.location.search).get('openRange') === '1',
  )
  const [showWelcome, setShowWelcome] = useState(false)
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
    if (!isBrowserGsproAccessSupported()) {
      setGsproState('unsupported')
      setShowWelcome(false)
      return
    }

    setGsproState('checking')

    try {
      const handle = await loadGsproDirectoryHandle()
      if (!handle) {
        setGsproState('not-connected')
        setShowWelcome(!readOnboardingComplete())
        return
      }

      markOnboardingComplete()
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

  const connectGspro = (openRangeAfter = false) => {
    const suffix = openRangeAfter ? '?return=range' : ''
    navigateWithinApp(`/gspro-setup${suffix}`)
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
    markOnboardingComplete()
    setShowWelcome(false)
    navigateWithinApp('/dashboard')
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
          GSPro connected
        </button>
      )
    }

    if (gsproState === 'unsupported') {
      return (
        <div className="looper-landing-gspro-status is-neutral">
          GSPro direct connection is available on your simulator PC in Chrome or Edge.
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
      <div className="looper-landing-gspro-alert">
        <div>
          <strong>{heading}</strong>
          <span>
            {gsproState === 'not-connected'
              ? ' Connect your GSPro folder to use Practice Range.'
              : ' Reconnect the saved GSPro folder to use Practice Range.'}
          </span>
        </div>
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

          <a className="looper-landing-dashboard" href="/dashboard">
            Go to Dashboard
          </a>

          <div className="looper-landing-mode-grid" aria-label="GSPro modes">
            <button
              className={`looper-landing-mode-card looper-landing-mode-card--range ${rangeOpen ? 'is-selected' : ''}`}
              onClick={choosePracticeRange}
              type="button"
            >
              <span className="looper-landing-mode-kicker">GSPro</span>
              <strong>Practice Range</strong>
              <span>Capture shots, build your club data, and review the session live.</span>
            </button>

            <div className="looper-landing-mode-card looper-landing-mode-card--caddie is-disabled">
              <span className="looper-landing-coming-soon">Coming Soon</span>
              <span className="looper-landing-mode-kicker">GSPro</span>
              <strong>Live Caddie</strong>
              <span>Real-time club, target, and risk guidance while you play.</span>
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

          <div className="looper-landing-utility-actions">
            <a href="/bag-setup?returnTo=%2Flooper">Edit Bag</a>
            <a href="/data-management">Manage Data</a>
          </div>

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
            <h1 id="looper-welcome-title">Connect GSPro once. Then just play.</h1>
            <p>
              Looper reads your GSPro shot data directly from this simulator PC. Choose the GSPro
              folder once and Looper can use it for Practice Range and future simulator features.
            </p>
            <button className="looper-welcome-primary" onClick={() => connectGspro(true)} type="button">
              Connect GSPro
            </button>
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
