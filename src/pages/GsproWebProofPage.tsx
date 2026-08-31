import { useEffect, useRef, useState } from 'react'
import {
  getGsproConnectionStatus,
  getSelectedGsproDatabase,
  gsproFileSignature,
  isGsproBrowserFileAccessSupported,
  pickAndRememberGsproDirectory,
  prepareGsproDatabaseForSession,
  readLatestGsproRangeShot,
  type BrowserGsproRangeShot,
  type GsproConnectionStatus,
} from '../lib/browserGsproDb'

const POLL_MS = 1000

type OgcHealth = {
  ok: boolean
  status: number | null
  payload: unknown
  error: string | null
}

const formatTimestamp = (value: number | null) => {
  if (!value) {
    return '—'
  }
  return new Date(value).toLocaleString()
}

const connectionSummary = (status: GsproConnectionStatus | null) => {
  if (!status) {
    return 'Not checked'
  }
  if (status.permission === 'unsupported') {
    return 'Unsupported browser'
  }
  if (status.ready) {
    return `Ready · ${status.directoryName ?? 'GSPro folder'}`
  }
  if (status.remembered) {
    return `Remembered · permission ${status.permission}`
  }
  return 'Not connected'
}

function GsproWebProofPage() {
  const [connection, setConnection] = useState<GsproConnectionStatus | null>(null)
  const [latestShot, setLatestShot] = useState<BrowserGsproRangeShot | null>(null)
  const [lastFileModified, setLastFileModified] = useState<number | null>(null)
  const [dbStatus, setDbStatus] = useState('Not checked')
  const [ogcHealth, setOgcHealth] = useState<OgcHealth>({
    ok: false,
    status: null,
    payload: null,
    error: null,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const readInFlightRef = useRef(false)
  const lastSignatureRef = useRef<string | null>(null)
  const supported = isGsproBrowserFileAccessSupported()

  const refreshConnection = async () => {
    const status = await getGsproConnectionStatus()
    setConnection(status)
    return status
  }

  const readDatabase = async (force = false) => {
    const handle = getSelectedGsproDatabase()
    if (!handle || readInFlightRef.current) {
      return
    }

    readInFlightRef.current = true
    try {
      const { file, shot } = await readLatestGsproRangeShot(handle)
      const signature = gsproFileSignature(file)
      setLastFileModified(file.lastModified)
      if (!force && signature === lastSignatureRef.current) {
        return
      }

      lastSignatureRef.current = signature
      setLatestShot(shot)
      setDbStatus(
        shot
          ? `Readable · latest DrivingRangeShot ID ${shot.id}`
          : 'Readable · no DrivingRangeShot rows found',
      )
      setError(null)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setDbStatus('Read failed')
      setError(message)
    } finally {
      readInFlightRef.current = false
    }
  }

  const checkOgc = async () => {
    try {
      const response = await fetch('/api/open-golf-coach/derive', { method: 'GET' })
      const text = await response.text()
      let payload: unknown = text
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        // Keep raw text visible for diagnostics.
      }
      setOgcHealth({
        ok: response.ok,
        status: response.status,
        payload,
        error: response.ok ? null : `HTTP ${response.status}`,
      })
    } catch (caught) {
      setOgcHealth({
        ok: false,
        status: null,
        payload: null,
        error: caught instanceof Error ? caught.message : String(caught),
      })
    }
  }

  const runChecks = async () => {
    setBusy(true)
    setError(null)
    try {
      const status = await refreshConnection()
      if (status.ready) {
        await readDatabase(true)
      } else if (status.remembered && status.permission === 'prompt') {
        setDbStatus('Folder remembered · permission will be requested from Start or Connect')
      } else if (!status.remembered) {
        setDbStatus('Connect the GSPro folder first')
      }
      await checkOgc()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const connectGspro = async () => {
    setBusy(true)
    setError(null)
    try {
      await pickAndRememberGsproDirectory()
      await refreshConnection()
      await readDatabase(true)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      if (!message.toLowerCase().includes('abort')) {
        setError(message)
      }
    } finally {
      setBusy(false)
    }
  }

  const authorizeRememberedFolder = async () => {
    setBusy(true)
    setError(null)
    try {
      await prepareGsproDatabaseForSession()
      await refreshConnection()
      await readDatabase(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void runChecks()
  }, [])

  useEffect(() => {
    if (!connection?.ready) {
      return
    }
    const interval = window.setInterval(() => {
      void readDatabase(false)
    }, POLL_MS)
    return () => window.clearInterval(interval)
  }, [connection?.ready])

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0E1710',
        color: '#fff',
        padding: '32px',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <p style={{ color: '#D4B15A', fontWeight: 700, margin: '0 0 8px' }}>
            LOOPER · GSPro WEB DIAGNOSTICS
          </p>
          <h1 style={{ margin: 0, fontSize: 38 }}>Browser GSPro readiness</h1>
          <p style={{ color: '#CFD8CD', maxWidth: 820, lineHeight: 1.5 }}>
            This page exercises the same remembered GSPro folder access, SQLite reader, and hosted
            OpenGolfCoach endpoint used by the real Looper session flow. No Tauri or local helper is
            involved.
          </p>
        </div>

        <section
          style={{
            background: '#142118',
            border: '1px solid #314233',
            borderRadius: 16,
            padding: 20,
            marginBottom: 20,
          }}
        >
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => void runChecks()}
              type="button"
              disabled={busy}
              style={{
                border: 0,
                borderRadius: 10,
                padding: '11px 16px',
                fontWeight: 800,
                cursor: busy ? 'wait' : 'pointer',
                background: '#D4B15A',
                color: '#0E1710',
              }}
            >
              {busy ? 'Checking…' : 'Run checks'}
            </button>
            {supported ? (
              <button
                onClick={() => void connectGspro()}
                type="button"
                disabled={busy}
                style={{
                  border: '1px solid #314233',
                  borderRadius: 10,
                  padding: '10px 16px',
                  fontWeight: 700,
                  cursor: busy ? 'wait' : 'pointer',
                  background: '#172419',
                  color: '#fff',
                }}
              >
                {connection?.remembered ? 'Change GSPro Folder' : 'Connect GSPro Folder'}
              </button>
            ) : null}
            {connection?.remembered && connection.permission === 'prompt' ? (
              <button
                onClick={() => void authorizeRememberedFolder()}
                type="button"
                disabled={busy}
                style={{
                  border: '1px solid #314233',
                  borderRadius: 10,
                  padding: '10px 16px',
                  fontWeight: 700,
                  cursor: busy ? 'wait' : 'pointer',
                  background: '#172419',
                  color: '#fff',
                }}
              >
                Allow remembered folder
              </button>
            ) : null}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 16,
              marginTop: 20,
            }}
          >
            <div>
              <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
                Browser file access
              </div>
              <div style={{ fontWeight: 800, color: supported ? '#76D39B' : '#D18A3B' }}>
                {supported ? 'Available' : 'Unavailable'}
              </div>
            </div>
            <div>
              <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
                GSPro connection
              </div>
              <div style={{ fontWeight: 800 }}>{connectionSummary(connection)}</div>
            </div>
            <div>
              <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
                GSPro.db
              </div>
              <div style={{ fontWeight: 800 }}>{dbStatus}</div>
            </div>
            <div>
              <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
                Hosted OGC
              </div>
              <div style={{ fontWeight: 800, color: ogcHealth.ok ? '#76D39B' : '#D18A3B' }}>
                {ogcHealth.ok ? `Healthy · HTTP ${ogcHealth.status}` : ogcHealth.error ?? 'Not checked'}
              </div>
            </div>
          </div>

          {error ? (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                borderRadius: 10,
                background: 'rgba(200, 90, 74, 0.14)',
              }}
            >
              {error}
            </div>
          ) : null}
        </section>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 20,
          }}
        >
          <div
            style={{
              background: '#142118',
              border: '1px solid #314233',
              borderRadius: 16,
              padding: 20,
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
                  Latest row ID
                </div>
                <div style={{ fontSize: 30, fontWeight: 800 }}>{latestShot?.id ?? '—'}</div>
              </div>
              <div>
                <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
                  DB modified
                </div>
                <div style={{ fontWeight: 700 }}>{formatTimestamp(lastFileModified)}</div>
              </div>
            </div>
            <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase', marginTop: 18 }}>
              Latest GSPro ShotData
            </div>
            <pre
              style={{
                margin: '8px 0 0',
                padding: 16,
                overflow: 'auto',
                maxHeight: '48vh',
                borderRadius: 12,
                background: '#0E1710',
                border: '1px solid #314233',
                color: '#CFD8CD',
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              {latestShot ? JSON.stringify(latestShot.parsedShotData, null, 2) : 'No GSPro row loaded.'}
            </pre>
          </div>

          <div
            style={{
              background: '#142118',
              border: '1px solid #314233',
              borderRadius: 16,
              padding: 20,
            }}
          >
            <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
              Hosted OpenGolfCoach self-test
            </div>
            <pre
              style={{
                margin: '8px 0 0',
                padding: 16,
                overflow: 'auto',
                maxHeight: '58vh',
                borderRadius: 12,
                background: '#0E1710',
                border: '1px solid #314233',
                color: '#CFD8CD',
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              {ogcHealth.payload ? JSON.stringify(ogcHealth.payload, null, 2) : ogcHealth.error ?? 'Not checked.'}
            </pre>
          </div>
        </section>
      </div>
    </main>
  )
}

export default GsproWebProofPage
