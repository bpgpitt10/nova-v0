import { useEffect, useRef, useState } from 'react'

type GsproFileHandle = {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
  queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

type SqlValue = number | string | Uint8Array | null

type SqlResult = {
  columns: string[]
  values: SqlValue[][]
}

type SqlDatabase = {
  exec: (sql: string) => SqlResult[]
  close: () => void
}

type SqlJsStatic = {
  Database: new (bytes?: Uint8Array) => SqlDatabase
}

type InitSqlJs = (config?: {
  locateFile?: (file: string) => string
}) => Promise<SqlJsStatic>

type GsproProofWindow = Window &
  typeof globalThis & {
    showOpenFilePicker?: (options?: {
      multiple?: boolean
      types?: Array<{
        description: string
        accept: Record<string, string[]>
      }>
    }) => Promise<GsproFileHandle[]>
    initSqlJs?: InitSqlJs
  }

type LatestRangeShot = {
  id: number
  dateCreated: string | number | null
  rawShotData: string
  parsedShotData: unknown
}

const SQL_JS_VERSION = '1.14.2'
const SQL_JS_BASE = `https://cdn.jsdelivr.net/npm/sql.js@${SQL_JS_VERSION}/dist`
const POLL_MS = 1000

let sqlJsPromise: Promise<SqlJsStatic> | null = null

const getWindow = () => window as GsproProofWindow

const loadSqlJs = () => {
  if (sqlJsPromise) {
    return sqlJsPromise
  }

  sqlJsPromise = new Promise<SqlJsStatic>((resolve, reject) => {
    const existingInit = getWindow().initSqlJs
    if (existingInit) {
      existingInit({ locateFile: (file) => `${SQL_JS_BASE}/${file}` }).then(resolve, reject)
      return
    }

    const script = document.createElement('script')
    script.src = `${SQL_JS_BASE}/sql-wasm.js`
    script.async = true
    script.onload = () => {
      const initSqlJs = getWindow().initSqlJs
      if (!initSqlJs) {
        reject(new Error('sql.js loaded but initSqlJs was not available'))
        return
      }
      initSqlJs({ locateFile: (file) => `${SQL_JS_BASE}/${file}` }).then(resolve, reject)
    }
    script.onerror = () => reject(new Error('Failed to load sql.js from jsDelivr'))
    document.head.appendChild(script)
  })

  return sqlJsPromise
}

const parseLatestRangeShot = async (file: File): Promise<LatestRangeShot | null> => {
  const SQL = await loadSqlJs()
  const bytes = new Uint8Array(await file.arrayBuffer())
  const db = new SQL.Database(bytes)

  try {
    const result = db.exec(
      'SELECT ID, DateCreated, ShotData FROM DrivingRangeShot ORDER BY ID DESC LIMIT 1',
    )[0]
    const row = result?.values?.[0]
    if (!row) {
      return null
    }

    const [id, dateCreated, shotData] = row
    if (typeof id !== 'number' || typeof shotData !== 'string') {
      throw new Error('Latest DrivingRangeShot row did not have the expected GSPro shape')
    }

    let parsedShotData: unknown = shotData
    try {
      parsedShotData = JSON.parse(shotData)
    } catch {
      // Keep the raw string visible if GSPro ever returns non-JSON text.
    }

    return {
      id,
      dateCreated:
        typeof dateCreated === 'number' || typeof dateCreated === 'string' || dateCreated === null
          ? dateCreated
          : null,
      rawShotData: shotData,
      parsedShotData,
    }
  } finally {
    db.close()
  }
}

const formatTimestamp = (value: number | null) => {
  if (!value) {
    return '—'
  }
  return new Date(value).toLocaleString()
}

function GsproWebProofPage() {
  const [fileName, setFileName] = useState<string>('None selected')
  const [latestShot, setLatestShot] = useState<LatestRangeShot | null>(null)
  const [status, setStatus] = useState('Select GSPro.db to begin.')
  const [error, setError] = useState<string | null>(null)
  const [lastFileModified, setLastFileModified] = useState<number | null>(null)
  const [watching, setWatching] = useState(false)
  const handleRef = useRef<GsproFileHandle | null>(null)
  const lastObservedSignatureRef = useRef<string | null>(null)
  const readInFlightRef = useRef(false)

  const supported = typeof window !== 'undefined' && Boolean(getWindow().showOpenFilePicker)

  const readCurrentFile = async (force = false) => {
    const handle = handleRef.current
    if (!handle || readInFlightRef.current) {
      return
    }

    readInFlightRef.current = true
    try {
      const file = await handle.getFile()
      const signature = `${file.lastModified}:${file.size}`
      setLastFileModified(file.lastModified)

      if (!force && signature === lastObservedSignatureRef.current) {
        return
      }

      lastObservedSignatureRef.current = signature
      setStatus('GSPro.db changed — reading latest shot…')
      const shot = await parseLatestRangeShot(file)
      setLatestShot(shot)
      setError(null)
      setStatus(
        shot
          ? `Watching GSPro.db · latest DrivingRangeShot ID ${shot.id}`
          : 'Watching GSPro.db · no DrivingRangeShot rows found yet.',
      )
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      setStatus('Could not read GSPro.db.')
    } finally {
      readInFlightRef.current = false
    }
  }

  const selectGsproDatabase = async () => {
    setError(null)
    if (!supported || !getWindow().showOpenFilePicker) {
      setError('This browser does not support the File System Access picker. Use desktop Chrome.')
      return
    }

    try {
      const [handle] = await getWindow().showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: 'GSPro database',
            accept: {
              'application/octet-stream': ['.db'],
            },
          },
        ],
      })

      if (!handle) {
        return
      }

      handleRef.current = handle
      lastObservedSignatureRef.current = null
      setFileName(handle.name)
      setWatching(true)
      setStatus('Loading GSPro.db…')
      await readCurrentFile(true)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      if (message.toLowerCase().includes('abort')) {
        return
      }
      setError(message)
      setStatus('GSPro.db selection failed.')
    }
  }

  useEffect(() => {
    if (!watching) {
      return
    }

    const interval = window.setInterval(() => {
      void readCurrentFile(false)
    }, POLL_MS)

    return () => window.clearInterval(interval)
  }, [watching])

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
            LOOPER · WEB GSPro PROOF
          </p>
          <h1 style={{ margin: 0, fontSize: 38 }}>Direct GSPro capture in Chrome</h1>
          <p style={{ color: '#CFD8CD', maxWidth: 760, lineHeight: 1.5 }}>
            This page reads GSPro.db directly from the browser. No Tauri, no SimRead runtime,
            no localhost helper. Select the live GSPro.db file, then hit shots in the GSPro
            practice range and watch the latest DrivingRangeShot row change.
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
              onClick={() => void selectGsproDatabase()}
              type="button"
              disabled={!supported}
              style={{
                border: 0,
                borderRadius: 10,
                padding: '11px 16px',
                fontWeight: 800,
                cursor: supported ? 'pointer' : 'not-allowed',
                background: '#D4B15A',
                color: '#0E1710',
              }}
            >
              Select GSPro.db
            </button>
            <button
              onClick={() => void readCurrentFile(true)}
              type="button"
              disabled={!handleRef.current}
              style={{
                border: '1px solid #314233',
                borderRadius: 10,
                padding: '10px 16px',
                fontWeight: 700,
                cursor: handleRef.current ? 'pointer' : 'not-allowed',
                background: '#172419',
                color: '#fff',
              }}
            >
              Read now
            </button>
            <span style={{ color: supported ? '#76D39B' : '#D18A3B', fontWeight: 700 }}>
              {supported ? 'Browser file access available' : 'Use desktop Chrome'}
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
              marginTop: 18,
            }}
          >
            <div>
              <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>File</div>
              <div style={{ fontWeight: 700 }}>{fileName}</div>
            </div>
            <div>
              <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
                Watch status
              </div>
              <div style={{ fontWeight: 700 }}>{status}</div>
            </div>
            <div>
              <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
                DB modified
              </div>
              <div style={{ fontWeight: 700 }}>{formatTimestamp(lastFileModified)}</div>
            </div>
          </div>

          {error ? (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                borderRadius: 10,
                background: 'rgba(200, 90, 74, 0.14)',
                color: '#fff',
              }}
            >
              {error}
            </div>
          ) : null}
        </section>

        <section
          style={{
            background: '#142118',
            border: '1px solid #314233',
            borderRadius: 16,
            padding: 20,
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
              marginBottom: 18,
            }}
          >
            <div>
              <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
                Latest row ID
              </div>
              <div style={{ fontSize: 30, fontWeight: 800 }}>{latestShot?.id ?? '—'}</div>
            </div>
            <div>
              <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
                DateCreated
              </div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>
                {latestShot?.dateCreated === null || latestShot?.dateCreated === undefined
                  ? '—'
                  : String(latestShot.dateCreated)}
              </div>
            </div>
          </div>

          <div style={{ color: '#9FB09F', fontSize: 12, textTransform: 'uppercase' }}>
            Parsed ShotData
          </div>
          <pre
            style={{
              margin: '8px 0 0',
              padding: 16,
              overflow: 'auto',
              maxHeight: '55vh',
              borderRadius: 12,
              background: '#0E1710',
              border: '1px solid #314233',
              color: '#CFD8CD',
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {latestShot
              ? JSON.stringify(latestShot.parsedShotData, null, 2)
              : 'Select GSPro.db to inspect the latest shot.'}
          </pre>
        </section>
      </div>
    </main>
  )
}

export default GsproWebProofPage
