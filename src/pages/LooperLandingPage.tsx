import { useState } from 'react'
import { activeBagClubIds, getClubLabel, type Club } from '../lib/bagConfig'
import './LooperLandingPage.css'

import looperLogoWhite from '../assets/looperlogowhite.png'

export default function LooperLandingPage() {
  const [selectedClub, setSelectedClub] = useState<Club>('7i')
  const [selectedFeedMode, setSelectedFeedMode] = useState<'mock' | 'real'>('mock')

  const startSession = () => {
    const params = new URLSearchParams({
      feed: selectedFeedMode,
      club: selectedClub,
    })
    window.location.assign(`/session-intelligence?${params.toString()}`)
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
              <div className="looper-landing-session-field">
                <span className="looper-landing-field-label">Data Source</span>
                <div className="looper-landing-select-wrap">
                  <select
                    id="landing-feed-select"
                    onChange={(event) => setSelectedFeedMode(event.target.value as 'mock' | 'real')}
                    value={selectedFeedMode}
                  >
                    <option value="mock">Mock</option>
                    <option value="real">Live Nova</option>
                  </select>
                </div>
              </div>
              <div className="looper-landing-session-row">
                <div className="looper-landing-select-wrap">
                  <select
                    id="landing-club-select"
                    onChange={(event) => setSelectedClub(event.target.value as Club)}
                    value={selectedClub}
                  >
                    {activeBagClubIds.map((club) => (
                      <option key={club} value={club}>
                        {getClubLabel(club)}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  className="looper-landing-action looper-landing-action-secondary"
                  onClick={startSession}
                  type="button"
                >
                  Start
                </button>
              </div>
            </div>

            <a className="looper-landing-action looper-landing-action-secondary" href="/data-management">
              Manage Data
            </a>
          </div>
        </section>
      </div>
    </main>
  )
}
