/** Read-only Stage A bridge to the optional Windows Looper Companion. */
export type LooperCompanionGsproState = {
  status: 'connected' | 'waiting' | 'ambiguous'
  reason?: string
  processCount?: number
  pid?: number
  processName?: string
  windowTitle?: string
}

export type LooperCompanionStatus = {
  service: 'looper-companion'
  status: 'ready'
  version: string
  gspro: LooperCompanionGsproState
  capabilities: {
    windowDiscovery: boolean
    folderDiscovery: boolean
    nativeCapture: boolean
    autoAim: boolean
  }
}

export const LOOPER_COMPANION_STATUS_URL =
  'http://127.0.0.1:8787/companion/v1/status'

export const readLooperCompanionStatus = async (
  timeoutMs = 3500,
): Promise<LooperCompanionStatus> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 200) {
    throw new Error('Invalid companion connection timeout.')
  }

  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    // Chrome Local Network Access (LNA) requires its own user permission for
    // an HTTPS site to reach loopback. Initiate from an explicit user action.
    const request = new Request(LOOPER_COMPANION_STATUS_URL, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal,
      targetAddressSpace: 'loopback',
    } as RequestInit & { targetAddressSpace: 'loopback' })

    const response = await fetch(request)
    if (!response.ok) {
      throw new Error(`Looper Companion responded with HTTP ${response.status}.`)
    }
    const data: unknown = await response.json()
    if (!data || typeof data !== 'object') {
      throw new Error('Looper Companion returned an invalid response.')
    }
    const status = data as Partial<LooperCompanionStatus>
    if (
      status.service !== 'looper-companion' ||
      status.status !== 'ready' ||
      typeof status.version !== 'string' ||
      !status.gspro ||
      !['connected', 'waiting', 'ambiguous'].includes(status.gspro.status)
    ) {
      throw new Error('Another service is answering the companion port.')
    }
    return status as LooperCompanionStatus
  } finally {
    window.clearTimeout(timeoutId)
  }
}
