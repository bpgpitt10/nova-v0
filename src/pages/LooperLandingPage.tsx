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
  isGsproBrowserFileAccessSupported,
  selectGsproDatabaseForSession,
} from '../lib/browserGsproDb'
import './LooperLandingPage.css'

import looperLogoWhite from '../assets/looperlogowhite.png'

const navigateWithinApp = (path: string) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const formatShotVariantName = (name: string) =>
  name.length > 24 ? `${name.slice(0, 21)}...` : name

export default function LooperLandingPage() {
  const [selectedClub, setSelectedClub] = useState<Club>(() => activeBagClubIds[0] ?? '7i')
  const [selectedShotVariantId, setSelectedShotVariantId] = useState<string>(
    STOCK_SHOT_VARIANT_ID,
  )
  const [startingSession, setStartingSession] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
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

  const startSession = async () => {
    setStartError(null)
    setStartingSession(true)

    try {
      await selectGsproDatabaseForSession()

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
    } finally {
      setStartingSession(false)
    }
  }

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
                disabled={startingSession || !browserFileAccessSupported}
                onClick={() => void startSession()}
                type="button"
              >
                {startingSession ? 'Connecting…' : 'Start'}
              </button>

              <p className="looper-landing-status-detail">
                {browserFileAccessSupported
                  ? 'Starting a session will ask you to select GSPro.db.'
                  : 'Live GSPro sessions require desktop Chrome file access.'}
              </p>
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
