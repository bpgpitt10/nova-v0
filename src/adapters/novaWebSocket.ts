import type {
  NovaAdapter,
  NovaConnection,
  NovaConnectionStatus,
  NovaDebugEvent,
  NovaShotHandler,
} from './nova'
import type { IncomingNovaShot } from '../types'

const KNOWN_NOVA_SHOT_FIELDS = new Set([
  'timestamp',
  'carry',
  'total',
  'offline',
  'spin',
  'vla',
  'shotRanking',
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

const findShotRecord = (parsed: unknown): Record<string, unknown> | null => {
  if (!isRecord(parsed)) {
    return null
  }

  const candidates = [
    parsed,
    parsed.shot,
    parsed.data,
    parsed.payload,
  ].filter(isRecord)

  return (
    candidates.find((candidate) =>
      [...KNOWN_NOVA_SHOT_FIELDS].some((field) => field in candidate),
    ) ?? null
  )
}

const parseShot = (raw: MessageEvent<string>): IncomingNovaShot | null => {
  try {
    const parsed: unknown = JSON.parse(raw.data)
    const shotRecord = findShotRecord(parsed)

    if (!shotRecord) {
      return null
    }

    logUnknownFields(shotRecord)

    return {
      timestamp: optionalString(shotRecord.timestamp),
      carry: optionalNumber(shotRecord.carry),
      total: optionalNumber(shotRecord.total),
      offline: optionalNumber(shotRecord.offline),
      spin: optionalNumber(shotRecord.spin),
      vla: optionalNumber(shotRecord.vla),
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
// 4. Parse messages conservatively because the exact envelope is still unknown.
// 5. Map only known shot fields: timestamp, carry, total, offline, spin, vla,
//    and shotRanking.
// 6. Emit normalized shot data to the app through the NovaAdapter boundary.
export const novaWebSocketAdapter = (url: string): NovaAdapter => ({
  connectToShots(
    onShot: NovaShotHandler,
    onStatusChange,
    onDebugEvent?: (event: NovaDebugEvent) => void,
  ): NovaConnection {
    const socket = new WebSocket(url)

    socket.addEventListener('open', () => onStatusChange?.('connected'))
    socket.addEventListener('close', () => onStatusChange?.('disconnected'))
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

    return {
      mode: 'real',
      disconnect: () => socket.close(),
    }
  },
})
