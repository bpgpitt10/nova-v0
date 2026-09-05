import { useCallback, useEffect, useRef, useState } from 'react'
import {
  chooseGsproDirectory,
  clearGsproDirectoryHandle,
  isBrowserGsproAccessSupported,
  loadGsproDirectoryHandle,
  queryGsproDirectoryPermission,
  readLatestGsproRangeShot,
  requestGsproDirectoryPermission,
  saveGsproDirectoryHandle,
  testGsproDirectoryWriteAccess,
  type BrowserDirectoryHandle,
  type BrowserGsproLatestShot,
  type BrowserGsproWriteTestResult,
} from '../dev/browserGsproAccess.ts'
import './BrowserGsproSpikePage.css'

type ProbeStatus =
  | 'idle'
  | 'restored'
  | 'connecting'
  | 'ready'
  | 'reading'
  | 'watching'
  | 'error'

const formatBytes = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatTimestamp = (value: number) =>
  value > 0 ? new Date(value).toLocaleString() : 'Unknown'

const formatShotData = (shot: BrowserGsproLatestShot | null) => {
  if (!shot) {
    return 'No DrivingRangeShot rows found yet.'
  }

  try {
    return JSON.stringify(shot.shotData, null, 2)
  } catch {
    return shot.shotDataText
  }
}

export default function BrowserGsproSpikePage() {
  const supported = isBrowserGsproAccessSupported()
  const [directoryHandle, setDirectoryHandle] = useState<BrowserDirectoryHandle | null>(null)
  const [permission, setPermission] = useState<'granted' | 'denied' | 'prompt'>('prompt')
  const [status, setStatus] = useState<ProbeStatus>('idle')
  const [latestShot, setLatestShot] = useState<BrowserGsproLatestShot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [watching, setWatching] = useState(false)
  const [newShotDetectedAt, setNewShotDetectedAt] = useState<Date | null>(null)
  const [writeTest, setWriteTest] = useState<BrowserGsproWriteTestResult | null>(null)
  const lastRowIdRef = useRef<number | null>(null)
  const pollBusyRef = useRef(false)

  const readLatest = useCallback(
    async (handle: BrowserDirectoryHandle, fromWatcher = false) => {
      if (pollBusyRef.current) {
        return
      }

      pollBusyRef.current = true
      if (!fromWatcher) {
        setStatus('reading')
      }
      setError(null)

      try {
        const shot = await readLatestGsproRangeShot(handle)
        if (shot) {
          const priorRowId = lastRowIdRef.current
          if (priorRowId !== null && shot.rowId !== priorRowId) {
            setNewShotDetectedAt(new Date())
          }
          lastRowIdRef.current = shot.rowId
        }
        setLatestShot(shot)
        setStatus(fromWatcher ? 'watching' : 'ready')
      } catch (readError) {
        const message = readError instanceof Error ? readError.message : String(readError)
        setError(message)
        setStatus('error')
      } finally {
        pollBusyRef.current = false
      }
    },
    [],
  )

  useEffect(() => {
    if (!supported) {
      return
    }

    let cancelled = false

    const restore = async () => {
      try {
        const handle = await loadGsproDirectoryHandle()
        if (!handle || cancelled) {
          return
        }

        const currentPermission = await queryGsproDirectoryPermission(handle, 'readwrite')
        if (cancelled) {
          return
        }

        setDirectoryHandle(handle)
        setPermission(currentPermission)
        setStatus('restored')

        if (currentPermission === 'granted') {
          await readLatest(handle)
        }
      } catch (restoreError) {
        if (cancelled) {
          return
        }
        setError(restoreError instanceof Error ? restoreError.message : String(restoreError))
        setStatus('error')
      }
    }

    void restore()

    return () => {
      cancelled = true
    }
  }, [readLatest, supported])

  useEffect(() => {
    if (!watching || !directoryHandle || permission !== 'granted') {
      return
    }

    const timer = window.setInterval(() => {
      void readLatest(directoryHandle, true)
    }, 1000)

    return () => window.clearInterval(timer)
  }, [directoryHandle, permission, readLatest, watching])

  const connect = async () => {
    setStatus('connecting')
    setError(null)
    setWriteTest(null)
    setNewShotDetectedAt(null)

    try {
      const handle = await chooseGsproDirectory()
      await saveGsproDirectoryHandle(handle)
      const currentPermission = await queryGsproDirectoryPermission(handle, 'readwrite')
      setDirectoryHandle(handle)
      setPermission(currentPermission)
      lastRowIdRef.current = null
      await readLatest(handle)
    } catch (connectError) {
      const message = connectError instanceof Error ? connectError.message : String(connectError)
      setError(message)
      setStatus('error')
    }
  }

  const restorePermission = async () => {
    if (!directoryHandle) {
      return
    }

    setError(null)
    try {
      const nextPermission = await requestGsproDirectoryPermission(directoryHandle, 'readwrite')
      setPermission(nextPermission)
      if (nextPermission !== 'granted') {
        setStatus('restored')
        return
      }
      await readLatest(directoryHandle)
    } catch (permissionError) {
      setError(permissionError instanceof Error ? permissionError.message : String(permissionError))
      setStatus('error')
    }
  }

  const runWriteTest = async () => {
    if (!directoryHandle) {
      return
    }

    setError(null)
    setWriteTest(null)
    try {
      const result = await testGsproDirectoryWriteAccess(directoryHandle)
      setWriteTest(result)
      setPermission('granted')
    } catch (writeError) {
      setError(writeError instanceof Error ? writeError.message : String(writeError))
      setStatus('error')
    }
  }

  const forgetFolder = async () => {
    setWatching(false)
    await clearGsproDirectoryHandle()
    setDirectoryHandle(null)
    setLatestShot(null)
    setWriteTest(null)
    setPermission('prompt')
    setStatus('idle')
    setError(null)
    setNewShotDetectedAt(null)
    lastRowIdRef.current = null
  }

  if (!supported) {
    return (
      <main className="browser-gspro-spike">
        <section className="browser-gspro-spike__panel">
          <span className="browser-gspro-spike__eyebrow">Looper experiment</span>
          <h1>Browser GSPro access</h1>
          <p className="browser-gspro-spike__lead">
            This browser does not expose the folder picker Looper needs. Open this page in desktop Chrome or Edge on the GSPro PC.
          </p>
        </section>
      </main>
    )
  }

  const connected = Boolean(directoryHandle)
  const canRead = connected && permission === 'granted'

  return (
    <main className="browser-gspro-spike">
      <section className="browser-gspro-spike__panel">
        <span className="browser-gspro-spike__eyebrow">Isolated experiment · does not affect Looper data</span>
        <h1>Browser GSPro access</h1>
        <p className="browser-gspro-spike__lead">
          Goal: prove that hosted Looper can read the live GSPro database directly from Chrome, remember the folder permission, detect a new shot, and safely obtain write access without installing SimRead.
        </p>

        <div className="browser-gspro-spike__steps">
          <div><strong>1.</strong> Click Connect and choose the GSPro folder containing <code>GSPro.db</code>.</div>
          <div><strong>2.</strong> If Chrome offers it, choose <strong>Allow on every visit</strong>.</div>
          <div><strong>3.</strong> Start watching, then hit one shot in GSPro.</div>
        </div>

        <div className="browser-gspro-spike__actions">
          <button type="button" className="browser-gspro-spike__primary" onClick={() => void connect()}>
            {connected ? 'Choose a different GSPro folder' : 'Connect GSPro folder'}
          </button>
          {directoryHandle && permission !== 'granted' ? (
            <button type="button" onClick={() => void restorePermission()}>
              Restore saved permission
            </button>
          ) : null}
          {canRead ? (
            <button type="button" onClick={() => void readLatest(directoryHandle)}>
              Read latest shot
            </button>
          ) : null}
          {canRead ? (
            <button
              type="button"
              className={watching ? 'browser-gspro-spike__stop' : ''}
              onClick={() => setWatching((current) => !current)}
            >
              {watching ? 'Stop watching' : 'Start watching for shots'}
            </button>
          ) : null}
          {connected ? (
            <button type="button" onClick={() => void runWriteTest()}>
              Test safe write access
            </button>
          ) : null}
          {connected ? (
            <button type="button" className="browser-gspro-spike__quiet" onClick={() => void forgetFolder()}>
              Forget saved folder
            </button>
          ) : null}
        </div>

        <div className="browser-gspro-spike__grid">
          <article className="browser-gspro-spike__card">
            <span>Folder</span>
            <strong>{directoryHandle?.name ?? 'Not connected'}</strong>
            <small>Expected folder: AppData\LocalLow\GSPro\GSPro</small>
          </article>
          <article className="browser-gspro-spike__card">
            <span>Permission</span>
            <strong>{permission}</strong>
            <small>Read/write is requested so we can test the future one-time approval model.</small>
          </article>
          <article className="browser-gspro-spike__card">
            <span>Probe state</span>
            <strong>{watching ? 'watching' : status}</strong>
            <small>{watching ? 'Polling GSPro.db once per second.' : 'No production ingestion is connected.'}</small>
          </article>
          <article className="browser-gspro-spike__card">
            <span>New shot</span>
            <strong>{newShotDetectedAt ? 'DETECTED' : 'Waiting'}</strong>
            <small>{newShotDetectedAt ? newShotDetectedAt.toLocaleTimeString() : 'Start watching, then hit a ball.'}</small>
          </article>
        </div>

        {error ? <div className="browser-gspro-spike__error">{error}</div> : null}

        {writeTest ? (
          <div className="browser-gspro-spike__success">
            Write test succeeded. Looper created <code>{writeTest.markerName}</code>
            {writeTest.cleanupSucceeded ? ' and immediately deleted it.' : '. The browser did not expose cleanup, so the marker remains.'}
          </div>
        ) : null}

        <section className="browser-gspro-spike__latest">
          <div className="browser-gspro-spike__latest-heading">
            <div>
              <span className="browser-gspro-spike__eyebrow">Latest DrivingRangeShot</span>
              <h2>{latestShot ? `Row ${latestShot.rowId}` : 'No shot loaded'}</h2>
            </div>
            {latestShot ? (
              <div className="browser-gspro-spike__meta">
                <span>DateCreated: {String(latestShot.dateCreated ?? 'null')}</span>
                <span>DB size: {formatBytes(latestShot.databaseSizeBytes)}</span>
                <span>DB modified: {formatTimestamp(latestShot.databaseLastModified)}</span>
              </div>
            ) : null}
          </div>
          <pre>{formatShotData(latestShot)}</pre>
        </section>

        <p className="browser-gspro-spike__note">
          The write test never modifies GSPro.db. It creates a clearly named Looper marker file and deletes it immediately when the browser permits cleanup.
        </p>
      </section>
    </main>
  )
}
