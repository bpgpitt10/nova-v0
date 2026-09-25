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

type CorpusManifestImage = {
  id: string
  filename: string
  mode: OcrMode
  mimeType: string
  lastModified: number
  addedAt: number
  imagePath: string
  result?: TestResult
}

type CorpusManifest = {
  format: 'looper-ocr-corpus'
  version: 1
  exportedAt: string
  images: CorpusManifestImage[]
}

type ZipEntry = {
  name: string
  data: Uint8Array
}

const DB_NAME = 'looper-ocr-test-v1'
const DB_VERSION = 1
const IMAGE_STORE = 'images'
const LEGACY_RESULTS_STORAGE_KEY = 'looper-ocr-test-results-v1'
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

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

const toMeta = (record: StoredImageRecord): SavedImageMeta => ({
  id: record.id,
  filename: record.filename,
  mode: record.mode,
  mimeType: record.mimeType,
  lastModified: record.lastModified,
  addedAt: record.addedAt,
  result: record.result,
})

const loadAllImageRecords = async (): Promise<StoredImageRecord[]> => {
  const db = await openDb()
  try {
    const transaction = db.transaction(IMAGE_STORE, 'readonly')
    const records = await requestToPromise(
      transaction.objectStore(IMAGE_STORE).getAll() as IDBRequest<StoredImageRecord[]>,
    )
    return records.sort((a, b) => a.addedAt - b.addedAt)
  } finally {
    db.close()
  }
}

const loadSavedImages = async (): Promise<SavedImageMeta[]> =>
  (await loadAllImageRecords()).map(toMeta)

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

const saveImportedRecords = async (records: StoredImageRecord[]) => {
  const db = await openDb()
  try {
    const transaction = db.transaction(IMAGE_STORE, 'readwrite')
    const store = transaction.objectStore(IMAGE_STORE)
    for (const record of records) store.put(record)
    await transactionToPromise(transaction)
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
  const record = await loadImageRecord(id)
  if (!record) throw new Error('Saved OCR test image could not be found.')
  const updated: StoredImageRecord = { ...record, result }
  const db = await openDb()
  try {
    const transaction = db.transaction(IMAGE_STORE, 'readwrite')
    transaction.objectStore(IMAGE_STORE).put(updated)
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

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const concatBytes = (parts: Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

const makeZip = (entries: ZipEntry[]) => {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name)
    const crc = crc32(entry.data)
    const localHeader = new Uint8Array(30)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x0800, true)
    localView.setUint16(8, 0, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, entry.data.length, true)
    localView.setUint32(22, entry.data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    localParts.push(localHeader, nameBytes, entry.data)

    const centralHeader = new Uint8Array(46)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, entry.data.length, true)
    centralView.setUint32(24, entry.data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    centralParts.push(centralHeader, nameBytes)

    offset += localHeader.length + nameBytes.length + entry.data.length
  }

  const centralDirectory = concatBytes(centralParts)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralDirectory.length, true)
  endView.setUint32(16, offset, true)
  return concatBytes([...localParts, centralDirectory, end])
}

const parseZip = (bytes: Uint8Array): Map<string, Uint8Array> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let endOffset = -1
  const start = Math.max(0, bytes.length - 65557)
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) throw new Error('That file is not a valid Looper OCR corpus ZIP.')

  const entryCount = view.getUint16(endOffset + 10, true)
  let centralOffset = view.getUint32(endOffset + 16, true)
  const entries = new Map<string, Uint8Array>()

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(centralOffset, true) !== 0x02014b50) throw new Error('ZIP directory is invalid.')
    const method = view.getUint16(centralOffset + 10, true)
    const compressedSize = view.getUint32(centralOffset + 20, true)
    const nameLength = view.getUint16(centralOffset + 28, true)
    const extraLength = view.getUint16(centralOffset + 30, true)
    const commentLength = view.getUint16(centralOffset + 32, true)
    const localOffset = view.getUint32(centralOffset + 42, true)
    const name = textDecoder.decode(bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength))
    if (method !== 0) throw new Error('This importer expects a ZIP exported by Looper OCR Test.')
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP entry is invalid.')
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    entries.set(name, bytes.slice(dataStart, dataStart + compressedSize))
    centralOffset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const safeZipFilename = (filename: string) => filename.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'image.png'

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
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
  const targetHeight = Math.min(canvas.height, Math.round(bitmap.height * (targetWidth / bitmap.width)))
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

  const eventName = mode === 'lie' ? GSPRO_LIE_OCR_BROWSER_EVENT : GSPRO_WIND_OCR_BROWSER_EVENT
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
    try {
      for (const file of imageFiles) {
        setMessage(`Saving ${file.name}…`)
        const saved = await saveImage(file, mode)
        setSavedImages((current) => [...current, saved])
        setMessage(`${file.name} saved · reading OCR…`)
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
          replaceSavedImage({ ...meta, result: errorResult(meta.filename, meta.mode, 'Saved image bytes are missing.') })
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

  const exportCorpus = async () => {
    if (running || savedImages.length === 0) return
    setRunning(true)
    try {
      setMessage('Building corpus ZIP…')
      const records = await loadAllImageRecords()
      const entries: ZipEntry[] = []
      const manifestImages: CorpusManifestImage[] = []

      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]
        const imagePath = `images/${String(index + 1).padStart(3, '0')}_${safeZipFilename(record.filename)}`
        entries.push({ imagePath, name: imagePath, data: new Uint8Array(await record.blob.arrayBuffer()) } as ZipEntry & { imagePath: string })
        manifestImages.push({
          id: record.id,
          filename: record.filename,
          mode: record.mode,
          mimeType: record.mimeType,
          lastModified: record.lastModified,
          addedAt: record.addedAt,
          imagePath,
          result: record.result,
        })
      }

      const manifest: CorpusManifest = {
        format: 'looper-ocr-corpus',
        version: 1,
        exportedAt: new Date().toISOString(),
        images: manifestImages,
      }
      entries.unshift({ name: 'manifest.json', data: textEncoder.encode(JSON.stringify(manifest, null, 2)) })
      const zip = makeZip(entries)
      downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `looper-ocr-corpus-${new Date().toISOString().slice(0, 10)}.zip`)
      setMessage(`Exported ${records.length} screenshots to ZIP`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  const importCorpus = async (file: File | null) => {
    if (!file || running) return
    setRunning(true)
    try {
      setMessage(`Importing ${file.name}…`)
      const entries = parseZip(new Uint8Array(await file.arrayBuffer()))
      const manifestBytes = entries.get('manifest.json')
      if (!manifestBytes) throw new Error('ZIP is missing manifest.json.')
      const manifest = JSON.parse(textDecoder.decode(manifestBytes)) as CorpusManifest
      if (manifest.format !== 'looper-ocr-corpus' || manifest.version !== 1 || !Array.isArray(manifest.images)) {
        throw new Error('That ZIP is not a supported Looper OCR corpus.')
      }

      const records: StoredImageRecord[] = manifest.images.map((image) => {
        if (!image.id || !image.filename || (image.mode !== 'lie' && image.mode !== 'wind') || !image.imagePath) {
          throw new Error('Corpus manifest contains an invalid image record.')
        }
        const imageBytes = entries.get(image.imagePath)
        if (!imageBytes) throw new Error(`ZIP is missing ${image.imagePath}.`)
        return {
          id: image.id,
          filename: image.filename,
          mode: image.mode,
          mimeType: image.mimeType || 'image/png',
          lastModified: Number.isFinite(image.lastModified) ? image.lastModified : Date.now(),
          addedAt: Number.isFinite(image.addedAt) ? image.addedAt : Date.now(),
          blob: new Blob([imageBytes.slice() as BlobPart], { type: image.mimeType || 'image/png' }),
          result: image.result,
        }
      })

      await saveImportedRecords(records)
      const latest = await loadSavedImages()
      setSavedImages(latest)
      setMessage(`Imported ${records.length} screenshots · ${latest.length} total saved · ready to re-run`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  const clearCorpus = async () => {
    if (running || savedImages.length === 0) return
    if (!window.confirm('Delete all saved OCR test screenshots and results from this browser? Export a ZIP first if you want a backup.')) return
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
          Add useful screenshots once. Looper keeps the image bytes in this browser; export a corpus ZIP for a portable backup and import it anywhere later.
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
            onClick={() => void exportCorpus()}
            style={{ padding: '10px 14px', borderRadius: 6, border: '1px solid #7d9d82', background: 'transparent', color: '#fff', cursor: running || savedImages.length === 0 ? 'default' : 'pointer' }}
          >
            Export corpus ZIP
          </button>

          <label style={{ padding: '10px 14px', borderRadius: 6, border: '1px solid #7d9d82', color: '#fff', cursor: running ? 'default' : 'pointer' }}>
            Import corpus ZIP
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={running}
              style={{ display: 'none' }}
              onChange={(event) => {
                void importCorpus(event.target.files?.[0] ?? null)
                event.target.value = ''
              }}
            />
          </label>

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
