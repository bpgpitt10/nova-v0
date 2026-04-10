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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const optionalStringOrNumber = (value: unknown): string | number | undefined =>
  typeof value === 'string' || typeof value === 'number' ? value : undefined

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

  if (optionalString(parsed.type) === 'shot') {
    return parsed
  }

  const candidates = [parsed.data, parsed.payload, parsed.shot].filter(isRecord)

  return candidates.find((candidate) => optionalString(candidate.type) === 'shot') ?? null
}

const parseShot = (raw: MessageEvent<string>): IncomingNovaShot | null => {
  try {
    const parsed: unknown = JSON.parse(raw.data)
    const shotRecord = findShotEnvelope(parsed)

    if (!shotRecord) {
      return null
    }

    logUnknownFields(shotRecord)

    return {
      timestamp: optionalString(shotRecord.timestamp),
      ball_speed_meters_per_second: optionalNumber(
        shotRecord.ball_speed_meters_per_second,
      ),
      vertical_launch_angle_degrees: optionalNumber(
        shotRecord.vertical_launch_angle_degrees,
      ),
      horizontal_launch_angle_degrees: optionalNumber(
        shotRecord.horizontal_launch_angle_degrees,
      ),
      total_spin_rpm: optionalNumber(shotRecord.total_spin_rpm),
      spin_axis_degrees: optionalNumber(shotRecord.spin_axis_degrees),
      shotRanking: optionalStringOrNumber(shotRecord.shotRanking),
    }
  } catch {
    return null
  }
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
    const socket = new WebSocket(url)

    socket.addEventListener('open', () => onStatusChange?.('connected'))
    socket.addEventListener('close', (event) => {
      if (event.code === 1000) {
        onStatusChange?.('disconnected')
      } else {
        onStatusChange?.('error')
      }
    })
    socket.addEventListener('error', () =>
      onStatusChange?.('error' satisfies NovaConnectionStatus),
    )

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
      onStatusChange?.('connected')
    }

    return {
      mode: 'real',
      disconnect: () => socket.close(),
    }
  },
})
