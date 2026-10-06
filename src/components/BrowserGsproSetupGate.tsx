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
import looperLogoWhite from '../assets/LooperLogoWhite.png'
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
  children?: ReactNode
}

const DEFAULT_GSPRO_PATH = '%USERPROFILE%\\AppData\\LocalLow\\GSPro\\GSPro'
const GSPRO_ONBOARDING_KEY = 'looper-gspro-onboarding-complete-v1'

const isTauriRuntime = () =>
  typeof window !== 'undefined' &&
  Boolean(
    (window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown }).__TAURI__ ||
      (window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__,
  )

const isWindowsBrowser = () =>
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

const markOnboardingComplete = () => {
  try {
    window.localStorage.setItem(GSPRO_ONBOARDING_KEY, '1')
  } catch {
    // onboarding persistence is a convenience only
  }
}

export default function BrowserGsproSetupGate({
  children,
}: BrowserGsproSetupGateProps) {
  const [setupState, setSetupState] = useState<SetupState>('checking')
  const [directoryHandle, setDirectoryHandle] = useState<BrowserDirectoryHandle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const setupRequested =
    typeof window !== 'undefined' &&
    (window.location.pathname === '/gspro-setup' ||
      new URLSearchParams(window.location.search).get('gsproSetup') === '1')
  const isSetupPage = children === undefined || setupRequested
  const returnToRange =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('return') === 'range'

  const finishSetup = () => {
    markOnboardingComplete()
    window.location.assign(returnToRange ? '/?openRange=1' : '/')
  }

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
      if (isSetupPage) {
        finishSetup()
      }
    } catch (runtimeError) {
      setError(runtimeError instanceof Error ? runtimeError.message : String(runtimeError))
      setSetupState('error')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    // Direct folder access is only needed for the hosted Windows browser.
    // Tauri and non-Windows viewers can still use the rest of Looper normally.
    if (isTauriRuntime()) {
      setSetupState('ready')
      return
    }

    if (!isWindowsBrowser() || !isBrowserGsproAccessSupported()) {
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
          console.warn(
            '[Live Caddie] player profile publish failed; normal Looper remains available',
            result,
          )
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
      if (isSetupPage) {
        finishSetup()
      }
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

  // When used around the normal application, this component now prepares GSPro
  // opportunistically instead of blocking Dashboard/Looper access.
  if (!isSetupPage) {
    return children
  }

  if (setupState === 'checking') {
    return (
      <main className="gspro-setup">
        <section className="gspro-setup__card gspro-setup__card--compact">
          <img alt="The Looper" className="gspro-setup__logo" src={looperLogoWhite} />
          <span className="gspro-setup__eyebrow">GSPro setup</span>
          <h1>Checking your GSPro connection…</h1>
        </section>
      </main>
    )
  }

  if (setupState === 'unsupported') {
    return (
      <main className="gspro-setup">
        <section className="gspro-setup__card">
          <img alt="The Looper" className="gspro-setup__logo" src={looperLogoWhite} />
          <span className="gspro-setup__eyebrow">GSPro setup</span>
          <h1>Open Looper on your simulator PC</h1>
          <p className="gspro-setup__lead">
            Direct GSPro connection currently requires desktop Chrome or Edge on Windows. Dashboard
            and your saved Looper data still work normally from this device.
          </p>
          <button type="button" className="gspro-setup__secondary" onClick={() => window.location.assign('/')}>
            Return to Looper
          </button>
        </section>
      </main>
    )
  }

  if (setupState === 'ready') {
    return (
      <main className="gspro-setup">
        <section className="gspro-setup__card gspro-setup__card--compact">
          <img alt="The Looper" className="gspro-setup__logo" src={looperLogoWhite} />
          <span className="gspro-setup__eyebrow">GSPro setup</span>
          <h1>GSPro connected</h1>
          <p className="gspro-setup__lead">
            Looper can read the GSPro folder on this simulator PC.
          </p>
          <div className="gspro-setup__actions">
            <button type="button" className="gspro-setup__primary" onClick={finishSetup}>
              {returnToRange ? 'Continue to Practice Range' : 'Return to Looper'}
            </button>
            <button
              type="button"
              className="gspro-setup__secondary"
              onClick={() => {
                setError(null)
                setSetupState('needs-folder')
              }}
            >
              Choose a different folder
            </button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="gspro-setup">
      <section className="gspro-setup__card">
        <img alt="The Looper" className="gspro-setup__logo" src={looperLogoWhite} />
        <span className="gspro-setup__eyebrow">GSPro setup</span>

        {setupState === 'needs-folder' ? (
          <>
            <h1>Connect GSPro</h1>
            <p className="gspro-setup__lead">
              Looper reads your GSPro shot data directly from this simulator PC. Nothing needs to be
              uploaded manually, and you should only need to choose this folder once.
            </p>

            <div className="gspro-setup__step">
              <strong>1. Copy your GSPro folder location</strong>
              <p>
                Windows fills in your own user profile automatically, so you do not need to know or
                type your Windows username.
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
                Click the button below. In the Windows folder picker, press <strong>Ctrl + L</strong>,
                paste the copied location, press <strong>Enter</strong>, then choose the
                <strong> GSPro</strong> folder.
              </p>
              <p>
                Looper automatically checks for <strong>GSPro.db</strong>. If the wrong folder is
                selected, it will not be accepted.
              </p>
            </div>

            <div className="gspro-setup__actions">
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
                onClick={() => window.location.assign('/')}
              >
                Not now
              </button>
            </div>
          </>
        ) : null}

        {setupState === 'needs-permission' ? (
          <>
            <h1>Reconnect GSPro</h1>
            <p className="gspro-setup__lead">
              Looper remembers your GSPro folder, but this browser needs permission to use it again.
            </p>
            <div className="gspro-setup__callout">
              After you click below, choose <strong>Allow every time</strong> in Chrome.
            </div>
            <div className="gspro-setup__actions">
              <button
                type="button"
                className="gspro-setup__primary"
                disabled={busy}
                onClick={() => void restorePermission()}
              >
                {busy ? 'Connecting…' : 'Reconnect GSPro'}
              </button>
              <button
                type="button"
                className="gspro-setup__secondary"
                disabled={busy}
                onClick={() => {
                  setError(null)
                  setSetupState('needs-folder')
                }}
              >
                Choose a different folder
              </button>
            </div>
          </>
        ) : null}

        {setupState === 'session-ready' ? (
          <>
            <h1>GSPro found</h1>
            <p className="gspro-setup__lead">
              Looper found <strong>GSPro.db</strong> and saved this folder for this browser.
            </p>
            <div className="gspro-setup__callout">
              On a future visit Chrome may ask once more for folder access. If it does, choose
              <strong> Allow every time</strong>.
            </div>
            <button
              type="button"
              className="gspro-setup__primary"
              disabled={busy}
              onClick={() => void prepareAndEnterLooper()}
            >
              {busy ? 'Starting…' : returnToRange ? 'Continue to Practice Range' : 'Continue to Looper'}
            </button>
          </>
        ) : null}

        {setupState === 'error' ? (
          <>
            <h1>GSPro connection needs attention</h1>
            <p className="gspro-setup__lead">
              {error ?? 'Looper could not prepare the browser GSPro connection.'}
            </p>
            <div className="gspro-setup__actions">
              <button
                type="button"
                className="gspro-setup__primary"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
              <button
                type="button"
                className="gspro-setup__secondary"
                onClick={() => {
                  setError(null)
                  setSetupState('needs-folder')
                }}
              >
                Choose folder
              </button>
            </div>
          </>
        ) : null}

        {error && setupState !== 'error' ? <div className="gspro-setup__error">{error}</div> : null}
      </section>
    </main>
  )
}
