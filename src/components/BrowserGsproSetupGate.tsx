import { useEffect, useState, type ReactNode } from 'react'
import {
  chooseGsproDirectory,
  isBrowserGsproAccessSupported,
  loadGsproDirectoryHandle,
  queryGsproDirectoryPermission,
  requestGsproDirectoryPermission,
  saveGsproDirectoryHandle,
  type BrowserDirectoryHandle,
} from '../dev/browserGsproAccess'
import { startBrowserGsproRuntime } from '../dev/browserGsproRuntime'
import './BrowserGsproSetupGate.css'

type SetupState =
  | 'checking'
  | 'needs-folder'
  | 'needs-permission'
  | 'session-ready'
  | 'ready'
  | 'unsupported'
  | 'error'

type BrowserGsproSetupGateProps = {
  children: ReactNode
  bypass?: boolean
}

const DEFAULT_GSPRO_PATH = '%USERPROFILE%\\AppData\\LocalLow\\GSPro\\GSPro'
const PERSISTENCE_NUDGE_KEY = 'looper-browser-gspro-persistence-nudge'

export default function BrowserGsproSetupGate({
  children,
  bypass = false,
}: BrowserGsproSetupGateProps) {
  const [setupState, setSetupState] = useState<SetupState>('checking')
  const [directoryHandle, setDirectoryHandle] = useState<BrowserDirectoryHandle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const enterLooper = async () => {
    setBusy(true)
    setError(null)
    try {
      await startBrowserGsproRuntime()
      setSetupState('ready')
    } catch (runtimeError) {
      setError(runtimeError instanceof Error ? runtimeError.message : String(runtimeError))
      setSetupState('error')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (bypass) {
      setSetupState('ready')
      return
    }

    if (!isBrowserGsproAccessSupported()) {
      setSetupState('unsupported')
      return
    }

    let cancelled = false

    const restore = async () => {
      try {
        const handle = await loadGsproDirectoryHandle()
        if (cancelled) {
          return
        }
        if (!handle) {
          setSetupState('needs-folder')
          return
        }

        setDirectoryHandle(handle)
        const permission = await queryGsproDirectoryPermission(handle, 'readwrite')
        if (cancelled) {
          return
        }

        if (permission === 'granted') {
          localStorage.removeItem(PERSISTENCE_NUDGE_KEY)
          await startBrowserGsproRuntime()
          if (!cancelled) {
            setSetupState('ready')
          }
          return
        }

        setSetupState('needs-permission')
      } catch (restoreError) {
        if (!cancelled) {
          setError(restoreError instanceof Error ? restoreError.message : String(restoreError))
          setSetupState('error')
        }
      }
    }

    void restore()

    return () => {
      cancelled = true
    }
  }, [bypass])

  const chooseFolder = async () => {
    setBusy(true)
    setError(null)
    try {
      const handle = await chooseGsproDirectory()
      await handle.getFileHandle('GSPro.db')
      await saveGsproDirectoryHandle(handle)
      setDirectoryHandle(handle)
      localStorage.setItem(PERSISTENCE_NUDGE_KEY, '1')
      setSetupState('session-ready')
    } catch (chooseError) {
      const message = chooseError instanceof Error ? chooseError.message : String(chooseError)
      if (message.toLowerCase().includes('abort')) {
        setSetupState('needs-folder')
      } else {
        setError(
          message.includes('GSPro.db')
            ? 'That folder does not contain GSPro.db. Choose the GSPro folder inside AppData\\LocalLow\\GSPro.'
            : message,
        )
        setSetupState('needs-folder')
      }
    } finally {
      setBusy(false)
    }
  }

  const restorePermission = async () => {
    if (!directoryHandle) {
      setSetupState('needs-folder')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const permission = await requestGsproDirectoryPermission(directoryHandle, 'readwrite')
      if (permission !== 'granted') {
        setError('Chrome did not grant GSPro folder access. Try again and choose Allow every time.')
        return
      }
      localStorage.removeItem(PERSISTENCE_NUDGE_KEY)
      await enterLooper()
    } catch (permissionError) {
      setError(permissionError instanceof Error ? permissionError.message : String(permissionError))
    } finally {
      setBusy(false)
    }
  }

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(DEFAULT_GSPRO_PATH)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  if (setupState === 'ready') {
    return children
  }

  if (setupState === 'checking') {
    return (
      <main className="gspro-setup">
        <section className="gspro-setup__card gspro-setup__card--compact">
          <span className="gspro-setup__eyebrow">Looper setup</span>
          <h1>Connecting to GSPro…</h1>
        </section>
      </main>
    )
  }

  if (setupState === 'unsupported') {
    return (
      <main className="gspro-setup">
        <section className="gspro-setup__card">
          <span className="gspro-setup__eyebrow">Looper setup</span>
          <h1>Open Looper in Chrome on your GSPro PC</h1>
          <p>
            Direct GSPro connection currently requires desktop Chrome or Edge on Windows. This is the no-download path.
          </p>
          <button type="button" className="gspro-setup__secondary" onClick={() => setSetupState('ready')}>
            Continue without GSPro
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="gspro-setup">
      <section className="gspro-setup__card">
        <span className="gspro-setup__eyebrow">Looper · GSPro connection</span>

        {setupState === 'needs-folder' ? (
          <>
            <h1>Connect GSPro</h1>
            <p className="gspro-setup__lead">
              Looper can read GSPro directly from Chrome. No SimRead download is required.
            </p>
            <div className="gspro-setup__step">
              <strong>Choose the folder containing GSPro.db</strong>
              <p>GSPro normally stores it here. In the Windows folder picker, press Ctrl + L and paste this path.</p>
              <div className="gspro-setup__path-row">
                <code>{DEFAULT_GSPRO_PATH}</code>
                <button type="button" className="gspro-setup__secondary" onClick={() => void copyPath()}>
                  {copied ? 'Copied' : 'Copy path'}
                </button>
              </div>
            </div>
            <button
              type="button"
              className="gspro-setup__primary"
              disabled={busy}
              onClick={() => void chooseFolder()}
            >
              {busy ? 'Opening…' : 'Choose GSPro folder'}
            </button>
          </>
        ) : null}

        {setupState === 'needs-permission' ? (
          <>
            <h1>Keep GSPro connected</h1>
            <p className="gspro-setup__lead">
              Looper remembered your GSPro folder. One final Chrome permission makes the connection persist.
            </p>
            <div className="gspro-setup__callout">
              <strong>Important:</strong> after you click below, choose <strong>Allow every time</strong> in Chrome.
            </div>
            <button
              type="button"
              className="gspro-setup__primary"
              disabled={busy}
              onClick={() => void restorePermission()}
            >
              {busy ? 'Connecting…' : 'Keep GSPro connected'}
            </button>
          </>
        ) : null}

        {setupState === 'session-ready' ? (
          <>
            <h1>GSPro connected</h1>
            <p className="gspro-setup__lead">
              You are ready for this session. On a future visit Chrome may ask one more time for folder access.
            </p>
            <div className="gspro-setup__callout">
              If that happens, Looper will show a <strong>Keep GSPro connected</strong> button. Choose <strong>Allow every time</strong> in Chrome and you should not have to do this again.
            </div>
            <button
              type="button"
              className="gspro-setup__primary"
              disabled={busy}
              onClick={() => void enterLooper()}
            >
              {busy ? 'Starting…' : 'Enter Looper'}
            </button>
          </>
        ) : null}

        {setupState === 'error' ? (
          <>
            <h1>GSPro connection needs attention</h1>
            <p className="gspro-setup__lead">{error ?? 'Looper could not start the browser GSPro connection.'}</p>
            <button type="button" className="gspro-setup__primary" onClick={() => window.location.reload()}>
              Try again
            </button>
          </>
        ) : null}

        {error && setupState !== 'error' ? <div className="gspro-setup__error">{error}</div> : null}
      </section>
    </main>
  )
}
