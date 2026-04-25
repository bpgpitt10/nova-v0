import type { IncomingNovaShot } from '../types'
import { novaWebSocketAdapter } from './novaWebSocket'
import type { OpenGolfCoachDerivedValues, OpenGolfCoachInput } from '../types'

const NOVA_WEBSOCKET_MDNS_SERVICE = '_openlaunch-ws._tcp.local.'
const NOVA_TCP_MDNS_SERVICE = '_openapi-nova._tcp.local.'
export const LOCAL_NOVA_WS_URL_KEY = 'nova-ws-url'
export const DEFAULT_NOVA_WS_URL = 'ws://127.0.0.1:8765'

export type NovaShotHandler = (shot: IncomingNovaShot) => void
export type NovaDebugEvent = {
  rawMessage: string
  normalizedShot: IncomingNovaShot | null
  openGolfCoachInput?: OpenGolfCoachInput | null
  openGolfCoachResponse?: OpenGolfCoachDerivedValues | null
}
export type NovaFeedMode = 'real' | 'mock'
export type NovaConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'paused'
  | 'disconnected'
  | 'error'

export type NovaConnection = {
  mode: NovaFeedMode
  disconnect: () => void
  pause?: () => void
  resume?: () => void
}

export type NovaAdapter = {
  connectToShots: (
    onShot: NovaShotHandler,
    onStatusChange?: (status: NovaConnectionStatus) => void,
    onDebugEvent?: (event: NovaDebugEvent) => void,
  ) => NovaConnection
}

// Nova developer guide notes:
// - Nova exposes local receive-only shot APIs over WebSocket JSON and TCP JSON.
// - Nova is the raw live shot source in this app.
// - OpenGolfCoach is planned as a downstream enrichment step, not a data source.
// - Services are advertised over mDNS:
//   - WebSocket JSON: _openlaunch-ws._tcp.local.
//   - TCP JSON: _openapi-nova._tcp.local.
// - Real mode currently targets a discovered/local WebSocket JSON URL via
//   VITE_NOVA_WS_URL. TCP JSON is a secondary/future target because browsers
//   cannot open arbitrary TCP sockets directly.
//
// TODO before replacing mock mode:
// - Confirm which raw Nova fields are available for OpenGolfCoach input:
//   ball_speed_meters_per_second, vertical_launch_angle_degrees,
//   horizontal_launch_angle_degrees, total_spin_rpm, spin_axis_degrees.
// - Confirm the exact shot payload schema beyond timestamp, carry, total,
//   offline, spin, vla, and shotRanking.
// - Confirm the exact WebSocket/TCP message envelope.
// - Decide whether browser-side mDNS discovery is realistic, or whether a small
//   local helper/proxy should discover Nova and expose a browser-safe endpoint.
export const novaServiceDiscoveryTargets = {
  websocketJson: NOVA_WEBSOCKET_MDNS_SERVICE,
  tcpJson: NOVA_TCP_MDNS_SERVICE,
} as const

export type NovaWebSocketEndpointSource = 'localStorage' | 'env' | 'default'

export type NovaWebSocketEndpoint = {
  url: string
  source: NovaWebSocketEndpointSource
}

export const resolveNovaWebSocketEndpoint = (): NovaWebSocketEndpoint => {
  const savedUrl = (() => {
    if (typeof window === 'undefined') {
      return undefined
    }
    try {
      return window.localStorage.getItem(LOCAL_NOVA_WS_URL_KEY)?.trim()
    } catch {
      return undefined
    }
  })()
  if (savedUrl) {
    return { url: savedUrl, source: 'localStorage' }
  }

  const envUrl = (import.meta.env.VITE_NOVA_WS_URL as string | undefined)?.trim()
  if (envUrl) {
    return { url: envUrl, source: 'env' }
  }

  return { url: DEFAULT_NOVA_WS_URL, source: 'default' }
}

export const novaAdapter: NovaAdapter = {
  connectToShots(onShot, onStatusChange, onDebugEvent) {
    const endpoint = resolveNovaWebSocketEndpoint()
    console.info('[Nova Config] selected WebSocket endpoint', {
      source: endpoint.source,
      url: endpoint.url,
      mockModeActive: false,
    })

    return novaWebSocketAdapter(endpoint.url).connectToShots(
      onShot,
      onStatusChange,
      onDebugEvent,
    )
  },
}
