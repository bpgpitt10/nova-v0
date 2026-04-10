import { useEffect, useMemo, useState } from 'react'
import { activeBagClubIds, getClubLabel, type Club } from '../lib/bagConfig'
import './LooperLandingPage.css'

import looperLogoWhite from '../assets/looperlogowhite.png'

type NovaConnectionState =
  | 'not_configured'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected'

const LOCAL_NOVA_WS_URL_KEY = 'nova-ws-url'
const NOVA_LOCAL_DEV_FALLBACK_URL = 'ws://127.0.0.1:8765'

const safeReadLocalStorage = (key: string) => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const resolveNovaWebSocketUrl = () => {
  const envUrl = (import.meta.env.VITE_NOVA_WS_URL as string | undefined)?.trim()
  if (envUrl) {
    return envUrl
  }

  const savedUrl = safeReadLocalStorage(LOCAL_NOVA_WS_URL_KEY)?.trim()
  if (savedUrl) {
    return savedUrl
  }

  return NOVA_LOCAL_DEV_FALLBACK_URL
}

export default function LooperLandingPage() {
  const [selectedClub, setSelectedClub] = useState<Club>('7i')
  const [novaState, setNovaState] = useState<NovaConnectionState>('not_configured')
  const [novaDetail, setNovaDetail] = useState<string | null>(null)
  const novaWebSocketUrl = useMemo(() => resolveNovaWebSocketUrl(), [])

  useEffect(() => {
    if (!novaWebSocketUrl) {
      setNovaState('not_configured')
      setNovaDetail('Nova not configured for this device.')
      return
    }

    let isMounted = true
    let closedByApp = false
    const socket = new WebSocket(novaWebSocketUrl)

    setNovaState('connecting')
    setNovaDetail(`Connecting to Nova...`)

    socket.onopen = () => {
      if (!isMounted) {
        return
      }
      setNovaState('connected')
      setNovaDetail(null)
    }

    socket.onerror = () => {
      if (!isMounted) {
        return
      }
      setNovaState('error')
      setNovaDetail('Nova connection failed')
    }

    socket.onclose = () => {
      if (!isMounted) {
        return
      }
      if (closedByApp) {
        setNovaState('disconnected')
        return
      }
      setNovaState('error')
      setNovaDetail('No Nova found on this network')
    }

    return () => {
      isMounted = false
      closedByApp = true
      socket.close()
    }
  }, [novaWebSocketUrl])

  const novaStatusText = (() => {
    switch (novaState) {
      case 'not_configured':
        return 'Nova not configured'
      case 'connecting':
        return 'Connecting to Nova...'
      case 'connected':
        return 'Connected to Nova'
      case 'error':
        return 'Nova connection failed'
      case 'disconnected':
        return 'Nova disconnected'
    }
  })()

  const startSession = () => {
    const params = new URLSearchParams({
      feed: 'real',
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
              <div className="looper-landing-session-status">
                <p className="looper-landing-status-tag">{novaStatusText}</p>
                {novaDetail ? <p className="looper-landing-status-detail">{novaDetail}</p> : null}
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
