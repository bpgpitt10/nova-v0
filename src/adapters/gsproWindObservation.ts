import type {
  LiveStateStatus,
  WindDirectionConvention,
  WindObservation,
  WindReferenceFrame,
} from '../liveState/types'
import { LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT } from '../liveCaddie/roundRuntime'

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

// Visual OCR is shot-driven now. A successful wind read belongs to the current
// shot until canonical shot state advances or visual capture is disconnected.
const DEFAULT_STALE_AFTER_MS = Number.POSITIVE_INFINITY
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
  const referenceFrame = validReferenceFrame(payload?.referenceFrame)
    ? payload.referenceFrame
    : null
  const requestedConvention = validConvention(payload?.convention) ? payload.convention : null
  // GSPro's compass HUD label is the direction the wind is coming FROM.
  // Normalize that contract here so downstream projection math receives the
  // same convention regardless of what an OCR producer happened to tag it as.
  const convention: WindDirectionConvention | null = referenceFrame === 'compass'
    ? 'from'
    : requestedConvention
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
      `No fresh browser HUD OCR observation within ${staleAfterMs} ms.`,
    ].filter(Boolean).join(' '),
  }
}

const staleForNextShot = (observation: WindObservation): WindObservation => ({
  ...observation,
  status: 'STALE',
  note: [
    observation.note,
    'Canonical shot state advanced; waiting for fresh wind OCR for this shot.',
  ].filter(Boolean).join(' '),
})

export const dispatchGsproWindOcrObservation = (payload: GsproWindOcrPayload) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<GsproWindOcrPayload>(GSPRO_WIND_OCR_BROWSER_EVENT, {
    detail: payload,
  }))
}

export const connectToGsproWindObservation = ({
  onObservation,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
}: ConnectGsproWindObservationOptions): GsproWindObservationConnection => {
  let disconnected = false
  let latest: WindObservation | null = null

  const publish = (payload: GsproWindOcrPayload | null | undefined) => {
    if (disconnected) return
    const next = normalizeGsproWindOcrPayload(payload)

    // Once a field is READY for this shot, freeze it. Repeated OCR passes must not
    // change the caddie answer. The canonical shot-state event below is the only
    // thing that unlocks the value by marking it STALE for the next shot.
    if (latest?.status === 'READY') {
      if (next.status === 'READY' || next.status === 'UNKNOWN') return
    }

    // If the new shot has already marked the prior value STALE, failed OCR retries
    // leave that stale value in place until a retry actually succeeds.
    if (next.status === 'UNKNOWN' && latest?.status === 'STALE') return

    latest = next
    onObservation(latest)
  }

  const browserListener = (event: Event) => {
    publish((event as CustomEvent<GsproWindOcrPayload>).detail)
  }

  const shotStateListener = () => {
    if (disconnected || !latest || latest.status !== 'READY') return
    latest = staleForNextShot(latest)
    onObservation(latest)
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(GSPRO_WIND_OCR_BROWSER_EVENT, browserListener)
    window.addEventListener(LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT, shotStateListener)
  }

  const staleTimer = typeof window !== 'undefined' && Number.isFinite(staleAfterMs)
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
        window.removeEventListener(LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT, shotStateListener)
        if (staleTimer != null) window.clearInterval(staleTimer)
      }
    },
  }
}
