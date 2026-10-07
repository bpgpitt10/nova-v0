/** Read-only browser bridge to the optional per-user Windows Looper Companion. */
export type LooperCompanionGsproState = {
  status: 'connected' | 'waiting' | 'ambiguous'
  reason?: string
  processCount?: number
  pid?: number
  processName?: string
  windowTitle?: string
  window?: {
    foreground: boolean
    minimized: boolean
    dpiAwareness?: 'per-monitor' | 'unverified'
    bounds: { left: number; top: number; width: number; height: number }
  }
}

export type LooperCompanionDataFolder = {
  status: 'ready' | 'partial' | 'not-found'
  source: string | null
  files: {
    'currentRound.dat': boolean
    'output_log.txt': boolean
    'GSPro.db': boolean
  }
  reason?: string | null
}

export type LooperCompanionStatus = {
  service: 'looper-companion'
  status: 'ready'
  version: string
  gspro: LooperCompanionGsproState
  dataFolder: LooperCompanionDataFolder
  capabilities: {
    windowDiscovery: boolean
    folderDiscovery: boolean
    captureDiagnostic: boolean
    nativeCapture: boolean
    autoAim: boolean
  }
}

export type LooperCompanionCaptureDiagnostic = {
  service: 'looper-companion'
  version: string
  windowCapture: {
    status: 'captured' | 'unsupported' | 'not-connected' | 'unavailable' | 'busy' | 'error'
    method: string
    reason?: string | null
    windowWidth?: number
    windowHeight?: number
    foreground?: boolean
    quality?: {
      nonblank: boolean
      darkFraction: number
      colorBuckets: number
      brightnessRange: number
      sampleCount: number
    }
  }
}

const LOCAL_BASE = 'http://127.0.0.1:8787/companion/v1'
export const LOOPER_COMPANION_STATUS_URL = `${LOCAL_BASE}/status`

const getCompanionReadOnly = async <T>(
  path: 'status' | 'capture-check',
  timeoutMs: number,
): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 200) {
    throw new Error('Invalid companion connection timeout.')
  }
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const request = new Request(`${LOCAL_BASE}/${path}`, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal,
      // Chromium Local Network Access uses a per-site permission for loopback.
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
    const status = data as Record<string, unknown>
    if (status.service !== 'looper-companion' || typeof status.version !== 'string') {
      throw new Error('Another service is answering the companion port.')
    }
    return data as T
  } finally {
    window.clearTimeout(timeoutId)
  }
}

export const readLooperCompanionStatus = async (
  timeoutMs = 3500,
): Promise<LooperCompanionStatus> => {
  const data = await getCompanionReadOnly<LooperCompanionStatus>('status', timeoutMs)
  if (
    data.status !== 'ready' ||
    !data.gspro ||
    !['connected', 'waiting', 'ambiguous'].includes(data.gspro.status) ||
    !data.dataFolder ||
    !['ready', 'partial', 'not-found'].includes(data.dataFolder.status) ||
    data.capabilities?.autoAim !== false
  ) {
    throw new Error('Looper Companion is not running the expected read-only Stage B protocol.')
  }
  return data
}

export const readLooperCompanionCaptureDiagnostic = async (
  timeoutMs = 8500,
): Promise<LooperCompanionCaptureDiagnostic> => {
  const data = await getCompanionReadOnly<LooperCompanionCaptureDiagnostic>('capture-check', timeoutMs)
  if (!data.windowCapture || typeof data.windowCapture.status !== 'string') {
    throw new Error('Looper Companion returned no capture diagnostic result.')
  }
  return data
}
