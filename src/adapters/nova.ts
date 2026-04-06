import type { IncomingNovaShot } from '../types'
import { mockNovaAdapter } from './mockNova'
import { novaWebSocketAdapter } from './novaWebSocket'

const NOVA_WEBSOCKET_MDNS_SERVICE = '_openlaunch-ws._tcp.local.'
const NOVA_TCP_MDNS_SERVICE = '_openapi-nova._tcp.local.'

export type NovaShotHandler = (shot: IncomingNovaShot) => void
export type NovaDebugEvent = {
  rawMessage: string
  normalizedShot: IncomingNovaShot | null
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
// - Services are advertised over mDNS:
//   - WebSocket JSON: _openlaunch-ws._tcp.local.
//   - TCP JSON: _openapi-nova._tcp.local.
// - Real mode currently targets a discovered/local WebSocket JSON URL via
//   VITE_NOVA_WS_URL. TCP JSON is a secondary/future target because browsers
//   cannot open arbitrary TCP sockets directly.
//
// TODO before replacing mock mode:
// - Confirm the exact shot payload schema beyond timestamp, carry, total,
//   offline, spin, vla, and shotRanking.
// - Confirm the exact WebSocket/TCP message envelope.
// - Decide whether browser-side mDNS discovery is realistic, or whether a small
//   local helper/proxy should discover Nova and expose a browser-safe endpoint.
export const novaServiceDiscoveryTargets = {
  websocketJson: NOVA_WEBSOCKET_MDNS_SERVICE,
  tcpJson: NOVA_TCP_MDNS_SERVICE,
} as const

export const novaAdapter: NovaAdapter = {
  connectToShots(onShot, onStatusChange, onDebugEvent) {
    const websocketUrl = import.meta.env.VITE_NOVA_WS_URL

    if (websocketUrl) {
      return novaWebSocketAdapter(websocketUrl).connectToShots(
        onShot,
        onStatusChange,
        onDebugEvent,
      )
    }

    return mockNovaAdapter.connectToShots(onShot, onStatusChange, onDebugEvent)
  },
}
