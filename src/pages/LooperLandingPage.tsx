import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_NOVA_WS_URL,
  LOCAL_NOVA_WS_URL_KEY,
  resolveNovaWebSocketEndpoint,
} from '../adapters/nova'
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
import type { SessionSource } from '../types'
import './LooperLandingPage.css'

import looperLogoWhite from '../assets/looperlogowhite.png'

type NovaConnectionState =
  | 'not_configured'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected'

const CONNECT_TIMEOUT_MS = 7000
const VALIDATION_TIMEOUT_MS = 2500
const DISCOVERY_TIMEOUT_MS = 5000

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

const safeWriteLocalStorage = (key: string, value: string) => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

const safeRemoveLocalStorage = (key: string) => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

const hasTauriInvoke = () =>
  typeof window !== 'undefined' &&
  typeof (window as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__
    ?.invoke === 'function'

const tauriInvoke = async (command: string, args: Record<string, unknown> = {}) => {
  const invoke = (window as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__
    ?.invoke
  if (typeof invoke !== 'function') {
    return undefined
  }
  return invoke(command, args)
}

const appendNovaLog = async (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`
  console.info(stamped)
  if (!hasTauriInvoke()) {
    return
  }
  try {
    await tauriInvoke('append_nova_log', { line: stamped })
  } catch {
    // logging fallback stays in console
  }
}

type DiscoverResult = {
  service: string
  host: string
  port: number
  ws_url: string
}

const discoverNovaEndpoint = async () => {
  if (!hasTauriInvoke()) {
    return null
  }
  try {
    const result = (await tauriInvoke('discover_nova_ws_endpoint', {
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    })) as DiscoverResult | null
    return result
  } catch (error) {
    await appendNovaLog(
      `[landing.discovery] command failed error=${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

const connectWithTimeout = async (
  url: string,
  timeoutMs: number,
  context: string,
) =>
  new Promise<boolean>((resolve) => {
    let settled = false
    const socket = new WebSocket(url)
    const timer = window.setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      appendNovaLog(`[landing.connect] timeout context=${context} url=${url}`)
      try {
        socket.close()
      } catch {
        // ignore
      }
      resolve(false)
    }, timeoutMs)

    socket.addEventListener('open', () => {
      if (settled) {
        return
      }
      settled = true
      window.clearTimeout(timer)
      appendNovaLog(`[landing.connect] open context=${context} url=${url}`)
      try {
        socket.close()
      } catch {
        // ignore
      }
      resolve(true)
    })

    socket.addEventListener('error', () => {
      if (settled) {
        return
      }
      settled = true
      window.clearTimeout(timer)
      appendNovaLog(`[landing.connect] error context=${context} url=${url}`)
      resolve(false)
    })

    socket.addEventListener('close', (event) => {
      if (settled) {
        return
      }
      settled = true
      window.clearTimeout(timer)
      appendNovaLog(
        `[landing.connect] close context=${context} url=${url} code=${event.code} reason=${event.reason || 'none'}`,
      )
      resolve(false)
    })
  })

const resolveDevOverrideUrl = () => {
  const endpoint = resolveNovaWebSocketEndpoint()
  return endpoint.source === 'env' ? endpoint.url : undefined
}

const navigateWithinApp = (path: string) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const formatShotVariantName = (name: string) =>
  name.length > 24 ? `${name.slice(0, 21)}...` : name

export default function LooperLandingPage() {
  const [selectedSource, setSelectedSource] = useState<Extract<SessionSource, 'gspro' | 'nova'>>(
    'gspro',
  )
  const [selectedClub, setSelectedClub] = useState<Club>(() => activeBagClubIds[0] ?? '7i')
  const [selectedShotVariantId, setSelectedShotVariantId] = useState<string>(
    STOCK_SHOT_VARIANT_ID,
  )
  const [novaState, setNovaState] = useState<NovaConnectionState>('connecting')
  const [novaDetail, setNovaDetail] = useState<string | null>(null)
  const [manualUrlInput, setManualUrlInput] = useState('')
  const [manualOverrideUrl, setManualOverrideUrl] = useState<string | null>(null)
  const [connectedUrl, setConnectedUrl] = useState<string | null>(null)
  const devOverrideUrl = useMemo(() => resolveDevOverrideUrl(), [])
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

  useEffect(() => {
    let isMounted = true

    const bootstrap = async () => {
      setNovaState('connecting')
      setNovaDetail('Connecting to Nova...')

      const savedUrl = safeReadLocalStorage(LOCAL_NOVA_WS_URL_KEY)?.trim()
      const candidateUrls: Array<{ source: string; url: string; timeout: number }> = []
      const configuredEndpoint = resolveNovaWebSocketEndpoint()

      await appendNovaLog(
        `[landing.config] selected_source=${configuredEndpoint.source} selected_url=${configuredEndpoint.url} mock_active=false`,
      )

      if (manualOverrideUrl) {
        candidateUrls.push({
          source: 'manual_override',
          url: manualOverrideUrl,
          timeout: CONNECT_TIMEOUT_MS,
        })
      }

      if (
        savedUrl &&
        savedUrl !== manualOverrideUrl
      ) {
        candidateUrls.push({
          source: 'saved_known_good',
          url: savedUrl,
          timeout: VALIDATION_TIMEOUT_MS,
        })
      }

      if (
        devOverrideUrl &&
        devOverrideUrl !== manualOverrideUrl &&
        devOverrideUrl !== savedUrl
      ) {
        candidateUrls.push({
          source: 'env_fallback',
          url: devOverrideUrl,
          timeout: CONNECT_TIMEOUT_MS,
        })
      }

      if (
        !manualOverrideUrl &&
        !savedUrl &&
        configuredEndpoint.source === 'default'
      ) {
        candidateUrls.push({
          source: 'default',
          url: DEFAULT_NOVA_WS_URL,
          timeout: CONNECT_TIMEOUT_MS,
        })
      }

      for (const candidate of candidateUrls) {
        await appendNovaLog(
          `[landing.bootstrap] validating source=${candidate.source} url=${candidate.url}`,
        )
        const success = await connectWithTimeout(
          candidate.url,
          candidate.timeout,
          candidate.source,
        )
        if (!isMounted) {
          return
        }
        if (success) {
          if (candidate.source !== 'env_fallback' && candidate.source !== 'default') {
            safeWriteLocalStorage(LOCAL_NOVA_WS_URL_KEY, candidate.url)
            await appendNovaLog(
              `[landing.bootstrap] persisted_connected source=${candidate.source} url=${candidate.url}`,
            )
          }
          setConnectedUrl(candidate.url)
          setNovaState('connected')
          setNovaDetail(null)
          await appendNovaLog(
            `[landing.bootstrap] selected_connected source=${candidate.source} url=${candidate.url}`,
          )
          return
        }

        if (candidate.source === 'saved_known_good') {
          safeRemoveLocalStorage(LOCAL_NOVA_WS_URL_KEY)
          await appendNovaLog(
            `[landing.bootstrap] removed_stale_saved_endpoint url=${candidate.url}`,
          )
        }
      }

      setNovaDetail('Discovering Nova...')
      await appendNovaLog('[landing.bootstrap] starting_runtime_discovery')
      const discovered = await discoverNovaEndpoint()
      if (!isMounted) {
        return
      }
      if (!discovered?.ws_url) {
        setConnectedUrl(null)
        setNovaState('error')
        setNovaDetail('No Nova found on this network')
        await appendNovaLog('[landing.bootstrap] discovery_result none')
        return
      }

      await appendNovaLog(
        `[landing.bootstrap] discovery_result service=${discovered.service} host=${discovered.host} port=${discovered.port} ws=${discovered.ws_url}`,
      )
      const discoveredConnected = await connectWithTimeout(
        discovered.ws_url,
        CONNECT_TIMEOUT_MS,
        'discovered_endpoint',
      )
      if (!isMounted) {
        return
      }
      if (discoveredConnected) {
        safeWriteLocalStorage(LOCAL_NOVA_WS_URL_KEY, discovered.ws_url)
        setConnectedUrl(discovered.ws_url)
        setNovaState('connected')
        setNovaDetail(null)
        await appendNovaLog(
          `[landing.bootstrap] selected_connected source=discovery url=${discovered.ws_url}`,
        )
        return
      }

      setConnectedUrl(null)
      setNovaState('error')
      setNovaDetail('Nova connection failed')
    }

    void bootstrap()

    return () => {
      isMounted = false
    }
  }, [devOverrideUrl, manualOverrideUrl])

  useEffect(() => {
    if (!connectedUrl) {
      return
    }
    let closedByApp = false
    const socket = new WebSocket(connectedUrl)
    const timer = window.setTimeout(() => {
      appendNovaLog(`[landing.monitor] timeout url=${connectedUrl}`)
      setNovaState('error')
      setNovaDetail('Connection timed out')
      try {
        socket.close()
      } catch {
        // ignore
      }
    }, CONNECT_TIMEOUT_MS)

    socket.addEventListener('open', () => {
      window.clearTimeout(timer)
      appendNovaLog(`[landing.monitor] open url=${connectedUrl}`)
      setNovaState('connected')
      setNovaDetail(null)
    })
    socket.addEventListener('error', () => {
      window.clearTimeout(timer)
      appendNovaLog(`[landing.monitor] error url=${connectedUrl}`)
      setNovaState('error')
      setNovaDetail('Nova connection failed')
    })
    socket.addEventListener('close', (event) => {
      window.clearTimeout(timer)
      appendNovaLog(
        `[landing.monitor] close url=${connectedUrl} code=${event.code} reason=${event.reason || 'none'}`,
      )
      if (closedByApp) {
        setNovaState('disconnected')
        return
      }
      setNovaState('error')
      setNovaDetail('Nova connection failed')
    })

    return () => {
      closedByApp = true
      window.clearTimeout(timer)
      socket.close()
    }
  }, [connectedUrl])

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
    if (selectedSource === 'nova' && (novaState !== 'connected' || !connectedUrl)) {
      return
    }

    const params = new URLSearchParams({
      [SESSION_SOURCE_PARAM]: selectedSource,
      [LEGACY_SESSION_FEED_PARAM]: legacyFeedModeForSessionSource(selectedSource),
      club: selectedClub,
      variant: resolveShotVariantId(selectedShotVariantId),
    })
    navigateWithinApp(`/session-intelligence?${params.toString()}`)
  }

  const applyManualUrl = () => {
    const trimmed = manualUrlInput.trim()
    if (!trimmed) {
      return
    }
    void appendNovaLog(`[landing.manual] submitted url=${trimmed}`)
    setManualOverrideUrl(trimmed)
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
              {import.meta.env.DEV && (
                <>
                  {/* DEV ONLY — opens Session Intelligence without Nova for SimRead testing. Safe to remove. */}
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
                      DEV: Open SimRead Test Session
                    </button>
                  </div>
                </>
              )}
              <div className="looper-landing-session-field">
                <div className="looper-landing-source-toggle" role="radiogroup" aria-label="Session source">
                  <button
                    aria-checked={selectedSource === 'gspro'}
                    className={`looper-landing-source-pill ${
                      selectedSource === 'gspro' ? 'is-selected' : ''
                    }`}
                    onClick={() => setSelectedSource('gspro')}
                    role="radio"
                    type="button"
                  >
                    GSPro
                  </button>
                  <button
                    aria-checked={selectedSource === 'nova'}
                    className={`looper-landing-source-pill ${
                      selectedSource === 'nova' ? 'is-selected' : ''
                    }`}
                    onClick={() => setSelectedSource('nova')}
                    role="radio"
                    type="button"
                  >
                    Nova
                  </button>
                </div>
              </div>
              {selectedSource === 'nova' ? (
                <div className="looper-landing-session-status">
                  <p className="looper-landing-status-tag">{novaStatusText}</p>
                  {novaDetail ? <p className="looper-landing-status-detail">{novaDetail}</p> : null}
                </div>
              ) : null}
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
                disabled={selectedSource === 'nova' && (novaState !== 'connected' || !connectedUrl)}
                onClick={startSession}
                type="button"
              >
                Start
              </button>
              {selectedSource === 'nova' ? (
                <details className="looper-landing-manual">
                  <summary>Manual Nova Connection</summary>
                  <div className="looper-landing-session-row">
                    <div className="looper-landing-select-wrap">
                      <input
                        aria-label="Manual Nova WebSocket URL"
                        onChange={(event) => setManualUrlInput(event.target.value)}
                        placeholder="ws://nova-host:port"
                        type="text"
                        value={manualUrlInput}
                      />
                    </div>
                    <button
                      className="looper-landing-action looper-landing-action-secondary"
                      onClick={applyManualUrl}
                      type="button"
                    >
                      Use URL
                    </button>
                  </div>
                </details>
              ) : null}
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
