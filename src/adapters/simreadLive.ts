import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { SimReadFinalShotEvent } from './simreadFinalShot'

const SIMREAD_FINAL_SHOT_EVENT = 'looper:simread-final-shot'
const SIMREAD_EVENT_TARGET_KEY = '__looperSimReadEventTarget'
const SIMREAD_DISPATCH_KEY = '__looperDispatchSimReadFinalShot'
const SIMREAD_SSE_EVENT_NAME = 'simread-sse-event'
const SIMREAD_SSE_ERROR_NAME = 'simread-sse-error'
export const DEFAULT_SIMREAD_EVENTS_URL = 'http://127.0.0.1:8788/events'
export const DEV_SIMREAD_EVENTS_PROXY_URL = '/simread/events'

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

type SimReadTauriSsePayload = {
  event: string
  data: string
}

type SimReadTauriSseErrorPayload = {
  events_url: string
  message: string
}

type SimReadWindow = Window &
  typeof globalThis & {
    [SIMREAD_EVENT_TARGET_KEY]?: EventTarget
    [SIMREAD_DISPATCH_KEY]?: (event: SimReadFinalShotEvent) => void
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: {
      invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>
    }
  }

const getWindow = (): SimReadWindow | null =>
  typeof window === 'undefined' ? null : (window as SimReadWindow)

const isTauriRuntime = () => {
  const simreadWindow = getWindow()
  if (!simreadWindow) {
    return false
  }

  return (
    Boolean(simreadWindow.__TAURI__) ||
    Boolean(simreadWindow.__TAURI_INTERNALS__) ||
    simreadWindow.location.protocol === 'tauri:' ||
    simreadWindow.location.hostname === 'tauri.localhost'
  )
}

const shouldUseTauriSseBridge = () => isTauriRuntime() && !import.meta.env.DEV

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

  const envUrl = (import.meta.env.VITE_SIMREAD_EVENTS_URL as string | undefined)?.trim()
  if (envUrl) {
    return envUrl
  }

  if (shouldUseTauriSseBridge()) {
    return DEFAULT_SIMREAD_EVENTS_URL
  }

  return import.meta.env.DEV ? DEV_SIMREAD_EVENTS_PROXY_URL : DEFAULT_SIMREAD_EVENTS_URL
}

const logSimReadInfo = (message: string, detail?: Record<string, unknown>) => {
  console.info(message, detail ?? {})
}

const logSimReadError = (message: string, detail?: Record<string, unknown>) => {
  console.error(message, detail ?? {})
}

const appendSimReadBridgeLog = (event: string, payload?: Record<string, unknown>) => {
  logSimReadInfo(`[SimRead SSE][${event}]`, payload)
  const tauriInvoke = getWindow()?.__TAURI_INTERNALS__?.invoke
  if (typeof tauriInvoke !== 'function') {
    return
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    source: 'frontend',
    event,
    payload: payload ?? {},
  })

  void tauriInvoke('append_simread_sse_bridge_log', { line }).catch((error: unknown) => {
    logSimReadError('[SimRead SSE] failed to append bridge diagnostic log', { error })
  })
}

const parseFinalShotEvent = (data: string): SimReadFinalShotEvent => {
  const parsed: unknown = JSON.parse(data)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('SimRead final-shot SSE data was not an object')
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
  logSimReadInfo('[SimRead SSE] adapter starting', {
    eventsUrl: resolvedEventsUrl,
    isDev: import.meta.env.DEV,
    isTauriRuntime: isTauriRuntime(),
    transport: shouldUseTauriSseBridge() ? 'tauri-bridge' : 'eventsource',
  })
  appendSimReadBridgeLog('adapter_starting', {
    eventsUrl: resolvedEventsUrl,
    isDev: import.meta.env.DEV,
    hasTauriGlobal: Boolean(getWindow()?.__TAURI__),
    hasTauriInternals: Boolean(getWindow()?.__TAURI_INTERNALS__),
    protocol: getWindow()?.location.protocol,
    hostname: getWindow()?.location.hostname,
    isTauriRuntime: isTauriRuntime(),
    transport: shouldUseTauriSseBridge() ? 'tauri-bridge' : 'eventsource',
  })

  const handleFinalShot = (event: SimReadFinalShotEvent) => {
    try {
      logSimReadInfo('[SimRead SSE] onFinalShot callback dispatch', {
        rowId: event.rowId,
        source: event.source,
      })
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
      logSimReadInfo('[SimRead SSE] final-shot event received', {
        dataPreview: event.data.slice(0, 500),
      })
      const finalShotEvent = parseFinalShotEvent(event.data)
      logSimReadInfo('[SimRead SSE] parsed final-shot event', {
        rowId: finalShotEvent.rowId,
        source: finalShotEvent.source,
      })
      handleFinalShot(finalShotEvent)
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
        const finalShotEvent = parsed as SimReadFinalShotEvent
        logSimReadInfo('[SimRead SSE] parsed final-shot message event', {
          rowId: finalShotEvent.rowId,
          source: finalShotEvent.source,
        })
        handleFinalShot(finalShotEvent)
      }
    } catch {
      // Ignore generic heartbeat/message payloads that are not JSON events.
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

  const handleSsePayload = (payload: SimReadTauriSsePayload) => {
    logSimReadInfo('[SimRead SSE] Tauri payload received', {
      eventName: payload.event,
      dataPreview: payload.data.slice(0, 300),
    })
    const messageEvent = { data: payload.data } as MessageEvent<string>
    if (payload.event === 'final-shot') {
      handleSseFinalShot(messageEvent)
      return
    }

    if (payload.event === 'status') {
      handleSseStatus(messageEvent)
      return
    }

    handleSseMessage(messageEvent)
  }

  if (shouldUseTauriSseBridge()) {
    let unlistenPayload: UnlistenFn | null = null
    let unlistenError: UnlistenFn | null = null
    let disconnected = false

    appendSimReadBridgeLog('bridge_path_selected', {
      payloadEventName: SIMREAD_SSE_EVENT_NAME,
      errorEventName: SIMREAD_SSE_ERROR_NAME,
      eventsUrl: resolvedEventsUrl,
    })

    const attachListeners = Promise.all([
      listen<SimReadTauriSsePayload>(SIMREAD_SSE_EVENT_NAME, (event) => {
        if (!disconnected) {
          handleSsePayload(event.payload)
        }
      }),
      listen<SimReadTauriSseErrorPayload>(SIMREAD_SSE_ERROR_NAME, (event) => {
        if (disconnected) {
          return
        }
        logSimReadError('[SimRead SSE] Tauri bridge error', {
          eventsUrl: event.payload.events_url,
          message: event.payload.message,
        })
        onStatusChange?.('error')
        onError?.(new Error(event.payload.message))
      }),
    ])

    void attachListeners
      .then(([payloadUnlisten, errorUnlisten]) => {
        if (disconnected) {
          payloadUnlisten()
          errorUnlisten()
          return null
        }
        unlistenPayload = payloadUnlisten
        unlistenError = errorUnlisten
        logSimReadInfo('[SimRead SSE] Tauri listeners attached', {
          payloadEventName: SIMREAD_SSE_EVENT_NAME,
          errorEventName: SIMREAD_SSE_ERROR_NAME,
          eventsUrl: resolvedEventsUrl,
        })
        appendSimReadBridgeLog('listeners_attached_before_invoke', {
          payloadEventName: SIMREAD_SSE_EVENT_NAME,
          errorEventName: SIMREAD_SSE_ERROR_NAME,
          eventsUrl: resolvedEventsUrl,
        })
        appendSimReadBridgeLog('invoke_start_simread_event_stream_attempt', {
          eventsUrl: resolvedEventsUrl,
        })
        return invoke('start_simread_event_stream', { eventsUrl: resolvedEventsUrl })
      })
      .then((result) => {
        if (!result) {
          return
        }
        logSimReadInfo('[SimRead SSE] Tauri bridge started', {
          result,
          eventsUrl: resolvedEventsUrl,
        })
        appendSimReadBridgeLog('invoke_start_simread_event_stream_success', {
          result: result as Record<string, unknown>,
          eventsUrl: resolvedEventsUrl,
        })
        if (!disconnected) {
          onStatusChange?.('connected')
          onStatusChange?.('waiting')
        }
      })
      .catch((error) => {
        logSimReadError('[SimRead SSE] Tauri bridge failed to start', {
          eventsUrl: resolvedEventsUrl,
          error,
        })
        appendSimReadBridgeLog('invoke_start_simread_event_stream_failure', {
          eventsUrl: resolvedEventsUrl,
          error: error instanceof Error ? error.message : String(error),
        })
        if (!disconnected) {
          onStatusChange?.('error')
          onError?.(error)
        }
      })

    return {
      mode: 'simread',
      disconnect: () => {
        disconnected = true
        logSimReadInfo('[SimRead SSE] disconnecting', {
          eventsUrl: resolvedEventsUrl,
          transport: 'tauri-bridge',
        })
        unlistenPayload?.()
        unlistenError?.()
        void invoke('stop_simread_event_stream').catch((error) => {
          logSimReadError('[SimRead SSE] Tauri bridge stop failed', { error })
        })
        target.removeEventListener(SIMREAD_FINAL_SHOT_EVENT, handleManualFinalShot)
        onStatusChange?.('disconnected')
      },
    }
  }

  if (typeof EventSource === 'undefined') {
    const error = new Error('EventSource is not available in this browser')
    onStatusChange?.('error')
    onError?.(error)
  } else {
    eventSource = new EventSource(resolvedEventsUrl)
    eventSource.addEventListener('open', () => {
      logSimReadInfo('[SimRead SSE] EventSource open', { eventsUrl: resolvedEventsUrl })
      onStatusChange?.('connected')
      onStatusChange?.('waiting')
    })
    eventSource.addEventListener('final-shot', handleSseFinalShot)
    eventSource.addEventListener('status', handleSseStatus)
    eventSource.addEventListener('message', handleSseMessage)
    eventSource.addEventListener('error', (event) => {
      logSimReadError('[SimRead SSE] EventSource error', {
        eventsUrl: resolvedEventsUrl,
        readyState: eventSource?.readyState,
        eventType: event.type,
      })
      onStatusChange?.('error')
      onError?.(event)
    })
  }

  return {
    mode: 'simread',
    disconnect: () => {
      logSimReadInfo('[SimRead SSE] disconnecting', { eventsUrl: resolvedEventsUrl })
      eventSource?.close()
      target.removeEventListener(SIMREAD_FINAL_SHOT_EVENT, handleManualFinalShot)
      onStatusChange?.('disconnected')
    },
  }
}
