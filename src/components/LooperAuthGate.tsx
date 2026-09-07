import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { bootstrapLooperCloudData } from '../cloud/cloudBootstrap'
import {
  getAllowedUserRecord,
  getCurrentLooperUser,
  isSupabaseConfigured,
  sendLooperMagicLink,
  signInLooperWithGoogle,
  signOutLooper,
  subscribeToLooperAuth,
  type AllowedUserRecord,
  type LooperAuthUser,
} from '../cloud/supabaseClient'
import './LooperAuthGate.css'

type AuthState =
  | 'checking'
  | 'signed-out'
  | 'checking-access'
  | 'syncing-data'
  | 'allowed'
  | 'not-allowed'
  | 'error'

type Props = {
  children: ReactNode
}

export default function LooperAuthGate({ children }: Props) {
  const [state, setState] = useState<AuthState>(
    isSupabaseConfigured() ? 'checking' : 'allowed',
  )
  const [user, setUser] = useState<LooperAuthUser | null>(null)
  const [allowedUser, setAllowedUser] = useState<AllowedUserRecord | null>(null)
  const [email, setEmail] = useState('')
  const [magicLinkSent, setMagicLinkSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bootstrapRef = useRef<{ userId: string; promise: Promise<void> } | null>(null)

  const bootstrapUserData = async (nextUser: LooperAuthUser) => {
    if (!bootstrapRef.current || bootstrapRef.current.userId !== nextUser.id) {
      bootstrapRef.current = {
        userId: nextUser.id,
        promise: bootstrapLooperCloudData(nextUser.id)
          .then((result) => {
            if (result.warnings.length > 0) {
              console.warn('[Cloud Bootstrap] completed with local safety copy retained', result)
            } else {
              console.info('[Cloud Bootstrap] complete', result)
            }
          })
          .catch((bootstrapError) => {
            // Cloud migration must never make the existing local Looper unusable.
            console.warn('[Cloud Bootstrap] cloud bootstrap failed; continuing with local data', bootstrapError)
          }),
      }
    }

    await bootstrapRef.current.promise
  }

  const resolveAccess = async (nextUser: LooperAuthUser | null) => {
    setUser(nextUser)
    setAllowedUser(null)
    setError(null)

    if (!nextUser) {
      setState('signed-out')
      return
    }

    setState('checking-access')
    try {
      const allowlistRecord = await getAllowedUserRecord(nextUser)
      if (!allowlistRecord) {
        setState('not-allowed')
        return
      }
      setAllowedUser(allowlistRecord)
      setState('syncing-data')
      await bootstrapUserData(nextUser)
      setState('allowed')
    } catch (accessError) {
      setError(accessError instanceof Error ? accessError.message : String(accessError))
      setState('error')
    }
  }

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setState('allowed')
      return
    }

    let cancelled = false
    let unsubscribe: (() => void) | null = null

    void getCurrentLooperUser()
      .then((initialUser) => {
        if (!cancelled) {
          return resolveAccess(initialUser)
        }
        return undefined
      })
      .then(() => subscribeToLooperAuth((nextUser) => {
        if (!cancelled) {
          void resolveAccess(nextUser)
        }
      }))
      .then((stop) => {
        if (cancelled) {
          stop()
        } else {
          unsubscribe = stop
        }
      })
      .catch((authError) => {
        if (!cancelled) {
          setError(authError instanceof Error ? authError.message : String(authError))
          setState('error')
        }
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  const handleGoogle = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInLooperWithGoogle()
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : String(signInError))
      setBusy(false)
    }
  }

  const handleMagicLink = async (event: FormEvent) => {
    event.preventDefault()
    const normalized = email.trim().toLowerCase()
    if (!normalized) {
      return
    }

    setBusy(true)
    setError(null)
    try {
      await sendLooperMagicLink(normalized)
      setMagicLinkSent(true)
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : String(signInError))
    } finally {
      setBusy(false)
    }
  }

  const handleSignOut = async () => {
    setBusy(true)
    setError(null)
    try {
      await signOutLooper()
      setState('signed-out')
      setUser(null)
    } catch (signOutError) {
      setError(signOutError instanceof Error ? signOutError.message : String(signOutError))
    } finally {
      setBusy(false)
    }
  }

  if (state === 'allowed') {
    return children
  }

  if (state === 'checking' || state === 'checking-access' || state === 'syncing-data') {
    const heading =
      state === 'checking-access'
        ? 'Checking your invite…'
        : state === 'syncing-data'
          ? 'Preparing your Looper data…'
          : 'Signing you in…'
    return (
      <main className="looper-auth">
        <section className="looper-auth__card looper-auth__card--compact">
          <span className="looper-auth__eyebrow">The Looper</span>
          <h1>{heading}</h1>
          {state === 'syncing-data' ? (
            <p className="looper-auth__lead">
              Your existing local data stays intact while Looper connects it to your account.
            </p>
          ) : null}
        </section>
      </main>
    )
  }

  if (state === 'not-allowed') {
    return (
      <main className="looper-auth">
        <section className="looper-auth__card">
          <span className="looper-auth__eyebrow">The Looper</span>
          <h1>Looper is invite only</h1>
          <p className="looper-auth__lead">
            {user?.email
              ? `${user.email} is signed in, but it is not currently on the Looper access list.`
              : 'This account is not currently on the Looper access list.'}
          </p>
          <button type="button" className="looper-auth__secondary" disabled={busy} onClick={() => void handleSignOut()}>
            Sign out
          </button>
          {error ? <div className="looper-auth__error">{error}</div> : null}
        </section>
      </main>
    )
  }

  if (state === 'error') {
    return (
      <main className="looper-auth">
        <section className="looper-auth__card">
          <span className="looper-auth__eyebrow">The Looper</span>
          <h1>Account connection needs attention</h1>
          <p className="looper-auth__lead">{error ?? 'Looper could not check your account.'}</p>
          <button type="button" className="looper-auth__primary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="looper-auth">
      <section className="looper-auth__card">
        <span className="looper-auth__eyebrow">The Looper</span>
        <h1>Sign in</h1>
        <p className="looper-auth__lead">
          Looper is currently a small invite-only golf project.
        </p>

        <button
          type="button"
          className="looper-auth__primary looper-auth__full"
          disabled={busy}
          onClick={() => void handleGoogle()}
        >
          Continue with Google
        </button>

        <div className="looper-auth__divider"><span>or</span></div>

        {magicLinkSent ? (
          <div className="looper-auth__success">
            Check your email. The sign-in link will bring you back to Looper.
          </div>
        ) : (
          <form onSubmit={(event) => void handleMagicLink(event)}>
            <label className="looper-auth__label" htmlFor="looper-email">Email</label>
            <div className="looper-auth__email-row">
              <input
                id="looper-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
              <button type="submit" className="looper-auth__secondary" disabled={busy || !email.trim()}>
                Email me a sign-in link
              </button>
            </div>
          </form>
        )}

        <p className="looper-auth__fineprint">
          No Looper password required. Access is still limited to approved email addresses.
        </p>

        {allowedUser?.display_name ? (
          <span className="looper-auth__sr-only">Signed in as {allowedUser.display_name}</span>
        ) : null}
        {error ? <div className="looper-auth__error">{error}</div> : null}
      </section>
    </main>
  )
}
