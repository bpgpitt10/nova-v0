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

type StoredImageRecord = {
  id: string
  filename: string
  mode: OcrMode
  mimeType: string
  lastModified: number
  addedAt: number
  blob: Blob
  result?: TestResult
}

type SavedImageMeta = Omit<StoredImageRecord, 'blob'>

type CanvasTrack = MediaStreamTrack & { requestFrame?: () => void }

const DB_NAME = 'looper-ocr-test-v1'
const DB_VERSION = 1
const IMAGE_STORE = 'images'
const LEGACY_RESULTS_STORAGE_KEY = 'looper-ocr-test-results-v1'

const requestToPromise = <T,>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })

const transactionToPromise = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'))
  })

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open OCR test storage.'))
  })

const toMeta = ({ blob: _blob, ...meta }: StoredImageRecord): SavedImageMeta => meta

const loadSavedImages = async (): Promise<SavedImageMeta[]> => {
  const db = await openDb()
  try {
    const transaction = db.transaction(IMAGE_STORE, 'readonly')
    const records = await requestToPromise(
      transaction.objectStore(IMAGE_STORE).getAll() as IDBRequest<StoredImageRecord[]>,
    )
    return records
      .sort((a, b) => a.addedAt - b.addedAt)
      .map(toMeta)
  } finally {
    db.close()
  }
}

const saveImage = async (file: File, mode: OcrMode): Promise<SavedImageMeta> => {
  const record: StoredImageRecord = {
    id: typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    filename: file.name,
    mode,
    mimeType: file.type || 'image/png',
    lastModified: file.lastModified,
    addedAt: Date.now(),
    blob: file,
  }
  const db = await openDb()
  try {
    const transaction = db.transaction(IMAGE_STORE, 'readwrite')
    transaction.objectStore(IMAGE_STORE).put(record)
    await transactionToPromise(transaction)
    return toMeta(record)
  } finally {
    db.close()
  }
}

const loadImageRecord = async (id: string): Promise<StoredImageRecord | null> => {
  const db = await openDb()
  try {
    const transaction = db.transaction(IMAGE_STORE, 'readonly')
    const record = await requestToPromise(
      transaction.objectStore(IMAGE_STORE).get(id) as IDBRequest<StoredImageRecord | undefined>,
    )
    return record ?? null
  } finally {
    db.close()
  }
}

const saveResult = async (id: string, result: TestResult): Promise<SavedImageMeta> => {
  const db = await openDb()
  try {
    const transaction = db.transaction(IMAGE_STORE, 'readwrite')
    const store = transaction.objectStore(IMAGE_STORE)
    const record = await requestToPromise(store.get(id) as IDBRequest<StoredImageRecord | undefined>)
    if (!record) throw new Error('Saved OCR test image could not be found.')
    const updated: StoredImageRecord = { ...record, result }
    store.put(updated)
    await transactionToPromise(transaction)
    return toMeta(updated)
  } finally {
    db.close()
  }
}

const clearSavedImages = async () => {
  const db = await openDb()
  try {
    const transaction = db.transaction(IMAGE_STORE, 'readwrite')
    transaction.objectStore(IMAGE_STORE).clear()
    await transactionToPromise(transaction)
  } finally {
    db.close()
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

const errorResult = (filename: string, mode: OcrMode, error: unknown): TestResult => ({
  filename,
  mode,
  status: 'ERROR',
  rawText: '',
  parsed: '',
  error: error instanceof Error ? error.message : String(error),
})

export default function OcrTestPage() {
  const [mode, setMode] = useState<OcrMode>('lie')
  const [savedImages, setSavedImages] = useState<SavedImageMeta[]>([])
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState('Loading saved screenshots…')

  useEffect(() => {
    let cancelled = false
    void loadSavedImages()
      .then((images) => {
        if (cancelled) return
        setSavedImages(images)
        setMessage(images.length > 0
          ? `${images.length} screenshots saved in this browser`
          : 'No screenshots saved yet')
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error))
      })

    try {
      window.localStorage.removeItem(LEGACY_RESULTS_STORAGE_KEY)
    } catch {
      // Ignore legacy cleanup failures.
    }

    void navigator.storage?.persist?.().catch(() => false)

    return () => {
      cancelled = true
    }
  }, [])

  const replaceSavedImage = (updated: SavedImageMeta) => {
    setSavedImages((current) => current.map((item) => item.id === updated.id ? updated : item))
  }

  const processSavedImage = async (record: StoredImageRecord) => {
    const file = new File([record.blob], record.filename, {
      type: record.mimeType,
      lastModified: record.lastModified,
    })
    let result: TestResult
    try {
      result = await runScreenshot(file, record.mode)
    } catch (error) {
      result = errorResult(record.filename, record.mode, error)
    }
    replaceSavedImage(await saveResult(record.id, result))
  }

  const addFiles = async (files: FileList | null) => {
    if (!files?.length || running) return
    const imageFiles = Array.from(files).filter((file) => /\.(png|jpe?g)$/i.test(file.name))
    if (imageFiles.length === 0) return

    setRunning(true)
    setMessage('Saving screenshot…')
    try {
      for (const file of imageFiles) {
        const saved = await saveImage(file, mode)
        setSavedImages((current) => [...current, saved])
        setMessage(`Saved ${savedImages.length + 1} screenshot${savedImages.length === 0 ? '' : 's'} · reading OCR…`)
        const record = await loadImageRecord(saved.id)
        if (!record) throw new Error('Saved screenshot could not be reloaded.')
        await processSavedImage(record)
      }
      const latest = await loadSavedImages()
      setSavedImages(latest)
      setMessage(`${latest.length} screenshots saved in this browser`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  const rerunSavedImages = async () => {
    if (running || savedImages.length === 0) return
    setRunning(true)
    try {
      for (let index = 0; index < savedImages.length; index += 1) {
        const meta = savedImages[index]
        setMessage(`Re-running ${index + 1} of ${savedImages.length}: ${meta.filename}`)
        const record = await loadImageRecord(meta.id)
        if (!record) {
          replaceSavedImage(await saveResult(meta.id, errorResult(meta.filename, meta.mode, 'Saved image bytes are missing.')))
          continue
        }
        await processSavedImage(record)
      }
      const latest = await loadSavedImages()
      setSavedImages(latest)
      setMessage(`Re-run complete · ${latest.length} screenshots remain saved`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  const clearCorpus = async () => {
    if (running || savedImages.length === 0) return
    if (!window.confirm('Delete all saved OCR test screenshots and results from this browser?')) return
    setRunning(true)
    try {
      await clearSavedImages()
      setSavedImages([])
      setMessage('No screenshots saved yet')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0e1710', color: '#fff', padding: 32, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <h1 style={{ marginBottom: 6 }}>OCR Test</h1>
        <p style={{ marginTop: 0, color: '#bdc9bd' }}>
          Add useful screenshots once. Looper saves the actual images in this browser so the same corpus can be re-run after every OCR tweak.
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
            {running ? 'Working…' : 'Add image'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/jpg"
              multiple
              disabled={running}
              style={{ display: 'none' }}
              onChange={(event) => {
                void addFiles(event.target.files)
                event.target.value = ''
              }}
            />
          </label>

          <button
            type="button"
            disabled={running || savedImages.length === 0}
            onClick={() => void rerunSavedImages()}
            style={{ padding: '10px 14px', borderRadius: 6, border: '1px solid #d4b15a', background: 'transparent', color: '#fff', cursor: running || savedImages.length === 0 ? 'default' : 'pointer', fontWeight: 700 }}
          >
            Re-run saved images
          </button>

          <button
            type="button"
            disabled={running || savedImages.length === 0}
            onClick={() => void clearCorpus()}
            style={{ padding: '10px 14px', borderRadius: 6, border: '1px solid #536856', background: 'transparent', color: '#fff', cursor: running || savedImages.length === 0 ? 'default' : 'pointer' }}
          >
            Clear saved corpus
          </button>

          <span>{message}</span>
        </div>

        {savedImages.length > 0 ? (
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
                {savedImages.map((item, index) => (
                  <tr key={item.id} style={{ borderTop: '1px solid #344436' }}>
                    <td style={{ padding: 12 }}>{index + 1}</td>
                    <td style={{ padding: 12, whiteSpace: 'nowrap' }}>{item.filename}</td>
                    <td style={{ padding: 12 }}>{item.mode === 'lie' ? 'Lie' : 'Wind'}</td>
                    <td style={{ padding: 12, fontWeight: 800 }}>{item.result?.status ?? 'SAVED'}</td>
                    <td style={{ padding: 12, minWidth: 260, whiteSpace: 'pre-wrap' }}>{item.result?.error || item.result?.rawText || '—'}</td>
                    <td style={{ padding: 12, whiteSpace: 'nowrap' }}>{item.result?.parsed || '—'}</td>
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
