import type { IncomingNovaShot } from '../types'
import { novaWebSocketAdapter } from './novaWebSocket'
import type { OpenGolfCoachDerivedValues, OpenGolfCoachInput } from '../types'

const NOVA_WEBSOCKET_MDNS_SERVICE = '_openlaunch-ws._tcp.local.'
const NOVA_TCP_MDNS_SERVICE = '_openapi-nova._tcp.local.'

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

export const novaAdapter: NovaAdapter = {
  connectToShots(onShot, onStatusChange, onDebugEvent) {
    const envUrl = (import.meta.env.VITE_NOVA_WS_URL as string | undefined)?.trim()
    const savedUrl =
      typeof window !== 'undefined'
        ? window.localStorage.getItem('nova-ws-url')?.trim()
        : undefined
    const websocketUrl = envUrl || savedUrl

    if (!websocketUrl) {
      onStatusChange?.('error')
      return {
        mode: 'real',
        disconnect: () => undefined,
      }
    }

    return novaWebSocketAdapter(websocketUrl).connectToShots(
      onShot,
      onStatusChange,
      onDebugEvent,
    )
  },
}
