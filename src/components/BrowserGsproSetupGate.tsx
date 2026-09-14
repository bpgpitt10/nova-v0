import { useEffect, useState, type ReactNode } from 'react'
import {
  chooseGsproDirectory,
  isBrowserGsproAccessSupported,
  loadGsproDirectoryHandle,
  queryGsproDirectoryPermission,
  requestGsproDirectoryPermission,
  saveGsproDirectoryHandle,
  type BrowserDirectoryHandle,
} from '../adapters/browserGsproAccess'
import { prepareBrowserGsproRuntime } from '../adapters/browserGsproLive'
import { SESSION_HISTORY_UPDATED_EVENT } from '../lib/sessions'
import { publishLiveCaddieProfilesToGsproFolder } from '../liveCaddie/profilePublisher'
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
}

const DEFAULT_GSPRO_PATH = '%USERPROFILE%\\AppData\\LocalLow\\GSPro\\GSPro'

const isTauriRuntime = () =>
  typeof window !== 'undefined' &&
  Boolean(
    (window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown }).__TAURI__ ||
      (window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__,
  )

const isWindowsBrowser = () =>
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

export default function BrowserGsproSetupGate({
  children,
}: BrowserGsproSetupGateProps) {
  const [setupState, setSetupState] = useState<SetupState>('checking')
  const [directoryHandle, setDirectoryHandle] = useState<BrowserDirectoryHandle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const prepareAndEnterLooper = async () => {
    setBusy(true)
    setError(null)
    try {
      const prepared = await prepareBrowserGsproRuntime()
      if (!prepared) {
        setSetupState('needs-permission')
        return
      }
      setSetupState('ready')
    } catch (runtimeError) {
      setError(runtimeError instanceof Error ? runtimeError.message : String(runtimeError))
      setSetupState('error')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    // The direct-file flow is only for the hosted Windows browser experience.
    // Tauri keeps its existing local helper path; Mac/other devices remain normal Looper viewers.
    if (isTauriRuntime() || !isWindowsBrowser()) {
      setSetupState('ready')
      return
    }

    if (!isBrowserGsproAccessSupported()) {
      setSetupState('unsupported')
      return
    }

    // Developer/admin replay hook: useful for inspecting first-time onboarding
    // without deleting the browser's previously saved folder handle.
    if (new URLSearchParams(window.location.search).get('gsproSetup') === '1') {
      setSetupState('needs-folder')
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
          const prepared = await prepareBrowserGsproRuntime()
          if (!cancelled) {
            setSetupState(prepared ? 'ready' : 'needs-permission')
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
  }, [])

  useEffect(() => {
    if (setupState !== 'ready' || isTauriRuntime() || !isWindowsBrowser()) {
      return
    }

    let cancelled = false
    let publishBusy = false
    let republishRequested = false

    const publishProfiles = async () => {
      if (cancelled) {
        return
      }
      if (publishBusy) {
        republishRequested = true
        return
      }

      publishBusy = true
      try {
        const result = await publishLiveCaddieProfilesToGsproFolder()
        if (result.status === 'published') {
          console.info('[Live Caddie] player profiles published to GSPro folder', result)
        } else if (result.status === 'failed') {
          console.warn('[Live Caddie] player profile publish failed; normal Looper remains available', result)
        } else {
          console.info('[Live Caddie] player profile publish skipped', result)
        }
      } finally {
        publishBusy = false
        if (republishRequested && !cancelled) {
          republishRequested = false
          void publishProfiles()
        }
      }
    }

    const onSessionHistoryUpdated = () => {
      void publishProfiles()
    }

    // LooperAuthGate finishes cloud bootstrap before this gate renders, so this
    // initial write materializes the user's current persisted history immediately.
    void publishProfiles()
    window.addEventListener(SESSION_HISTORY_UPDATED_EVENT, onSessionHistoryUpdated)

    return () => {
      cancelled = true
      window.removeEventListener(SESSION_HISTORY_UPDATED_EVENT, onSessionHistoryUpdated)
    }
  }, [setupState])

  const chooseFolder = async () => {
    setBusy(true)
    setError(null)
    try {
      const handle = await chooseGsproDirectory()
      await handle.getFileHandle('GSPro.db')
      await saveGsproDirectoryHandle(handle)
      setDirectoryHandle(handle)
      setSetupState('session-ready')
    } catch (chooseError) {
      const message = chooseError instanceof Error ? chooseError.message : String(chooseError)
      if (message.toLowerCase().includes('abort')) {
        setSetupState('needs-folder')
      } else {
        setError(
          message.includes('GSPro.db')
            ? 'Looper could not find GSPro.db in that folder. Copy the suggested folder location below and try again.'
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

      const prepared = await prepareBrowserGsproRuntime()
      if (!prepared) {
        setError('Looper could not restore the saved GSPro connection.')
        return
      }
      setSetupState('ready')
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
          <h1>Use Chrome or Edge for direct GSPro connection</h1>
          <p>
            Direct GSPro connection currently requires desktop Chrome or Edge on Windows.
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
        <span className="gspro-setup__eyebrow">Looper · First-time setup</span>

        {setupState === 'needs-folder' ? (
          <>
            <h1>Connect GSPro</h1>
            <p className="gspro-setup__lead">
              Looper reads your GSPro shot data directly from this simulator PC. Nothing needs to be uploaded manually, and you should only need to choose this folder once.
            </p>

            <div className="gspro-setup__step">
              <strong>1. Copy your GSPro folder location</strong>
              <p>
                Windows fills in your own user profile automatically, so you do not need to know or type your Windows username.
              </p>
              <div className="gspro-setup__path-row">
                <code>{DEFAULT_GSPRO_PATH}</code>
                <button type="button" className="gspro-setup__secondary" onClick={() => void copyPath()}>
                  {copied ? 'Copied' : 'Copy folder location'}
                </button>
              </div>
            </div>

            <div className="gspro-setup__step">
              <strong>2. Choose that folder</strong>
              <p>
                Click the button below. In the Windows folder picker, press <strong>Ctrl + L</strong>, paste the copied location, press <strong>Enter</strong>, then choose the <strong>GSPro</strong> folder.
              </p>
              <p>
                Looper will automatically check for <strong>GSPro.db</strong>. If the wrong folder is selected, it will not be accepted.
              </p>
            </div>

            <button
              type="button"
              className="gspro-setup__primary"
              disabled={busy}
              onClick={() => void chooseFolder()}
            >
              {busy ? 'Opening…' : 'Choose GSPro folder'}
            </button>
            <button
              type="button"
              className="gspro-setup__secondary"
              disabled={busy}
              onClick={() => setSetupState('ready')}
              style={{ marginLeft: 10 }}
            >
              Continue without GSPro
            </button>
          </>
        ) : null}

        {setupState === 'needs-permission' ? (
          <>
            <h1>Keep GSPro connected</h1>
            <p className="gspro-setup__lead">
              Looper remembered your GSPro folder. One final Chrome permission lets this browser keep using it on future visits.
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
            <h1>GSPro found</h1>
            <p className="gspro-setup__lead">
              Looper found <strong>GSPro.db</strong> and saved this folder for this browser.
            </p>
            <div className="gspro-setup__callout">
              On a future visit Chrome may ask once more for folder access. If it does, choose <strong>Allow every time</strong> and Looper should reconnect automatically after that.
            </div>
            <button
              type="button"
              className="gspro-setup__primary"
              disabled={busy}
              onClick={() => void prepareAndEnterLooper()}
            >
              {busy ? 'Starting…' : 'Continue to Looper'}
            </button>
          </>
        ) : null}

        {setupState === 'error' ? (
          <>
            <h1>GSPro connection needs attention</h1>
            <p className="gspro-setup__lead">{error ?? 'Looper could not prepare the browser GSPro connection.'}</p>
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
