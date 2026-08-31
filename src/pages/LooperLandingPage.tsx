import { useEffect, useMemo, useState } from 'react'
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
import {
  getGsproConnectionStatus,
  isGsproBrowserFileAccessSupported,
  pickAndRememberGsproDirectory,
  prepareGsproDatabaseForSession,
  type GsproConnectionStatus,
} from '../lib/browserGsproDb'
import './LooperLandingPage.css'

import looperLogoWhite from '../assets/LooperLogoWhite.png'

const navigateWithinApp = (path: string) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const formatShotVariantName = (name: string) =>
  name.length > 24 ? `${name.slice(0, 21)}...` : name

const gsproStatusText = (status: GsproConnectionStatus | null, supported: boolean) => {
  if (!supported) {
    return 'Live GSPro sessions require desktop Chrome folder access.'
  }
  if (!status) {
    return 'Checking saved GSPro connection…'
  }
  if (status.ready) {
    return `GSPro connected${status.directoryName ? ` · ${status.directoryName}` : ''}`
  }
  if (status.remembered && status.permission === 'prompt') {
    return `GSPro folder remembered${status.directoryName ? ` · ${status.directoryName}` : ''}. Chrome may ask to allow access.`
  }
  if (status.remembered && status.permission === 'denied') {
    return 'GSPro folder is remembered, but Chrome needs permission before Looper can read it.'
  }
  if (status.remembered) {
    return 'GSPro folder is remembered, but GSPro.db could not be found there.'
  }
  return 'First setup: connect the GSPro data folder once. Looper will remember it on this computer.'
}

export default function LooperLandingPage() {
  const [selectedClub, setSelectedClub] = useState<Club>(() => activeBagClubIds[0] ?? '7i')
  const [selectedShotVariantId, setSelectedShotVariantId] = useState<string>(
    STOCK_SHOT_VARIANT_ID,
  )
  const [startingSession, setStartingSession] = useState(false)
  const [configuringGspro, setConfiguringGspro] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [gsproStatus, setGsproStatus] = useState<GsproConnectionStatus | null>(null)
  const shotVariants = useMemo(() => getShotVariantsForClub(selectedClub), [selectedClub])
  const browserFileAccessSupported = isGsproBrowserFileAccessSupported()

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

  useEffect(() => {
    let cancelled = false
    void getGsproConnectionStatus()
      .then((status) => {
        if (!cancelled) {
          setGsproStatus(status)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn('[GSPro browser] could not read saved connection status', error)
          setGsproStatus({
            remembered: false,
            permission: browserFileAccessSupported ? 'prompt' : 'unsupported',
            directoryName: null,
            ready: false,
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [browserFileAccessSupported])

  const configureGspro = async () => {
    setStartError(null)
    setConfiguringGspro(true)
    try {
      await pickAndRememberGsproDirectory()
      setGsproStatus(await getGsproConnectionStatus())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('abort')) {
        setStartError(message)
      }
    } finally {
      setConfiguringGspro(false)
    }
  }

  const startSession = async () => {
    setStartError(null)
    setStartingSession(true)

    try {
      await prepareGsproDatabaseForSession()

      const source = 'gspro' as const
      const params = new URLSearchParams({
        [SESSION_SOURCE_PARAM]: source,
        [LEGACY_SESSION_FEED_PARAM]: legacyFeedModeForSessionSource(source),
        club: selectedClub,
        variant: resolveShotVariantId(selectedShotVariantId),
      })
      navigateWithinApp(`/session-intelligence?${params.toString()}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('abort')) {
        setStartError(message)
      }
      try {
        setGsproStatus(await getGsproConnectionStatus())
      } catch {
        // Keep the session-start error as the useful message for the user.
      }
    } finally {
      setStartingSession(false)
    }
  }

  const gsproBusy = startingSession || configuringGspro

  return (
    <main className="looper-landing-page">
      <div className="looper-landing-shell">
        <section className="looper-landing-panel" aria-label="Looper entry">
          <img alt="The Looper" className="looper-landing-logo" src={looperLogoWhite} />

          <div className="looper-landing-actions">
            <a className="looper-landing-action looper-landing-action-primary" href="/dashboard">
              Go to Dashboard
            </a>

            <div className="looper-landing-session">
              <label className="looper-landing-label" htmlFor="landing-club-select">
                New Session
              </label>

              {import.meta.env.DEV ? (
                <div style={{ marginBottom: 12 }}>
                  <button
                    className="looper-landing-action looper-landing-action-secondary"
                    onClick={() =>
                      navigateWithinApp(
                        `/session-intelligence?source=mock&feed=mock&variant=${encodeURIComponent(resolveShotVariantId(selectedShotVariantId))}`,
                      )
                    }
                    type="button"
                  >
                    DEV: Open Mock Session
                  </button>
                </div>
              ) : null}

              <div className="looper-landing-session-field">
                <div className="looper-landing-source-toggle" aria-label="Session source">
                  <button
                    aria-pressed="true"
                    className="looper-landing-source-pill is-selected"
                    disabled
                    type="button"
                  >
                    GSPro
                  </button>
                </div>
              </div>

              <div className="looper-landing-session-status">
                <p className="looper-landing-status-tag">
                  {gsproStatus?.ready ? 'GSPro ready' : gsproStatus?.remembered ? 'GSPro remembered' : 'GSPro setup'}
                </p>
                <p className="looper-landing-status-detail">
                  {gsproStatusText(gsproStatus, browserFileAccessSupported)}
                </p>
                {browserFileAccessSupported ? (
                  <button
                    className="looper-landing-action looper-landing-action-secondary"
                    disabled={gsproBusy}
                    onClick={() => void configureGspro()}
                    type="button"
                  >
                    {configuringGspro
                      ? 'Connecting…'
                      : gsproStatus?.remembered
                        ? 'Change GSPro Folder'
                        : 'Connect GSPro'}
                  </button>
                ) : null}
              </div>

              <div className="looper-landing-club-variant-row">
                <div className="looper-landing-session-field">
                  <span className="looper-landing-field-label">Club</span>
                  <div className="looper-landing-select-wrap">
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
                  </div>
                </div>
                <div className="looper-landing-session-field">
                  <span className="looper-landing-field-label">Variant</span>
                  <div className="looper-landing-select-wrap">
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
                  </div>
                </div>
              </div>

              <button
                className="looper-landing-action looper-landing-action-secondary looper-landing-start"
                disabled={gsproBusy || !browserFileAccessSupported}
                onClick={() => void startSession()}
                type="button"
              >
                {startingSession ? 'Starting…' : 'Start'}
              </button>

              {startError ? <p className="looper-landing-status-detail">{startError}</p> : null}
            </div>

            <div className="looper-landing-utility-actions">
              <a
                className="looper-landing-action looper-landing-action-secondary"
                href="/bag-setup?returnTo=%2Flooper"
              >
                Edit Bag
              </a>
              <a
                className="looper-landing-action looper-landing-action-secondary"
                href="/data-management"
              >
                Manage Data
              </a>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
