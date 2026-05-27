import type { SimReadFinalShotEvent } from './simreadFinalShot'

const SIMREAD_FINAL_SHOT_EVENT = 'looper:simread-final-shot'
const SIMREAD_EVENT_TARGET_KEY = '__looperSimReadEventTarget'
const SIMREAD_DISPATCH_KEY = '__looperDispatchSimReadFinalShot'

export type SimReadLiveStatus =
  | 'idle'
  | 'connected'
  | 'waiting'
  | 'received-shot'
  | 'error'
  | 'disconnected'

export type SimReadLiveConnection = {
  mode: 'simread'
  disconnect: () => void
}

export type ConnectToSimReadEventsOptions = {
  onFinalShot: (event: SimReadFinalShotEvent) => void
  onStatusChange?: (status: SimReadLiveStatus) => void
  onError?: (error: unknown) => void
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

export const connectToSimReadEvents = ({
  onFinalShot,
  onStatusChange,
  onError,
}: ConnectToSimReadEventsOptions): SimReadLiveConnection => {
  onStatusChange?.('idle')
  const target = getSimReadEventTarget()
  installDevDispatchHelper()

  const handleFinalShot = (event: Event) => {
    try {
      const finalShotEvent = (event as CustomEvent<SimReadFinalShotEvent>).detail
      onStatusChange?.('received-shot')
      onFinalShot(finalShotEvent)
      onStatusChange?.('waiting')
    } catch (error) {
      onStatusChange?.('error')
      onError?.(error)
    }
  }

  target.addEventListener(SIMREAD_FINAL_SHOT_EVENT, handleFinalShot)
  onStatusChange?.('connected')
  onStatusChange?.('waiting')

  return {
    mode: 'simread',
    disconnect: () => {
      target.removeEventListener(SIMREAD_FINAL_SHOT_EVENT, handleFinalShot)
      onStatusChange?.('disconnected')
    },
  }
}
