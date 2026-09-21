import type {
  LiveStateStatus,
  WindDirectionConvention,
  WindObservation,
  WindReferenceFrame,
} from '../liveState/types'

export const GSPRO_WIND_OCR_BROWSER_EVENT = 'looper:gspro-wind-ocr'

export type GsproWindOcrPayload = {
  status?: LiveStateStatus
  speedMph?: number | null
  directionDegrees?: number | null
  convention?: WindDirectionConvention | null
  referenceFrame?: WindReferenceFrame | null
  observedAt?: string | null
  confidence?: number | null
  rawText?: string | null
  note?: string | null
}

export type GsproWindObservationConnection = {
  disconnect: () => void
  getLatest: () => WindObservation | null
}

export type ConnectGsproWindObservationOptions = {
  onObservation: (observation: WindObservation | null) => void
  onError?: (error: unknown) => void
  staleAfterMs?: number
}

const HELPER_WIND_URL = 'http://127.0.0.1:8787/wind'
const HELPER_POLL_INTERVAL_MS = 2500
const DEFAULT_STALE_AFTER_MS = 7000
const STALE_CHECK_INTERVAL_MS = 500
const SOURCE = 'GSPro HUD OCR'

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const normalizeDegrees = (value: number) => ((value % 360) + 360) % 360

const validConvention = (value: unknown): value is WindDirectionConvention =>
  value === 'from' || value === 'toward'

const validReferenceFrame = (value: unknown): value is WindReferenceFrame =>
  value === 'shot-relative'
  || value === 'hole-local'
  || value === 'compass'
  || value === 'unknown'

const validStatus = (value: unknown): value is LiveStateStatus =>
  value === 'READY'
  || value === 'STALE'
  || value === 'UNKNOWN'
  || value === 'UNAVAILABLE'

const observedAtOrNow = (value: unknown) => {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value
  return new Date().toISOString()
}

export const normalizeGsproWindOcrPayload = (
  payload: GsproWindOcrPayload | null | undefined,
): WindObservation => {
  const observedAt = observedAtOrNow(payload?.observedAt)
  const requestedStatus = validStatus(payload?.status) ? payload.status : 'READY'
  const speedMph = finite(payload?.speedMph) && payload!.speedMph! >= 0
    ? payload!.speedMph!
    : null
  const directionDegrees = finite(payload?.directionDegrees)
    ? normalizeDegrees(payload!.directionDegrees!)
    : null
  const convention = validConvention(payload?.convention) ? payload.convention : null
  const referenceFrame = validReferenceFrame(payload?.referenceFrame)
    ? payload.referenceFrame
    : null
  const confidence = finite(payload?.confidence)
    && payload!.confidence! >= 0
    && payload!.confidence! <= 1
    ? payload!.confidence!
    : null
  const rawText = typeof payload?.rawText === 'string' ? payload.rawText : null
  const note = typeof payload?.note === 'string' ? payload.note : undefined

  if (requestedStatus === 'UNAVAILABLE' || requestedStatus === 'STALE') {
    return {
      speedMph,
      directionDegrees,
      convention,
      referenceFrame,
      observedAt,
      source: SOURCE,
      status: requestedStatus,
      confidence,
      rawText,
      note,
    }
  }

  const missing: string[] = []
  if (speedMph == null) missing.push('speed')
  if (directionDegrees == null) missing.push('direction')
  if (!convention) missing.push('from/toward convention')
  if (!referenceFrame || referenceFrame === 'unknown') missing.push('reference frame')

  return {
    speedMph,
    directionDegrees,
    convention,
    referenceFrame,
    observedAt,
    source: SOURCE,
    status: requestedStatus === 'UNKNOWN' || missing.length > 0 ? 'UNKNOWN' : 'READY',
    confidence,
    rawText,
    note: [
      note,
      missing.length > 0 ? `Incomplete OCR observation: missing ${missing.join(', ')}.` : null,
    ].filter(Boolean).join(' ') || undefined,
  }
}

const staleObservation = (
  observation: WindObservation,
  staleAfterMs: number,
  nowMs = Date.now(),
): WindObservation => {
  if (observation.status !== 'READY') return observation
  const observedMs = Date.parse(observation.observedAt)
  if (!Number.isFinite(observedMs) || nowMs - observedMs <= staleAfterMs) return observation
  return {
    ...observation,
    status: 'STALE',
    note: [
      observation.note,
      `No fresh HUD OCR observation within ${staleAfterMs} ms.`,
    ].filter(Boolean).join(' '),
  }
}

export const dispatchGsproWindOcrObservation = (payload: GsproWindOcrPayload) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<GsproWindOcrPayload>(GSPRO_WIND_OCR_BROWSER_EVENT, {
    detail: payload,
  }))
}

export const connectToGsproWindObservation = ({
  onObservation,
  onError,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
}: ConnectGsproWindObservationOptions): GsproWindObservationConnection => {
  let disconnected = false
  let latest: WindObservation | null = null
  let helperPollInFlight = false

  const publish = (payload: GsproWindOcrPayload | null | undefined) => {
    if (disconnected) return
    latest = normalizeGsproWindOcrPayload(payload)
    onObservation(latest)
  }

  const browserListener = (event: Event) => {
    publish((event as CustomEvent<GsproWindOcrPayload>).detail)
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(GSPRO_WIND_OCR_BROWSER_EVENT, browserListener)
  }

  // Looper is a browser app. GSPro OCR is supplied by an independently-run
  // localhost HTTP service; the web app never depends on a native app shell.
  const pollHelper = async () => {
    if (disconnected || helperPollInFlight || typeof window === 'undefined') return
    helperPollInFlight = true
    try {
      const response = await fetch(HELPER_WIND_URL, { cache: 'no-store' })
      if (!response.ok) {
        publish({
          status: 'UNAVAILABLE',
          observedAt: new Date().toISOString(),
          note: `Wind helper returned HTTP ${response.status}.`,
        })
        return
      }
      const payload = await response.json() as GsproWindOcrPayload
      publish(payload)
    } catch (error) {
      onError?.(error)
      publish({
        status: 'UNAVAILABLE',
        observedAt: new Date().toISOString(),
        note: `Wind helper is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      helperPollInFlight = false
    }
  }

  if (typeof window !== 'undefined') void pollHelper()
  const helperPollTimer = typeof window !== 'undefined'
    ? window.setInterval(() => void pollHelper(), HELPER_POLL_INTERVAL_MS)
    : null

  const staleTimer = typeof window !== 'undefined'
    ? window.setInterval(() => {
        if (!latest || disconnected) return
        const next = staleObservation(latest, staleAfterMs)
        if (next.status !== latest.status) {
          latest = next
          onObservation(latest)
        }
      }, STALE_CHECK_INTERVAL_MS)
    : null

  return {
    getLatest: () => latest,
    disconnect: () => {
      if (disconnected) return
      disconnected = true
      if (typeof window !== 'undefined') {
        window.removeEventListener(GSPRO_WIND_OCR_BROWSER_EVENT, browserListener)
        if (helperPollTimer != null) window.clearInterval(helperPollTimer)
        if (staleTimer != null) window.clearInterval(staleTimer)
      }
    },
  }
}
