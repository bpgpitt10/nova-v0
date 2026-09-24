import {
  dispatchGsproLieOcrObservation,
  parseGsproLieRawText,
  type GsproLieOcrPayload,
} from './gsproLieObservation'
import {
  dispatchGsproWindOcrObservation,
  type GsproWindOcrPayload,
} from './gsproWindObservation'

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
  monitorTypeSurfaces?: 'exclude'
  surfaceSwitching?: 'exclude'
}

type CropSpec = {
  x: number
  y: number
  width: number
  height: number
  scale: number
}

const TESSERACT_VERSION = '6.0.1'
const TESSERACT_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`
const TESSERACT_WORKER_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`
const TESSERACT_CORE_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0'
const OCR_INTERVAL_MS = 2500

const WIND_CROP: CropSpec = {
  x: 0.32,
  y: 0,
  width: 0.36,
  height: 0.16,
  scale: 2.5,
}

// Proven minimap-footer geometry from the Windows reader. GSPro can place the
// minimap on either side, so the browser checks the normal right footer first
// and falls back to its mirrored left-side location only when needed.
const RIGHT_LIE_CROP: CropSpec = {
  x: 0.848,
  y: 0.952,
  width: 0.149,
  height: 0.047,
  scale: 4,
}

const LEFT_LIE_CROP: CropSpec = {
  x: 0.003,
  y: 0.952,
  width: 0.149,
  height: 0.047,
  scale: 4,
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
    if (existingScript) {
      existingScript.addEventListener('load', finish, { once: true })
      existingScript.addEventListener(
        'error',
        () => reject(new Error('Could not load browser OCR.')),
        { once: true },
      )
      return
    }

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

  // Normalize to high-contrast grayscale. Most GSPro HUD text is light on a
  // dark background; invert darker crops so Tesseract sees conventional dark
  // glyphs on a light field without baking in one specific GSPro theme.
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
    if (invert) value = 255 - value
    value = Math.max(0, Math.min(255, Math.round((value - 128) * 1.35 + 128)))
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

const parseWindText = (rawText: string, confidence: number | null): GsproWindOcrPayload => {
  const normalized = rawText.toUpperCase().replace(/\s+/g, ' ').trim()
  const speedMatch = normalized.match(/\b(\d{1,2}(?:[\.,]\d+)?)\s*MPH\b/)
  const cardinalMatch = normalized.match(/\b(NE|SE|SW|NW|N|E|S|W)\b/)
  const speedMph = speedMatch ? Number(speedMatch[1].replace(',', '.')) : null
  const cardinal = cardinalMatch?.[1] ?? null
  const directionDegrees = cardinal ? WIND_CARDINAL_DEGREES[cardinal] ?? null : null
  const missing: string[] = []
  if (speedMph == null || !Number.isFinite(speedMph)) missing.push('speed')
  if (directionDegrees == null) missing.push('cardinal direction')

  return {
    status: missing.length === 0 ? 'READY' : 'UNKNOWN',
    speedMph: speedMph != null && Number.isFinite(speedMph) ? speedMph : null,
    directionDegrees,
    convention: 'toward',
    referenceFrame: 'compass',
    observedAt: new Date().toISOString(),
    confidence,
    rawText,
    note: missing.length === 0
      ? 'Browser OCR read the shared GSPro wind HUD.'
      : `Browser wind OCR was incomplete; missing ${missing.join(', ')}.`,
  }
}

const liePayloadFromText = (
  rawText: string,
  confidence: number | null,
  side: 'right' | 'left',
): GsproLieOcrPayload => {
  const parsed = parseGsproLieRawText(rawText)
  const ready = parsed.upDownDegrees != null && parsed.leftRightDegrees != null
  return {
    status: ready ? 'READY' : 'UNKNOWN',
    surface: parsed.surface,
    upDownDegrees: parsed.upDownDegrees,
    leftRightDegrees: parsed.leftRightDegrees,
    observedAt: new Date().toISOString(),
    confidence,
    rawText,
    note: ready
      ? `Browser OCR read the ${side}-side GSPro minimap lie footer.`
      : `Browser OCR did not find both lie axes in the ${side}-side minimap footer.`,
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
}: ConnectBrowserGsproVisualCaptureOptions = {}): Promise<BrowserGsproVisualCaptureConnection> => {
  if (!isBrowserGsproVisualCaptureSupported()) {
    throw new Error('GSPro visual capture requires a desktop browser with window sharing support.')
  }

  onStatusChange?.('requesting')

  // This must be the first privileged action in the click handler. Browsers
  // require fresh user activation for every new screen/window capture session.
  const displayOptions: LooperDisplayMediaOptions = {
    video: {
      displaySurface: 'window',
      frameRate: { ideal: 2, max: 5 },
    },
    audio: false,
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    monitorTypeSurfaces: 'exclude',
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
  let timer: number | null = null
  let worker: TesseractWorker | null = null

  const stop = () => {
    if (disconnected) return
    disconnected = true
    if (timer != null) window.clearInterval(timer)
    timer = null
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
    ) => {
      if (!worker) throw new Error('Browser OCR worker is unavailable.')
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        tessedit_char_whitelist: whitelist,
      })
      return worker.recognize(drawCrop(video, crop))
    }

    const runOcr = async () => {
      if (disconnected || ocrInFlight || !worker) return
      ocrInFlight = true
      try {
        const windResult = await recognize(WIND_CROP, '0123456789.,MPHNSEW ')
        dispatchGsproWindOcrObservation(parseWindText(
          windResult.data.text ?? '',
          normalizedConfidence(windResult.data.confidence),
        ))

        const rightLieResult = await recognize(
          RIGHT_LIE_CROP,
          '0123456789.,°ºUPDOWNRIGHTLEFT- ',
        )
        let liePayload = liePayloadFromText(
          rightLieResult.data.text ?? '',
          normalizedConfidence(rightLieResult.data.confidence),
          'right',
        )

        if (liePayload.status !== 'READY') {
          const leftLieResult = await recognize(
            LEFT_LIE_CROP,
            '0123456789.,°ºUPDOWNRIGHTLEFT- ',
          )
          const leftPayload = liePayloadFromText(
            leftLieResult.data.text ?? '',
            normalizedConfidence(leftLieResult.data.confidence),
            'left',
          )
          if (leftPayload.status === 'READY') liePayload = leftPayload
          else {
            liePayload = {
              ...liePayload,
              rawText: [
                `RIGHT: ${rightLieResult.data.text ?? ''}`,
                `LEFT: ${leftLieResult.data.text ?? ''}`,
              ].join('\n'),
              note: 'Browser OCR did not find both lie axes in either minimap footer.',
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

    onStatusChange?.('connected')
    void runOcr()
    timer = window.setInterval(() => void runOcr(), OCR_INTERVAL_MS)
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
