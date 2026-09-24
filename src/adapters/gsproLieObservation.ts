import type { GsproLieObservation, LiveStateStatus } from '../liveState/types'

export const GSPRO_LIE_OCR_BROWSER_EVENT = 'looper:gspro-lie-ocr'

export type GsproLieOcrPayload = {
  status?: LiveStateStatus
  surface?: string | null
  upDownDegrees?: number | null
  leftRightDegrees?: number | null
  observedAt?: string | null
  confidence?: number | null
  rawText?: string | null
  note?: string | null
}

export type GsproLieObservationConnection = {
  disconnect: () => void
  getLatest: () => GsproLieObservation | null
}

export type ConnectGsproLieObservationOptions = {
  onObservation: (observation: GsproLieObservation | null) => void
  onError?: (error: unknown) => void
  staleAfterMs?: number
}

const HELPER_LIE_URL = 'http://127.0.0.1:8787/lie'

type LoopbackRequestInit = RequestInit & { targetAddressSpace?: 'loopback' }
const LOOPBACK_FETCH_INIT: LoopbackRequestInit = {
  cache: 'no-store',
  targetAddressSpace: 'loopback',
}
const HELPER_POLL_INTERVAL_MS = 2500
const DEFAULT_STALE_AFTER_MS = 7000
const STALE_CHECK_INTERVAL_MS = 500
const SOURCE = 'GSPro minimap HUD OCR'

const SURFACE_PATTERNS: Array<[string, RegExp]> = [
  ['deep rough', /\bDEEP\s+ROUGH\b/],
  ['fairway', /\bFAIRWAY\b/],
  ['rough', /\bROUGH\b/],
  ['green', /\bGREEN\b/],
  ['fringe', /\bFRINGE\b/],
  ['sand', /\bSAND\b/],
  ['bunker', /\bBUNKER\b/],
  ['tee', /\bTEE\b/],
]

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const validStatus = (value: unknown): value is LiveStateStatus =>
  value === 'READY'
  || value === 'STALE'
  || value === 'UNKNOWN'
  || value === 'UNAVAILABLE'

const observedAtOrNow = (value: unknown) => {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value
  return new Date().toISOString()
}

const normalizedSurface = (value: unknown) => {
  if (typeof value !== 'string') return null
  const surface = value.trim().toLowerCase().replace(/\s+/g, ' ')
  return surface || null
}

const parseSignedAxis = (
  normalized: string,
  positive: string,
  negative: string,
  layout: 'prefix' | 'suffix',
): number | null => {
  const number = '(-?\\d{1,2}(?:[\\.,]\\d+)?)'
  const unit = '\\s*(?:°|º|DEG(?:REE)?S?|O)?\\s*'
  const expression = layout === 'prefix'
    ? new RegExp(`\\b(${positive}|${negative})\\b${unit}${number}`)
    : new RegExp(`${number}${unit}\\b(${positive}|${negative})\\b`)
  const match = normalized.match(expression)
  if (!match) return null

  const label = layout === 'prefix' ? match[1] : match[2]
  const rawNumber = layout === 'prefix' ? match[2] : match[1]
  const value = Math.abs(Number(rawNumber.replace(',', '.')))
  if (!Number.isFinite(value)) return null
  return label === positive ? value : -value
}

export const parseGsproLieRawText = (rawText: string) => {
  const normalized = rawText.toUpperCase().replace(/\s+/g, ' ').trim()
  const prefix = {
    upDownDegrees: parseSignedAxis(normalized, 'UP', 'DOWN', 'prefix'),
    leftRightDegrees: parseSignedAxis(normalized, 'RIGHT', 'LEFT', 'prefix'),
  }
  const suffix = {
    upDownDegrees: parseSignedAxis(normalized, 'UP', 'DOWN', 'suffix'),
    leftRightDegrees: parseSignedAxis(normalized, 'RIGHT', 'LEFT', 'suffix'),
  }
  const prefixScore = Number(prefix.upDownDegrees != null) + Number(prefix.leftRightDegrees != null)
  const suffixScore = Number(suffix.upDownDegrees != null) + Number(suffix.leftRightDegrees != null)
  const axes = prefixScore > suffixScore ? prefix : suffix
  const surface = SURFACE_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null

  return {
    surface,
    upDownDegrees: axes.upDownDegrees,
    leftRightDegrees: axes.leftRightDegrees,
  }
}

export const normalizeGsproLieOcrPayload = (
  payload: GsproLieOcrPayload | null | undefined,
): GsproLieObservation => {
  const observedAt = observedAtOrNow(payload?.observedAt)
  const requestedStatus = validStatus(payload?.status) ? payload.status : 'READY'
  const rawText = typeof payload?.rawText === 'string' ? payload.rawText : null
  const reparsed = rawText ? parseGsproLieRawText(rawText) : null
  const surface = normalizedSurface(reparsed?.surface ?? payload?.surface)
  const upDownDegrees = reparsed?.upDownDegrees ?? (finite(payload?.upDownDegrees) ? payload!.upDownDegrees! : null)
  const leftRightDegrees = reparsed?.leftRightDegrees ?? (finite(payload?.leftRightDegrees) ? payload!.leftRightDegrees! : null)
  const confidence = finite(payload?.confidence)
    && payload!.confidence! >= 0
    && payload!.confidence! <= 1
    ? payload!.confidence!
    : null
  const note = typeof payload?.note === 'string' ? payload.note : undefined

  if (requestedStatus === 'UNAVAILABLE' || requestedStatus === 'STALE') {
    return {
      surface,
      upDownDegrees,
      leftRightDegrees,
      observedAt,
      source: SOURCE,
      status: requestedStatus,
      confidence,
      rawText,
      note,
    }
  }

  const missing: string[] = []
  if (upDownDegrees == null) missing.push('up/down angle')
  if (leftRightDegrees == null) missing.push('left/right angle')

  return {
    surface,
    upDownDegrees,
    leftRightDegrees,
    observedAt,
    source: SOURCE,
    status: missing.length > 0 ? 'UNKNOWN' : 'READY',
    confidence,
    rawText,
    note: [
      note,
      requestedStatus === 'UNKNOWN' && missing.length === 0
        ? 'Raw OCR text was reparsed successfully by the canonical client parser.'
        : null,
      missing.length > 0 ? `Incomplete lie OCR observation: missing ${missing.join(', ')}.` : null,
    ].filter(Boolean).join(' ') || undefined,
  }
}

const staleObservation = (
  observation: GsproLieObservation,
  staleAfterMs: number,
  nowMs = Date.now(),
): GsproLieObservation => {
  if (observation.status !== 'READY') return observation
  const observedMs = Date.parse(observation.observedAt)
  if (!Number.isFinite(observedMs) || nowMs - observedMs <= staleAfterMs) return observation
  return {
    ...observation,
    status: 'STALE',
    note: [
      observation.note,
      `No fresh HUD lie OCR observation within ${staleAfterMs} ms.`,
    ].filter(Boolean).join(' '),
  }
}

export const dispatchGsproLieOcrObservation = (payload: GsproLieOcrPayload) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<GsproLieOcrPayload>(GSPRO_LIE_OCR_BROWSER_EVENT, {
    detail: payload,
  }))
}

export const connectToGsproLieObservation = ({
  onObservation,
  onError,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
}: ConnectGsproLieObservationOptions): GsproLieObservationConnection => {
  let disconnected = false
  let latest: GsproLieObservation | null = null
  let helperPollInFlight = false

  const publish = (payload: GsproLieOcrPayload | null | undefined) => {
    if (disconnected) return
    latest = normalizeGsproLieOcrPayload(payload)
    onObservation(latest)
  }

  const browserListener = (event: Event) => {
    publish((event as CustomEvent<GsproLieOcrPayload>).detail)
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(GSPRO_LIE_OCR_BROWSER_EVENT, browserListener)
  }

  // Looper is a browser app. GSPro OCR comes from an independently-run
  // localhost HTTP service and is consumed directly by the browser.
  const pollHelper = async () => {
    if (disconnected || helperPollInFlight || typeof window === 'undefined') return
    helperPollInFlight = true
    try {
      const response = await fetch(HELPER_LIE_URL, LOOPBACK_FETCH_INIT)
      if (!response.ok) {
        publish({
          status: 'UNAVAILABLE',
          observedAt: new Date().toISOString(),
          note: `Lie helper returned HTTP ${response.status}.`,
        })
        return
      }
      const payload = await response.json() as GsproLieOcrPayload
      publish(payload)
    } catch (error) {
      onError?.(error)
      publish({
        status: 'UNAVAILABLE',
        observedAt: new Date().toISOString(),
        note: `Lie helper is unreachable: ${error instanceof Error ? error.message : String(error)}`,
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
        window.removeEventListener(GSPRO_LIE_OCR_BROWSER_EVENT, browserListener)
        if (helperPollTimer != null) window.clearInterval(helperPollTimer)
        if (staleTimer != null) window.clearInterval(staleTimer)
      }
    },
  }
}
