import type {
  NovaAdapter,
  NovaConnection,
  NovaConnectionStatus,
  NovaDebugEvent,
  NovaShotHandler,
} from './nova'
import type { IncomingNovaShot } from '../types'

const KNOWN_NOVA_SHOT_FIELDS = new Set([
  'type',
  'timestamp',
  'ball_speed_meters_per_second',
  'vertical_launch_angle_degrees',
  'horizontal_launch_angle_degrees',
  'total_spin_rpm',
  'spin_axis_degrees',
])
const CONNECT_TIMEOUT_MS = 7000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const optionalNumberish = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const optionalStringOrNumber = (value: unknown): string | number | undefined =>
  typeof value === 'string' || typeof value === 'number' ? value : undefined

const hasShotMetricFields = (record: Record<string, unknown>) =>
  typeof optionalNumberish(record.ball_speed_meters_per_second) === 'number' ||
  typeof optionalNumberish(record.ballSpeedMetersPerSecond) === 'number' ||
  typeof optionalNumberish(record.vertical_launch_angle_degrees) === 'number' ||
  typeof optionalNumberish(record.verticalLaunchAngleDegrees) === 'number' ||
  typeof optionalNumberish(record.horizontal_launch_angle_degrees) === 'number' ||
  typeof optionalNumberish(record.horizontalLaunchAngleDegrees) === 'number' ||
  typeof optionalNumberish(record.total_spin_rpm) === 'number' ||
  typeof optionalNumberish(record.totalSpinRpm) === 'number' ||
  typeof optionalNumberish(record.spin_axis_degrees) === 'number' ||
  typeof optionalNumberish(record.spinAxisDegrees) === 'number'

const logUnknownFields = (record: Record<string, unknown>) => {
  if (!import.meta.env.DEV) {
    return
  }

  const unknownFields = Object.keys(record).filter(
    (field) => !KNOWN_NOVA_SHOT_FIELDS.has(field),
  )

  if (unknownFields.length > 0) {
    console.info('Unknown Nova shot fields:', unknownFields)
  }
}

const findShotEnvelope = (parsed: unknown): Record<string, unknown> | null => {
  if (!isRecord(parsed)) {
    return null
  }

  if (optionalString(parsed.type) === 'shot' || hasShotMetricFields(parsed)) {
    return parsed
  }

  const candidates = [parsed.data, parsed.payload, parsed.shot].filter(isRecord)

  return (
    candidates.find(
      (candidate) =>
        optionalString(candidate.type) === 'shot' || hasShotMetricFields(candidate),
    ) ?? null
  )
}

const parseShot = (raw: MessageEvent<string>): IncomingNovaShot | null => {
  try {
    const parsed: unknown = JSON.parse(raw.data)
    const shotRecord = findShotEnvelope(parsed)

    if (!shotRecord) {
      if (import.meta.env.DEV && isRecord(parsed)) {
        console.info('[Nova WS] Dropped non-shot message', {
          type: optionalString(parsed.type),
          keys: Object.keys(parsed),
        })
      }
      return null
    }

    logUnknownFields(shotRecord)

    return {
      timestamp: optionalString(shotRecord.timestamp),
      ball_speed_meters_per_second: optionalNumberish(
        shotRecord.ball_speed_meters_per_second ?? shotRecord.ballSpeedMetersPerSecond,
      ),
      vertical_launch_angle_degrees: optionalNumberish(
        shotRecord.vertical_launch_angle_degrees ?? shotRecord.verticalLaunchAngleDegrees,
      ),
      horizontal_launch_angle_degrees: optionalNumberish(
        shotRecord.horizontal_launch_angle_degrees ??
          shotRecord.horizontalLaunchAngleDegrees,
      ),
      total_spin_rpm: optionalNumberish(shotRecord.total_spin_rpm ?? shotRecord.totalSpinRpm),
      spin_axis_degrees: optionalNumberish(
        shotRecord.spin_axis_degrees ?? shotRecord.spinAxisDegrees,
      ),
      shotRanking: optionalStringOrNumber(
        shotRecord.shotRanking ?? shotRecord.shot_rank ?? shotRecord.shotRank,
      ),
    }
  } catch {
    return null
  }
}

type SharedNovaSubscriber = {
  onShot: NovaShotHandler
  onStatusChange?: (status: NovaConnectionStatus) => void
  onDebugEvent?: (event: NovaDebugEvent) => void
}

type SharedNovaConnectionState = {
  url: string
  connection: NovaConnection
  subscribers: Set<SharedNovaSubscriber>
  pendingShots: IncomingNovaShot[]
  currentStatus: NovaConnectionStatus
}

let sharedNovaConnection: SharedNovaConnectionState | null = null

const dispatchSharedStatus = (status: NovaConnectionStatus) => {
  if (!sharedNovaConnection) {
    return
  }

  sharedNovaConnection.currentStatus = status
  for (const subscriber of sharedNovaConnection.subscribers) {
    subscriber.onStatusChange?.(status)
  }
}

const dispatchSharedDebug = (event: NovaDebugEvent) => {
  if (!sharedNovaConnection) {
    return
  }

  for (const subscriber of sharedNovaConnection.subscribers) {
    subscriber.onDebugEvent?.(event)
  }
}

const dispatchSharedShot = (shot: IncomingNovaShot) => {
  if (!sharedNovaConnection) {
    return
  }

  if (sharedNovaConnection.subscribers.size === 0) {
    sharedNovaConnection.pendingShots.push(shot)
    return
  }

  for (const subscriber of sharedNovaConnection.subscribers) {
    subscriber.onShot(shot)
  }
}

export const prepareSharedNovaConnection = (url: string) => {
  if (sharedNovaConnection?.url === url) {
    console.info('[Nova WS] shared connection already prepared', { url })
    return
  }

  if (sharedNovaConnection) {
    console.info('[Nova WS] replacing shared connection', {
      previousUrl: sharedNovaConnection.url,
      nextUrl: url,
    })
    sharedNovaConnection.connection.disconnect()
    sharedNovaConnection = null
  }

  console.info('[Nova WS] preparing shared connection', { url })
  const connection = novaWebSocketAdapter(url).connectToShots(
    dispatchSharedShot,
    dispatchSharedStatus,
    dispatchSharedDebug,
  )

  sharedNovaConnection = {
    url,
    connection,
    subscribers: new Set(),
    pendingShots: [],
    currentStatus: 'connecting',
  }

  dispatchSharedStatus('connecting')
}

export const subscribeSharedNovaConnection = (
  url: string,
  onShot: NovaShotHandler,
  onStatusChange?: (status: NovaConnectionStatus) => void,
  onDebugEvent?: (event: NovaDebugEvent) => void,
): NovaConnection => {
  if (!sharedNovaConnection || sharedNovaConnection.url !== url) {
    prepareSharedNovaConnection(url)
  }

  if (!sharedNovaConnection) {
    return {
      mode: 'real',
      disconnect: () => undefined,
    }
  }

  const subscriber: SharedNovaSubscriber = {
    onShot,
    onStatusChange,
    onDebugEvent,
  }

  sharedNovaConnection.subscribers.add(subscriber)
  console.info('[Nova WS] subscriber attached', {
    url: sharedNovaConnection.url,
    subscribers: sharedNovaConnection.subscribers.size,
    currentStatus: sharedNovaConnection.currentStatus,
  })
  onStatusChange?.(sharedNovaConnection.currentStatus)

  if (sharedNovaConnection.pendingShots.length > 0) {
    const queuedShots = sharedNovaConnection.pendingShots
    sharedNovaConnection.pendingShots = []
    queuedShots.forEach(onShot)
  }

  return {
    mode: 'real',
    disconnect: () => {
      sharedNovaConnection?.subscribers.delete(subscriber)
      console.info('[Nova WS] subscriber detached', {
        url,
        subscribers: sharedNovaConnection?.subscribers.size ?? 0,
      })
    },
  }
}

export const disconnectSharedNovaConnection = () => {
  if (sharedNovaConnection) {
    console.info('[Nova WS] disconnecting shared connection', {
      url: sharedNovaConnection.url,
      subscribers: sharedNovaConnection.subscribers.size,
    })
  }
  sharedNovaConnection?.connection.disconnect()
  sharedNovaConnection = null
}

// Expected real Nova WebSocket connection flow:
// 1. Discover Nova's _openlaunch-ws._tcp.local. service outside this browser app,
//    or manually provide the local WebSocket URL through VITE_NOVA_WS_URL.
// 2. Open a receive-only WebSocket connection to that URL.
// 3. Receive JSON messages from Nova.
// 4. Handle Nova example messages with type = "shot" or type = "status".
// 5. For shot messages, map only raw launch/spin inputs needed downstream:
//    ball_speed_meters_per_second, vertical_launch_angle_degrees,
//    horizontal_launch_angle_degrees, total_spin_rpm, spin_axis_degrees.
// 6. Emit normalized shot data to the app through the NovaAdapter boundary.
export const novaWebSocketAdapter = (url: string): NovaAdapter => ({
  connectToShots(
    onShot: NovaShotHandler,
    onStatusChange,
    onDebugEvent?: (event: NovaDebugEvent) => void,
  ): NovaConnection {
    onStatusChange?.('connecting')
    console.info('[Nova WS] connect', { url })
    const socket = new WebSocket(url)
    let hasOpened = false
    let closedAfterError = false
    const connectTimer = window.setTimeout(() => {
      if (hasOpened) {
        return
      }
      closedAfterError = true
      console.warn('[Nova WS] timeout', { url })
      onStatusChange?.('error')
      try {
        socket.close()
      } catch {
        // ignore
      }
    }, CONNECT_TIMEOUT_MS)

    socket.addEventListener('open', () => {
      hasOpened = true
      window.clearTimeout(connectTimer)
      console.info('[Nova WS] open', { url })
      onStatusChange?.('connected')
    })
    socket.addEventListener('close', (event) => {
      window.clearTimeout(connectTimer)
      console.info('[Nova WS] close', {
        url,
        code: event.code,
        reason: event.reason || 'none',
      })
      if (closedAfterError) {
        onStatusChange?.('error')
      } else if (event.code === 1000) {
        onStatusChange?.('disconnected')
      } else {
        onStatusChange?.('error')
      }
    })
    socket.addEventListener('error', () => {
      window.clearTimeout(connectTimer)
      closedAfterError = true
      console.error('[Nova WS] error', { url })
      onStatusChange?.('error' satisfies NovaConnectionStatus)
    })

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      const shot = parseShot(event)
      onDebugEvent?.({
        rawMessage: event.data,
        normalizedShot: shot,
      })

      if (shot) {
        onShot(shot)
      }
    })

    // Defensive guard for rare timing cases where the socket is already OPEN
    // before listeners begin observing state transitions.
    if (socket.readyState === WebSocket.OPEN) {
      hasOpened = true
      window.clearTimeout(connectTimer)
      onStatusChange?.('connected')
    }

    return {
      mode: 'real',
      disconnect: () => {
        window.clearTimeout(connectTimer)
        console.info('[Nova WS] disconnect requested', { url })
        socket.close()
      },
    }
  },
})
