import { useState } from 'react'
import {
  normalizeGsproLieOcrPayload,
  type GsproLieOcrPayload,
} from '../adapters/gsproLieObservation'
import {
  normalizeGsproWindOcrPayload,
  type GsproWindOcrPayload,
} from '../adapters/gsproWindObservation'

type OcrMode = 'lie' | 'wind'

type TestResult = {
  filename: string
  rawText: string
  parsed: string
  status: string
  error?: string
}

const HELPER_BASE_URL = 'http://127.0.0.1:8787'

const signedLieLabel = (
  value: number | null,
  positive: 'UP' | 'RIGHT',
  negative: 'DOWN' | 'LEFT',
) => {
  if (value == null) return '?'
  return `${Math.abs(value).toFixed(1)} ${value < 0 ? negative : positive}`
}

const formatLie = (payload: GsproLieOcrPayload) => {
  const observation = normalizeGsproLieOcrPayload(payload)
  return {
    status: observation.status,
    parsed: [
      observation.surface ?? 'surface ?',
      signedLieLabel(observation.upDownDegrees, 'UP', 'DOWN'),
      signedLieLabel(observation.leftRightDegrees, 'RIGHT', 'LEFT'),
    ].join(' | '),
    rawText: observation.rawText ?? '',
  }
}

const formatWind = (payload: GsproWindOcrPayload) => {
  const observation = normalizeGsproWindOcrPayload(payload)
  return {
    status: observation.status,
    parsed: [
      observation.speedMph == null ? '? MPH' : `${observation.speedMph} MPH`,
      observation.directionDegrees == null ? '?°' : `${observation.directionDegrees}°`,
    ].join(' | '),
    rawText: observation.rawText ?? '',
  }
}

export default function OcrTestPage() {
  const [mode, setMode] = useState<OcrMode>('lie')
  const [results, setResults] = useState<TestResult[]>([])
  const [running, setRunning] = useState(false)

  const runFiles = async (files: FileList | null) => {
    if (!files?.length || running) return
    setRunning(true)
    setResults([])

    const next: TestResult[] = []
    for (const file of Array.from(files)) {
      try {
        const response = await fetch(`${HELPER_BASE_URL}/ocr-test/${mode}`, {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
          },
          body: file,
        })

        const payload = await response.json() as GsproLieOcrPayload & GsproWindOcrPayload & { error?: string }
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)

        const formatted = mode === 'lie'
          ? formatLie(payload)
          : formatWind(payload)
        next.push({ filename: file.name, ...formatted })
      } catch (error) {
        next.push({
          filename: file.name,
          rawText: '',
          parsed: '',
          status: 'ERROR',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      setResults([...next])
    }

    setRunning(false)
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0E1710', color: '#fff', padding: '32px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <h1 style={{ margin: '0 0 8px' }}>OCR Test</h1>
        <p style={{ margin: '0 0 24px', color: '#CFD8CD' }}>
          Pick old GSPro images. They run through the same Windows OCR engine and production parser used by Live Caddie.
        </p>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 24 }}>
          <select
            value={mode}
            disabled={running}
            onChange={(event) => setMode(event.target.value as OcrMode)}
            style={{ padding: '10px 12px', fontSize: 16 }}
          >
            <option value="lie">Lie / minimap</option>
            <option value="wind">Wind</option>
          </select>
          <label style={{ display: 'inline-block', padding: '10px 16px', background: '#D4B15A', color: '#0E1710', fontWeight: 700, borderRadius: 6, cursor: running ? 'default' : 'pointer' }}>
            {running ? 'Running…' : 'Choose images'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/jpg"
              multiple
              disabled={running}
              onChange={(event) => {
                void runFiles(event.target.files)
                event.target.value = ''
              }}
              style={{ display: 'none' }}
            />
          </label>
          {results.length > 0 && (
            <span style={{ color: '#9FB09F' }}>{results.length} image{results.length === 1 ? '' : 's'}</span>
          )}
        </div>

        {results.length > 0 && (
          <div style={{ overflowX: 'auto', border: '1px solid #314233', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead style={{ background: '#142118' }}>
                <tr>
                  <th style={{ padding: 12 }}>File</th>
                  <th style={{ padding: 12 }}>Status</th>
                  <th style={{ padding: 12 }}>Raw OCR</th>
                  <th style={{ padding: 12 }}>Parsed</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result, index) => (
                  <tr key={`${result.filename}-${index}`} style={{ borderTop: '1px solid #314233' }}>
                    <td style={{ padding: 12, whiteSpace: 'nowrap' }}>{result.filename}</td>
                    <td style={{ padding: 12, fontWeight: 700 }}>{result.status}</td>
                    <td style={{ padding: 12, whiteSpace: 'pre-wrap', minWidth: 260 }}>{result.error || result.rawText || '—'}</td>
                    <td style={{ padding: 12, whiteSpace: 'nowrap' }}>{result.parsed || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  )
}
