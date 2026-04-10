import type { IncomingNovaShot } from '../types'
import { mockNovaAdapter } from './mockNova'
import { novaWebSocketAdapter } from './novaWebSocket'
import type { OpenGolfCoachDerivedValues, OpenGolfCoachInput } from '../types'

const NOVA_WEBSOCKET_MDNS_SERVICE = '_openlaunch-ws._tcp.local.'
const NOVA_TCP_MDNS_SERVICE = '_openapi-nova._tcp.local.'
const DEFAULT_PROXY_URL = 'ws://localhost:3100'

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

export const novaServiceDiscoveryTargets = {
  websocketJson: NOVA_WEBSOCKET_MDNS_SERVICE,
  tcpJson: NOVA_TCP_MDNS_SERVICE,
} as const

export const resolveNovaWebSocketUrl = (): string | null => {
  const envUrl = import.meta.env.VITE_NOVA_WS_URL
  if (envUrl) return envUrl
  return null
}

export const novaProxyUrl = DEFAULT_PROXY_URL

export const isProxyAutoConnect = !import.meta.env.VITE_NOVA_WS_URL

export const novaAdapter: NovaAdapter = {
  connectToShots(onShot, onStatusChange, onDebugEvent) {
    const websocketUrl = resolveNovaWebSocketUrl() || (
      isProxyAutoConnect ? novaProxyUrl : null
    )

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
