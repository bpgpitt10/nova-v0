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
    liveObservations?: boolean
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
  path: 'status' | 'capture-check' | 'observations' | `course-layouts?${string}`,
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

export type LooperCompanionLayoutFile = {
  fileName: string
  kind: 'main' | 'alt'
  size: number
  lastModified: number
  text: string
}

export type LooperCompanionCourseLayouts = {
  service: 'looper-companion'
  version: string
  schemaVersion: 'looper-companion-course-layouts-v1'
  courseKey: string | null
  status: 'ready' | 'not-found' | 'invalid-request' | 'unavailable'
  source?: string
  layouts: LooperCompanionLayoutFile[]
}

/**
 * The course's GKD/GKDalt text from the GSPro library, read by the companion
 * on this PC (no browser folder grant needed). Throws if no companion, or an
 * older companion without the route, is answering.
 */
export const readLooperCompanionCourseLayouts = async (
  courseKey: string,
  timeoutMs = 6000,
): Promise<LooperCompanionCourseLayouts> => {
  const data = await getCompanionReadOnly<LooperCompanionCourseLayouts>(
    `course-layouts?courseKey=${encodeURIComponent(courseKey)}`, timeoutMs)
  if (data.schemaVersion !== 'looper-companion-course-layouts-v1' || !Array.isArray(data.layouts)) {
    throw new Error('Looper Companion does not serve course layouts (update the companion).')
  }
  const valid = data.layouts.every((file) =>
    file && typeof file.fileName === 'string' && (file.kind === 'main' || file.kind === 'alt')
    && typeof file.text === 'string' && Number.isFinite(file.size) && Number.isFinite(file.lastModified))
  if (!valid) throw new Error('Looper Companion returned malformed course layouts.')
  return data
}

/** Native companion live observations are separate from course/OSM registration.
 * Only wind and lie are currently dispatched to the recommender. Raw GSPro-world
 * ball and minimap pixels remain diagnostics until actual-PC alignment is proven.
 */
export type LooperCompanionLiveObservations = {
  service: 'looper-companion'
  version: string
  /** Raw/native observations are diagnostic only. Live Caddie is authoritative. */
  stateAuthority: 'diagnostic-only'
  schemaVersion: 'native-observations-v1'
  status: 'ready' | 'unavailable'
  observedAt?: string
  gspro?: LooperCompanionGsproState
  structured?: {
    status: string
    fileAgeMs?: number | null
    shot?: {
      status: string
      kind?: string
      holeNumber?: number | null
      shotNumber?: number | null
      courseKey?: string | null
      roundId?: number | null
      shotId?: string | null
      startingWorld?: { x: number; y: number; z: number } | null
      endingWorld?: { x: number; y: number; z: number } | null
      distanceToPinYds?: number | null
    }
    layout?: {
      status: string
      par?: number | null
      teeWorld?: { x: number; y: number; z: number } | null
      pinWorld?: { x: number; y: number; z: number } | null
    }
  }
  minimap?: {
    status: string
    reason?: string | null
    minimapSide?: string | null
    ballPixel?: { x: number; y: number } | null
    pinPixel?: { x: number; y: number } | null
    scale?: { status: string; yardsPerPixel?: number; reason?: string; source?: string; waypointCount?: number; waypointSpreadPct?: number }
    waypointRuler?: {
      status: string
      reason?: string
      waypointCount?: number
      spreadPercent?: number | null
      candidates?: { pixel: { x: number; y: number }; yards: number; confidence: number; ocrVotes: number }[]
    }
    registration?: {
      status: string
      source?: string
      reason?: string
      teeScaleYardsPerPixel?: number
      currentScaleYardsPerPixel?: number
      zoomRatioCurrentToTee?: number
      rotationDegrees?: number
      pinErrorPixels?: number
      canonicalTeePixel?: { x: number; y: number }
      canonicalPinPixel?: { x: number; y: number }
      /** Maps CURRENT minimap pixels into the original tee minimap frame. */
      currentToCanonicalMatrix?: [[number, number, number], [number, number, number]]
      inliers?: number
      confidence?: number
    }
    freshness?: string
    minimapRoiWindowPixels?: number[]
    timingMs?: { markerDetection?: number; waypointCalibrationAndRegistration?: number; waypointOcr?: number | null; scaleMath?: number | null; zoomRegistration?: number | null }
  }
  timingMs?: {
    structuredDiscovery?: number
    nativeCapture?: number
    minimapTotal?: number
    markerDetection?: number | null
    waypointCalibrationAndRegistration?: number | null
    waypointOcr?: number | null
    scaleMath?: number | null
    zoomRegistration?: number | null
    windOcr?: number
    lieOcr?: number
    total?: number
  }
  ocr?: {
    wind?: import('./gsproWindObservation').GsproWindOcrPayload
    lie?: import('./gsproLieObservation').GsproLieOcrPayload
  }
  capabilities?: { autoAim: false }
}

export const readLooperCompanionObservations = async (timeoutMs = 45000) => {
  const data = await getCompanionReadOnly<LooperCompanionLiveObservations>('observations', timeoutMs)
  if (data.schemaVersion !== 'native-observations-v1' ||
      data.stateAuthority !== 'diagnostic-only' ||
      data.capabilities?.autoAim !== false ||
      !['ready', 'unavailable'].includes(data.status) ||
      !data.structured || !data.minimap || !data.ocr) {
    throw new Error('Companion did not provide a complete native observations snapshot.')
  }
  return data
}

export type LooperNativeObservationConnection = { disconnect: () => void }

export const connectToLooperNativeObservations = ({
  onObservation, onError,
}: {
  onObservation?: (value: LooperCompanionLiveObservations) => void
  onError?: (error: unknown) => void
}): LooperNativeObservationConnection => {
  let stopped = false
  let pending = false
  let timer: number | null = null
  const refresh = async () => {
    if (stopped || pending || document.hidden) return
    pending = true
    try {
      const result = await readLooperCompanionObservations()
      if (stopped) return
      onObservation?.(result)
      // Do not consume unproven ball or pin pixel readings as world/OSM positions.
      // HUD values share the existing tested projection and source normalization.
      if (result.status === 'ready' && result.ocr) {
        const { dispatchGsproWindOcrObservation } = await import('./gsproWindObservation')
        const { dispatchGsproLieOcrObservation } = await import('./gsproLieObservation')
        if (stopped) return
        if (result.ocr.wind) dispatchGsproWindOcrObservation(result.ocr.wind)
        if (result.ocr.lie) dispatchGsproLieOcrObservation(result.ocr.lie)
      }
    } catch (error) {
      if (!stopped) onError?.(error)
    } finally {
      pending = false
    }
  }
  void refresh()
  timer = window.setInterval(() => { void refresh() }, 16000)
  return {
    disconnect: () => {
      stopped = true
      if (timer != null) window.clearInterval(timer)
    },
  }
}
