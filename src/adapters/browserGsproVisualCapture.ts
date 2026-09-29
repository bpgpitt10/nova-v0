import {
  dispatchGsproLieOcrObservation,
  type GsproLieOcrPayload,
} from './gsproLieObservation'
import {
  dispatchGsproWindOcrObservation,
  type GsproWindOcrPayload,
} from './gsproWindObservation'
import {
  LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT,
  type LiveCaddieShotStateChangedDetail,
} from '../liveCaddie/roundRuntime'

export type BrowserGsproVisualCaptureStatus =
  | 'idle'
  | 'requesting'
  | 'loading-ocr'
  | 'connected'
  | 'stopped'
  | 'error'

export type BrowserGsproVisualCaptureConnection = {
  disconnect: () => void
  displaySurface: string | null
  sourceLabel: string | null
}

export type ConnectBrowserGsproVisualCaptureOptions = {
  onStatusChange?: (status: BrowserGsproVisualCaptureStatus) => void
  onError?: (error: unknown) => void
  initiallyPaused?: boolean
}

type TesseractWorker = {
  recognize: (image: HTMLCanvasElement) => Promise<{
    data: {
      text?: string
      confidence?: number
    }
  }>
  setParameters: (parameters: Record<string, string>) => Promise<unknown>
  terminate: () => Promise<unknown>
}

type TesseractGlobal = {
  createWorker: (
    language?: string,
    oem?: number,
    options?: Record<string, unknown>,
  ) => Promise<TesseractWorker>
}

type TesseractWindow = Window & {
  Tesseract?: TesseractGlobal
}

type DisplayTrackSettings = MediaTrackSettings & {
  displaySurface?: string
}

type LooperDisplayMediaOptions = {
  video: MediaTrackConstraints & { displaySurface?: 'window' }
  audio: false
  preferCurrentTab?: boolean
  selfBrowserSurface?: 'exclude'
  monitorTypeSurfaces?: 'include' | 'exclude'
  surfaceSwitching?: 'exclude'
}

type CropSpec = {
  x: number
  y: number
  width: number
  height: number
  scale: number
  binaryThreshold?: number
}

const TESSERACT_VERSION = '6.0.1'
const TESSERACT_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`
const TESSERACT_WORKER_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`
const TESSERACT_CORE_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0'
const SHOT_OCR_SETTLE_MS = 650

const WIND_SPEED_CROP: CropSpec = {
  x: 0.444,
  y: 0.011,
  width: 0.033,
  height: 0.026,
  scale: 8,
  binaryThreshold: 190,
}

const WIND_DIRECTION_CROP: CropSpec = {
  x: 0.532,
  y: 0.011,
  width: 0.020,
  height: 0.026,
  scale: 8,
  binaryThreshold: 190,
}

const RIGHT_LIE_CROP: CropSpec = {
  x: 0.848,
  y: 0.952,
  width: 0.149,
  height: 0.040,
  scale: 6,
}

const LEFT_LIE_CROP: CropSpec = {
  x: 0.003,
  y: 0.952,
  width: 0.149,
  height: 0.040,
  scale: 6,
}

const WIND_CARDINAL_DEGREES: Record<string, number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
}

let tesseractPromise: Promise<TesseractGlobal> | null = null

const loadTesseract = () => {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Browser OCR is only available in the web app.'))
  }
  const existing = (window as TesseractWindow).Tesseract
  if (existing) return Promise.resolve(existing)
  if (tesseractPromise) return tesseractPromise

  tesseractPromise = new Promise<TesseractGlobal>((resolve, reject) => {
    const finish = () => {
      const loaded = (window as TesseractWindow).Tesseract
      if (loaded) resolve(loaded)
      else reject(new Error('Tesseract.js loaded but did not expose its browser API.'))
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[data-looper-tesseract="${TESSERACT_VERSION}"]`,
    )
    if (existingScript) existingScript.remove()

    const script = document.createElement('script')
    script.src = TESSERACT_SCRIPT_URL
    script.async = true
    script.crossOrigin = 'anonymous'
    script.dataset.looperTesseract = TESSERACT_VERSION
    script.addEventListener('load', finish, { once: true })
    script.addEventListener(
      'error',
      () => reject(new Error('Could not load browser OCR.')),
      { once: true },
    )
    document.head.appendChild(script)
  }).catch((error) => {
    tesseractPromise = null
    throw error
  })

  return tesseractPromise
}

const drawCrop = (video: HTMLVideoElement, spec: CropSpec) => {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('GSPro capture has not produced a video frame yet.')
  }

  const sx = Math.max(0, Math.floor(sourceWidth * spec.x))
  const sy = Math.max(0, Math.floor(sourceHeight * spec.y))
  const sw = Math.max(1, Math.min(sourceWidth - sx, Math.floor(sourceWidth * spec.width)))
  const sh = Math.max(1, Math.min(sourceHeight - sy, Math.floor(sourceHeight * spec.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * spec.scale))
  canvas.height = Math.max(1, Math.round(sh * spec.scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Could not create browser OCR canvas.')

  context.imageSmoothingEnabled = true
  context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)

  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  let luminanceTotal = 0
  for (let index = 0; index < image.data.length; index += 4) {
    const r = image.data[index]
    const g = image.data[index + 1]
    const b = image.data[index + 2]
    luminanceTotal += 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const averageLuminance = luminanceTotal / Math.max(1, image.data.length / 4)
  const invert = averageLuminance < 115

  for (let index = 0; index < image.data.length; index += 4) {
    const r = image.data[index]
    const g = image.data[index + 1]
    const b = image.data[index + 2]
    let value = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)

    if (spec.binaryThreshold != null) {
      value = value >= spec.binaryThreshold ? 0 : 255
    } else {
      if (invert) value = 255 - value
      value = Math.max(0, Math.min(255, Math.round((value - 128) * 1.35 + 128)))
    }

    image.data[index] = value
    image.data[index + 1] = value
    image.data[index + 2] = value
  }
  context.putImageData(image, 0, 0)
  return canvas
}

const normalizedConfidence = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value / 100))
    : null

const normalizeCardinalText = (rawText: string) => {
  const compact = rawText.toUpperCase().replace(/\s+/g, '').trim()
  const collapsed = compact.replace(/(.)\1+/g, '$1')
  return Object.prototype.hasOwnProperty.call(WIND_CARDINAL_DEGREES, collapsed)
    ? collapsed
    : null
}

const parseWindComponents = (
  speedRawText: string,
  speedConfidence: number | null,
  directionRawText: string,
  directionConfidence: number | null,
): GsproWindOcrPayload => {
  const normalizedSpeed = speedRawText.toUpperCase().replace(/\s+/g, ' ').trim()
  const speedMatch = normalizedSpeed.match(/(\d{1,2}(?:[\.,]\d+)?)/)
  const parsedSpeed = speedMatch ? Number(speedMatch[1].replace(',', '.')) : null
  const speedMph = parsedSpeed != null && Number.isFinite(parsedSpeed) && parsedSpeed >= 0 && parsedSpeed <= 50
    ? parsedSpeed
    : null
  const cardinal = normalizeCardinalText(directionRawText)
  const parsedDirectionDegrees = cardinal ? WIND_CARDINAL_DEGREES[cardinal] ?? null : null
  const calm = speedMph === 0
  const directionDegrees = calm && parsedDirectionDegrees == null ? 0 : parsedDirectionDegrees
  const confidenceValues = [speedConfidence, directionConfidence].filter(
    (value): value is number => value != null && Number.isFinite(value),
  )
  const confidence = confidenceValues.length > 0 ? Math.min(...confidenceValues) : null
  const missing: string[] = []
  if (speedMph == null) missing.push('speed')
  if (!calm && directionDegrees == null) missing.push('cardinal direction')

  return {
    status: missing.length === 0 ? 'READY' : 'UNKNOWN',
    speedMph,
    directionDegrees,
    convention: 'from',
    referenceFrame: 'compass',
    observedAt: new Date().toISOString(),
    confidence,
    rawText: `SPEED: ${speedRawText.trim()} | DIR: ${directionRawText.trim()}`,
    note: missing.length === 0
      ? calm && parsedDirectionDegrees == null
        ? 'Browser OCR read calm wind; direction is immaterial at 0 MPH.'
        : 'Browser OCR read the split GSPro wind speed and cardinal HUD labels.'
      : `Browser wind OCR was incomplete; missing ${missing.join(', ')}.`,
  }
}

type LieAxisParse = {
  value: number | null
  direction: string | null
  canonical: string | null
}

const parseLieNumber = (rawText: string) => {
  const compact = rawText.toUpperCase().replace(/\s+/g, '').replace(',', '.')
  const decimalMatch = compact.match(/(\d{1,2})\.(\d)/)
  const value = decimalMatch ? Number(`${decimalMatch[1]}.${decimalMatch[2]}`) : null
  return value != null && Number.isFinite(value) && value >= 0 && value <= 60 ? value : null
}

const parseLieDirection = (
  rawText: string,
  positive: 'UP' | 'RIGHT',
  negative: 'DOWN' | 'LEFT',
) => {
  const compact = rawText.toUpperCase().replace(/\s+/g, '')
  if (compact.includes(positive)) return positive
  if (compact.includes(negative)) return negative
  if (positive === 'UP' && (compact === 'P' || compact === 'OP' || compact === 'DP')) return 'UP'
  return null
}

const makeLieAxis = (
  numberText: string,
  directionText: string,
  positive: 'UP' | 'RIGHT',
  negative: 'DOWN' | 'LEFT',
): LieAxisParse => {
  const magnitude = parseLieNumber(numberText)
  if (magnitude == null) return { value: null, direction: null, canonical: null }
  const direction = parseLieDirection(directionText, positive, negative)
    ?? (magnitude === 0 ? positive : null)
  if (!direction) return { value: null, direction: null, canonical: null }
  const signed = direction === positive ? magnitude : -magnitude
  return {
    value: Math.round(signed * 10) / 10,
    direction,
    canonical: `${magnitude.toFixed(1)} ${direction}`,
  }
}

const axisCrop = (footer: CropSpec, offset: number, width: number): CropSpec => ({
  ...footer,
  x: footer.x + footer.width * offset,
  width: footer.width * width,
})

const liePayloadFromComponents = (
  longitudinalNumberText: string,
  longitudinalNumberConfidence: number | null,
  longitudinalDirectionText: string,
  longitudinalDirectionConfidence: number | null,
  lateralNumberText: string,
  lateralNumberConfidence: number | null,
  lateralDirectionText: string,
  lateralDirectionConfidence: number | null,
  side: 'right' | 'left',
): GsproLieOcrPayload => {
  const longitudinal = makeLieAxis(longitudinalNumberText, longitudinalDirectionText, 'UP', 'DOWN')
  const lateral = makeLieAxis(lateralNumberText, lateralDirectionText, 'RIGHT', 'LEFT')
  const confidenceValues = [
    longitudinalNumberConfidence,
    longitudinalDirectionConfidence,
    lateralNumberConfidence,
    lateralDirectionConfidence,
  ].filter((value): value is number => value != null && Number.isFinite(value))
  const confidence = confidenceValues.length > 0 ? Math.min(...confidenceValues) : null
  const canonicalParts = [longitudinal.canonical, lateral.canonical].filter(Boolean)
  const rawText = canonicalParts.length === 2
    ? canonicalParts.join(' ')
    : `LONG_NUM: ${longitudinalNumberText.trim()} LONG_DIR: ${longitudinalDirectionText.trim()} LAT_NUM: ${lateralNumberText.trim()} LAT_DIR: ${lateralDirectionText.trim()}`
  const ready = longitudinal.value != null && lateral.value != null

  return {
    status: ready ? 'READY' : 'UNKNOWN',
    surface: null,
    upDownDegrees: longitudinal.value,
    leftRightDegrees: lateral.value,
    observedAt: new Date().toISOString(),
    confidence,
    rawText,
    note: ready
      ? `Browser OCR read the ${side}-side GSPro minimap lie footer using four segmented number/direction crops.`
      : `Browser OCR did not find both lie axes in the ${side}-side segmented minimap footer.`,
  }
}

const unavailable = (note: string) => {
  const observedAt = new Date().toISOString()
  dispatchGsproWindOcrObservation({ status: 'UNAVAILABLE', observedAt, note })
  dispatchGsproLieOcrObservation({ status: 'UNAVAILABLE', observedAt, note })
}

export const isBrowserGsproVisualCaptureSupported = () =>
  typeof navigator !== 'undefined'
  && typeof navigator.mediaDevices?.getDisplayMedia === 'function'

export const connectToBrowserGsproVisualCapture = async ({
  onStatusChange,
  onError,
  initiallyPaused = false,
}: ConnectBrowserGsproVisualCaptureOptions = {}): Promise<BrowserGsproVisualCaptureConnection> => {
  if (!isBrowserGsproVisualCaptureSupported()) {
    throw new Error('GSPro visual capture requires a desktop browser with window sharing support.')
  }

  onStatusChange?.('requesting')

  const displayOptions: LooperDisplayMediaOptions = {
    video: {
      displaySurface: 'window',
      frameRate: { ideal: 2, max: 5 },
    },
    audio: false,
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    monitorTypeSurfaces: 'include',
    surfaceSwitching: 'exclude',
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(
      displayOptions as unknown as DisplayMediaStreamOptions,
    )
  } catch (error) {
    onStatusChange?.('error')
    onError?.(error)
    throw error
  }

  const track = stream.getVideoTracks()[0]
  if (!track) {
    stream.getTracks().forEach((candidate) => candidate.stop())
    throw new Error('The selected share source did not provide video.')
  }

  const settings = track.getSettings() as DisplayTrackSettings
  const displaySurface = settings.displaySurface ?? null
  const sourceLabel = track.label?.trim() || null
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream

  let disconnected = false
  let ocrInFlight = false
  let greenPaused = initiallyPaused
  let shotOcrTimer: number | null = null
  let shotStateListener: ((event: Event) => void) | null = null
  let worker: TesseractWorker | null = null

  const stop = () => {
    if (disconnected) return
    disconnected = true
    if (shotOcrTimer != null) window.clearTimeout(shotOcrTimer)
    shotOcrTimer = null
    if (shotStateListener) {
      window.removeEventListener(LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT, shotStateListener)
      shotStateListener = null
    }
    video.pause()
    video.srcObject = null
    stream.getTracks().forEach((candidate) => candidate.stop())
    if (worker) void worker.terminate().catch(() => undefined)
    worker = null
  }

  const stopFromBrowser = () => {
    if (disconnected) return
    stop()
    unavailable('GSPro visual capture stopped. Reconnect visuals to resume wind and lie OCR.')
    onStatusChange?.('stopped')
  }

  track.addEventListener('ended', stopFromBrowser, { once: true })

  try {
    await video.play()
    if (video.readyState < 2) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error('Timed out waiting for the GSPro capture frame.')),
          5000,
        )
        video.addEventListener('loadeddata', () => {
          window.clearTimeout(timeout)
          resolve()
        }, { once: true })
      })
    }

    onStatusChange?.('loading-ocr')
    const tesseract = await loadTesseract()
    if (disconnected) throw new Error('GSPro visual capture stopped before OCR initialized.')
    worker = await tesseract.createWorker('eng', 1, {
      workerPath: TESSERACT_WORKER_URL,
      corePath: TESSERACT_CORE_URL,
    })

    const recognize = async (
      crop: CropSpec,
      whitelist: string,
      pageSegMode = '6',
    ) => {
      if (!worker) throw new Error('Browser OCR worker is unavailable.')
      await worker.setParameters({
        tessedit_pageseg_mode: pageSegMode,
        tessedit_char_whitelist: whitelist,
      })
      return worker.recognize(drawCrop(video, crop))
    }

    const runOcr = async () => {
      if (disconnected || greenPaused || ocrInFlight || !worker) return
      ocrInFlight = true
      try {
        let windSpeedResult = await recognize(WIND_SPEED_CROP, '0123456789.,MPH ', '7')
        let windDirectionResult = await recognize(WIND_DIRECTION_CROP, 'NSEW ', '8')
        let windPayload = parseWindComponents(
          windSpeedResult.data.text ?? '',
          normalizedConfidence(windSpeedResult.data.confidence),
          windDirectionResult.data.text ?? '',
          normalizedConfidence(windDirectionResult.data.confidence),
        )

        if (windPayload.speedMph == null) {
          windSpeedResult = await recognize(WIND_SPEED_CROP, '0123456789.,MPH ', '6')
          windPayload = parseWindComponents(
            windSpeedResult.data.text ?? '',
            normalizedConfidence(windSpeedResult.data.confidence),
            windDirectionResult.data.text ?? '',
            normalizedConfidence(windDirectionResult.data.confidence),
          )
        }

        if (windPayload.speedMph == null) {
          windSpeedResult = await recognize(WIND_SPEED_CROP, '0123456789.,MPH ', '13')
          windPayload = parseWindComponents(
            windSpeedResult.data.text ?? '',
            normalizedConfidence(windSpeedResult.data.confidence),
            windDirectionResult.data.text ?? '',
            normalizedConfidence(windDirectionResult.data.confidence),
          )
        }

        if ((windPayload.speedMph ?? 0) > 0 && windPayload.directionDegrees == null) {
          windDirectionResult = await recognize(WIND_DIRECTION_CROP, 'NSEW ', '7')
          windPayload = parseWindComponents(
            windSpeedResult.data.text ?? '',
            normalizedConfidence(windSpeedResult.data.confidence),
            windDirectionResult.data.text ?? '',
            normalizedConfidence(windDirectionResult.data.confidence),
          )
        }

        if ((windPayload.speedMph ?? 0) > 0 && windPayload.directionDegrees == null) {
          windDirectionResult = await recognize(WIND_DIRECTION_CROP, 'NSEW ', '10')
          windPayload = parseWindComponents(
            windSpeedResult.data.text ?? '',
            normalizedConfidence(windSpeedResult.data.confidence),
            windDirectionResult.data.text ?? '',
            normalizedConfidence(windDirectionResult.data.confidence),
          )
        }
        dispatchGsproWindOcrObservation(windPayload)

        const readLieCandidate = async (footer: CropSpec, side: 'right' | 'left') => {
          const longitudinalNumberResult = await recognize(
            axisCrop(footer, 0.05, 0.27),
            '0123456789.,°º',
            '7',
          )
          const longitudinalDirectionResult = await recognize(
            axisCrop(footer, 0.24, 0.25),
            'UPDOWN',
            '6',
          )
          const lateralNumberResult = await recognize(
            axisCrop(footer, 0.47, 0.27),
            '0123456789.,°º',
            '7',
          )
          const lateralDirectionResult = await recognize(
            axisCrop(footer, 0.62, 0.37),
            'RIGHTLEFT',
            '7',
          )
          return liePayloadFromComponents(
            longitudinalNumberResult.data.text ?? '',
            normalizedConfidence(longitudinalNumberResult.data.confidence),
            longitudinalDirectionResult.data.text ?? '',
            normalizedConfidence(longitudinalDirectionResult.data.confidence),
            lateralNumberResult.data.text ?? '',
            normalizedConfidence(lateralNumberResult.data.confidence),
            lateralDirectionResult.data.text ?? '',
            normalizedConfidence(lateralDirectionResult.data.confidence),
            side,
          )
        }

        let liePayload = await readLieCandidate(RIGHT_LIE_CROP, 'right')
        if (liePayload.status !== 'READY') {
          const leftPayload = await readLieCandidate(LEFT_LIE_CROP, 'left')
          if (leftPayload.status === 'READY') liePayload = leftPayload
          else {
            liePayload = {
              ...liePayload,
              rawText: `RIGHT: ${liePayload.rawText ?? ''} | LEFT: ${leftPayload.rawText ?? ''}`,
              note: 'Browser OCR did not find both lie axes in either segmented minimap footer.',
            }
          }
        }
        dispatchGsproLieOcrObservation(liePayload)
      } catch (error) {
        onError?.(error)
        unavailable(`Browser GSPro OCR failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        ocrInFlight = false
      }
    }

    const scheduleShotOcr = (event: Event) => {
      if (disconnected) return
      const detail = (event as CustomEvent<LiveCaddieShotStateChangedDetail>).detail
      const surface = detail?.surface?.trim().toLowerCase() ?? null
      if (surface === 'green') {
        greenPaused = true
        if (shotOcrTimer != null) window.clearTimeout(shotOcrTimer)
        shotOcrTimer = null
        return
      }

      greenPaused = false
      if (shotOcrTimer != null) window.clearTimeout(shotOcrTimer)
      shotOcrTimer = window.setTimeout(() => {
        shotOcrTimer = null
        void runOcr()
      }, SHOT_OCR_SETTLE_MS)
    }

    shotStateListener = scheduleShotOcr
    window.addEventListener(LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT, shotStateListener)

    onStatusChange?.('connected')
    if (!greenPaused) void runOcr()
  } catch (error) {
    stop()
    onStatusChange?.('error')
    onError?.(error)
    unavailable(`GSPro visual capture could not start: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }

  return {
    displaySurface,
    sourceLabel,
    disconnect: () => {
      if (disconnected) return
      stop()
      unavailable('GSPro visual capture disconnected.')
      onStatusChange?.('stopped')
    },
  }
}
