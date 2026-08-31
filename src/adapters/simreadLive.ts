import type { SimReadFinalShotEvent } from './simreadFinalShot'

const SIMREAD_FINAL_SHOT_EVENT = 'looper:simread-final-shot'
const SIMREAD_EVENT_TARGET_KEY = '__looperSimReadEventTarget'
const SIMREAD_DISPATCH_KEY = '__looperDispatchSimReadFinalShot'

// Compatibility transport only. The preferred web path is direct GSPro database access.
// This endpoint remains available as a fallback if we later decide to stream GSPro events
// from a web service rather than read the granted local file directly.
export const DEFAULT_SIMREAD_EVENTS_URL = '/api/gspro/events'
export const DEV_SIMREAD_EVENTS_PROXY_URL = '/api/gspro/events'

export type SimReadLiveStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'waiting'
  | 'received-shot'
  | 'error'
  | 'disconnected'

export type SimReadStatusSeverity = 'info' | 'warning' | 'error'

export type SimReadStructuredStatusEvent = {
  event: 'status'
  status: string
  severity: SimReadStatusSeverity
  message: string
  userAction?: string
}

export type SimReadLiveConnection = {
  mode: 'simread'
  disconnect: () => void
}

export type ConnectToSimReadEventsOptions = {
  onFinalShot: (event: SimReadFinalShotEvent) => void
  onStatusChange?: (status: SimReadLiveStatus) => void
  onStructuredStatus?: (event: SimReadStructuredStatusEvent) => void
  onError?: (error: unknown) => void
  eventsUrl?: string
}

type SimReadWindow = Window &
  typeof globalThis & {
    [SIMREAD_EVENT_TARGET_KEY]?: EventTarget
    [SIMREAD_DISPATCH_KEY]?: (event: SimReadFinalShotEvent) => void
  }

const getWindow = (): SimReadWindow | null =>
  typeof window === 'undefined' ? null : (window as SimReadWindow)

const getSimReadEventTarget = () => {
  const simreadWindow = getWindow()
  if (!simreadWindow) {
    return new EventTarget()
  }

  simreadWindow[SIMREAD_EVENT_TARGET_KEY] ??= new EventTarget()
  return simreadWindow[SIMREAD_EVENT_TARGET_KEY]
}

export const dispatchSimReadFinalShotEvent = (event: SimReadFinalShotEvent) => {
  getSimReadEventTarget().dispatchEvent(
    new CustomEvent<SimReadFinalShotEvent>(SIMREAD_FINAL_SHOT_EVENT, {
      detail: event,
    }),
  )
}

const installDevDispatchHelper = () => {
  if (!import.meta.env.DEV) {
    return
  }

  const simreadWindow = getWindow()
  if (!simreadWindow) {
    return
  }

  simreadWindow[SIMREAD_DISPATCH_KEY] = dispatchSimReadFinalShotEvent
}

const isSimReadLiveStatus = (value: unknown): value is SimReadLiveStatus =>
  value === 'idle' ||
  value === 'connecting' ||
  value === 'connected' ||
  value === 'waiting' ||
  value === 'received-shot' ||
  value === 'error' ||
  value === 'disconnected'

const resolveSimReadEventsUrl = (overrideUrl?: string) => {
  if (overrideUrl?.trim()) {
    return overrideUrl.trim()
  }

  const gsproEnvUrl = (import.meta.env.VITE_GSPRO_EVENTS_URL as string | undefined)?.trim()
  if (gsproEnvUrl) {
    return gsproEnvUrl
  }

  const legacyEnvUrl = (import.meta.env.VITE_SIMREAD_EVENTS_URL as string | undefined)?.trim()
  if (legacyEnvUrl) {
    return legacyEnvUrl
  }

  return DEFAULT_SIMREAD_EVENTS_URL
}

const parseFinalShotEvent = (data: string): SimReadFinalShotEvent => {
  const parsed: unknown = JSON.parse(data)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('GSPro final-shot event data was not an object')
  }

  return parsed as SimReadFinalShotEvent
}

const parseStatusEvent = (data: string): SimReadLiveStatus | null => {
  const trimmed = data.trim()
  if (!trimmed) {
    return null
  }

  if (isSimReadLiveStatus(trimmed)) {
    return trimmed
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isSimReadLiveStatus(parsed)) {
      return parsed
    }
    if (parsed && typeof parsed === 'object' && 'status' in parsed) {
      const status = (parsed as { status?: unknown }).status
      return isSimReadLiveStatus(status) ? status : null
    }
  } catch {
    return null
  }

  return null
}

const parseStructuredStatusEvent = (data: string): SimReadStructuredStatusEvent | null => {
  try {
    const parsed: unknown = JSON.parse(data.trim())
    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const candidate = parsed as Partial<SimReadStructuredStatusEvent>
    if (
      candidate.event === 'status' &&
      typeof candidate.status === 'string' &&
      (candidate.severity === 'info' ||
        candidate.severity === 'warning' ||
        candidate.severity === 'error') &&
      typeof candidate.message === 'string'
    ) {
      return {
        event: 'status',
        status: candidate.status,
        severity: candidate.severity,
        message: candidate.message,
        ...(typeof candidate.userAction === 'string' ? { userAction: candidate.userAction } : {}),
      }
    }
  } catch {
    return null
  }

  return null
}

export const connectToSimReadEvents = ({
  onFinalShot,
  onStatusChange,
  onStructuredStatus,
  onError,
  eventsUrl,
}: ConnectToSimReadEventsOptions): SimReadLiveConnection => {
  onStatusChange?.('idle')
  const target = getSimReadEventTarget()
  installDevDispatchHelper()
  const resolvedEventsUrl = resolveSimReadEventsUrl(eventsUrl)
  let eventSource: EventSource | null = null

  const handleFinalShot = (event: SimReadFinalShotEvent) => {
    try {
      onStatusChange?.('received-shot')
      onFinalShot(event)
      onStatusChange?.('waiting')
    } catch (error) {
      onStatusChange?.('error')
      onError?.(error)
    }
  }

  const handleManualFinalShot = (event: Event) => {
    handleFinalShot((event as CustomEvent<SimReadFinalShotEvent>).detail)
  }

  const handleSseFinalShot = (event: MessageEvent<string>) => {
    try {
      handleFinalShot(parseFinalShotEvent(event.data))
    } catch (error) {
      onStatusChange?.('error')
      onError?.(error)
    }
  }

  const handleSseMessage = (event: MessageEvent<string>) => {
    try {
      const parsed: unknown = JSON.parse(event.data)
      if (
        parsed &&
        typeof parsed === 'object' &&
        'event' in parsed &&
        (parsed as { event?: unknown }).event === 'final-shot'
      ) {
        handleFinalShot(parsed as SimReadFinalShotEvent)
      }
    } catch {
      // Ignore heartbeat/message payloads that are not JSON shot events.
    }
  }

  const handleSseStatus = (event: MessageEvent<string>) => {
    const structuredStatus = parseStructuredStatusEvent(event.data)
    if (structuredStatus) {
      onStructuredStatus?.(structuredStatus)
    }

    const status = parseStatusEvent(event.data)
    if (status) {
      onStatusChange?.(status)
    }
  }

  target.addEventListener(SIMREAD_FINAL_SHOT_EVENT, handleManualFinalShot)
  onStatusChange?.('connecting')

  if (typeof EventSource === 'undefined') {
    const error = new Error('EventSource is not available in this browser')
    onStatusChange?.('error')
    onError?.(error)
  } else {
    eventSource = new EventSource(resolvedEventsUrl)
    eventSource.addEventListener('open', () => {
      onStatusChange?.('connected')
      onStatusChange?.('waiting')
    })
    eventSource.addEventListener('final-shot', handleSseFinalShot)
    eventSource.addEventListener('status', handleSseStatus)
    eventSource.addEventListener('message', handleSseMessage)
    eventSource.addEventListener('error', (event) => {
      onStatusChange?.('error')
      onError?.(event)
    })
  }

  return {
    mode: 'simread',
    disconnect: () => {
      eventSource?.close()
      target.removeEventListener(SIMREAD_FINAL_SHOT_EVENT, handleManualFinalShot)
      onStatusChange?.('disconnected')
    },
  }
}
