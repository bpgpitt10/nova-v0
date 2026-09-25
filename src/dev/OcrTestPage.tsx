import { useEffect, useState } from 'react'
import {
  connectToBrowserGsproVisualCapture,
  type BrowserGsproVisualCaptureConnection,
} from '../adapters/browserGsproVisualCapture'
import {
  GSPRO_LIE_OCR_BROWSER_EVENT,
  type GsproLieOcrPayload,
} from '../adapters/gsproLieObservation'
import {
  GSPRO_WIND_OCR_BROWSER_EVENT,
  type GsproWindOcrPayload,
} from '../adapters/gsproWindObservation'

type OcrMode = 'lie' | 'wind'

type TestResult = {
  filename: string
  mode: OcrMode
  status: string
  rawText: string
  parsed: string
  error?: string
}

type CanvasTrack = MediaStreamTrack & { requestFrame?: () => void }

const RESULTS_STORAGE_KEY = 'looper-ocr-test-results-v1'

const loadSavedResults = (): TestResult[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RESULTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const makeCaptureCanvas = async (file: File, mode: OcrMode) => {
  const bitmap = await createImageBitmap(file)
  const isSavedMinimap = mode === 'lie'
    && (file.name.toLowerCase().includes('minimap') || bitmap.width / bitmap.height < 1.5)

  if (!isSavedMinimap) {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create screenshot canvas.')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    return canvas
  }

  const canvas = document.createElement('canvas')
  canvas.width = 3840
  canvas.height = 2160
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create minimap replay canvas.')
  context.fillStyle = '#000'
  context.fillRect(0, 0, canvas.width, canvas.height)

  const targetWidth = Math.round(canvas.width * 0.149)
  const targetHeight = Math.min(
    canvas.height,
    Math.round(bitmap.height * (targetWidth / bitmap.width)),
  )
  const x = Math.round(canvas.width * 0.848)
  const y = canvas.height - targetHeight
  context.drawImage(bitmap, x, y, targetWidth, targetHeight)
  bitmap.close()
  return canvas
}

const waitForPayload = <T,>(eventName: string, timeoutMs = 45000) =>
  new Promise<T>((resolve, reject) => {
    const onEvent = (event: Event) => {
      cleanup()
      resolve((event as CustomEvent<T>).detail)
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for OCR result.'))
    }, timeoutMs)
    const cleanup = () => {
      window.clearTimeout(timer)
      window.removeEventListener(eventName, onEvent)
    }
    window.addEventListener(eventName, onEvent)
  })

const formatLie = (payload: GsproLieOcrPayload) => ({
  status: payload.status ?? 'UNKNOWN',
  rawText: payload.rawText ?? '',
  parsed: [
    payload.upDownDegrees == null
      ? '? up/down'
      : `${Math.abs(payload.upDownDegrees).toFixed(1)} ${payload.upDownDegrees < 0 ? 'DOWN' : 'UP'}`,
    payload.leftRightDegrees == null
      ? '? left/right'
      : `${Math.abs(payload.leftRightDegrees).toFixed(1)} ${payload.leftRightDegrees < 0 ? 'LEFT' : 'RIGHT'}`,
  ].join(' | '),
})

const directionLabel = (degrees: number | null | undefined) => {
  if (degrees == null) return '?'
  const labels: Record<number, string> = {
    0: 'N', 45: 'NE', 90: 'E', 135: 'SE',
    180: 'S', 225: 'SW', 270: 'W', 315: 'NW',
  }
  return labels[degrees] ?? `${degrees}°`
}

const formatWind = (payload: GsproWindOcrPayload) => ({
  status: payload.status ?? 'UNKNOWN',
  rawText: payload.rawText ?? '',
  parsed: `${payload.speedMph == null ? '?' : payload.speedMph} MPH | ${directionLabel(payload.directionDegrees)}`,
})

const runScreenshot = async (file: File, mode: OcrMode): Promise<TestResult> => {
  const canvas = await makeCaptureCanvas(file, mode)
  const stream = canvas.captureStream(1)
  const track = stream.getVideoTracks()[0] as CanvasTrack | undefined
  track?.requestFrame?.()

  const mediaDevices = navigator.mediaDevices
  const ownDescriptor = Object.getOwnPropertyDescriptor(mediaDevices, 'getDisplayMedia')
  let connection: BrowserGsproVisualCaptureConnection | null = null

  const eventName = mode === 'lie'
    ? GSPRO_LIE_OCR_BROWSER_EVENT
    : GSPRO_WIND_OCR_BROWSER_EVENT
  const resultPromise = mode === 'lie'
    ? waitForPayload<GsproLieOcrPayload>(eventName)
    : waitForPayload<GsproWindOcrPayload>(eventName)

  Object.defineProperty(mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async () => stream,
  })

  try {
    connection = await connectToBrowserGsproVisualCapture()
    track?.requestFrame?.()
    const payload = await resultPromise
    const formatted = mode === 'lie'
      ? formatLie(payload as GsproLieOcrPayload)
      : formatWind(payload as GsproWindOcrPayload)
    return { filename: file.name, mode, ...formatted }
  } finally {
    connection?.disconnect()
    stream.getTracks().forEach((candidate) => candidate.stop())
    if (ownDescriptor) {
      Object.defineProperty(mediaDevices, 'getDisplayMedia', ownDescriptor)
    } else {
      delete (mediaDevices as unknown as { getDisplayMedia?: unknown }).getDisplayMedia
    }
  }
}

export default function OcrTestPage() {
  const [mode, setMode] = useState<OcrMode>('lie')
  const [results, setResults] = useState<TestResult[]>(loadSavedResults)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    try {
      window.localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(results))
    } catch {
      // Persistence is a convenience only; OCR testing should still work without it.
    }
  }, [results])

  const runFiles = async (files: FileList | null) => {
    if (!files?.length || running) return
    const imageFiles = Array.from(files).filter((file) => /\.(png|jpe?g)$/i.test(file.name))
    if (imageFiles.length === 0) return

    setRunning(true)
    for (const file of imageFiles) {
      try {
        const result = await runScreenshot(file, mode)
        setResults((current) => [...current, result])
      } catch (error) {
        setResults((current) => [
          ...current,
          {
            filename: file.name,
            mode,
            status: 'ERROR',
            rawText: '',
            parsed: '',
            error: error instanceof Error ? error.message : String(error),
          },
        ])
      }
    }
    setRunning(false)
  }

  const clearResults = () => {
    if (running) return
    setResults([])
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0e1710', color: '#fff', padding: 32, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <h1 style={{ marginBottom: 6 }}>OCR Test</h1>
        <p style={{ marginTop: 0, color: '#bdc9bd' }}>
          Add screenshots one at a time. Each result stays in the table and is saved in this browser until you clear it.
        </p>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '24px 0', flexWrap: 'wrap' }}>
          <select
            value={mode}
            disabled={running}
            onChange={(event) => setMode(event.target.value as OcrMode)}
            style={{ padding: '10px 12px', fontSize: 16 }}
          >
            <option value="lie">Lie / minimap</option>
            <option value="wind">Wind / full screenshot</option>
          </select>

          <label style={{ padding: '10px 16px', borderRadius: 6, background: '#d4b15a', color: '#0e1710', fontWeight: 800, cursor: running ? 'default' : 'pointer' }}>
            {running ? 'Reading…' : 'Add image'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/jpg"
              multiple
              disabled={running}
              style={{ display: 'none' }}
              onChange={(event) => {
                void runFiles(event.target.files)
                event.target.value = ''
              }}
            />
          </label>

          <button
            type="button"
            disabled={running || results.length === 0}
            onClick={clearResults}
            style={{ padding: '10px 14px', borderRadius: 6, border: '1px solid #536856', background: 'transparent', color: '#fff', cursor: running || results.length === 0 ? 'default' : 'pointer' }}
          >
            Clear results
          </button>

          <span>{results.length} saved</span>
        </div>

        {results.length > 0 ? (
          <div style={{ overflowX: 'auto', border: '1px solid #344436', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead style={{ background: '#17231a' }}>
                <tr>
                  <th style={{ padding: 12 }}>#</th>
                  <th style={{ padding: 12 }}>File</th>
                  <th style={{ padding: 12 }}>Type</th>
                  <th style={{ padding: 12 }}>Status</th>
                  <th style={{ padding: 12 }}>Raw OCR</th>
                  <th style={{ padding: 12 }}>Parsed</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result, index) => (
                  <tr key={`${index}-${result.filename}`} style={{ borderTop: '1px solid #344436' }}>
                    <td style={{ padding: 12 }}>{index + 1}</td>
                    <td style={{ padding: 12, whiteSpace: 'nowrap' }}>{result.filename}</td>
                    <td style={{ padding: 12 }}>{result.mode === 'lie' ? 'Lie' : 'Wind'}</td>
                    <td style={{ padding: 12, fontWeight: 800 }}>{result.status}</td>
                    <td style={{ padding: 12, minWidth: 260, whiteSpace: 'pre-wrap' }}>{result.error || result.rawText || '—'}</td>
                    <td style={{ padding: 12, whiteSpace: 'nowrap' }}>{result.parsed || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </main>
  )
}
