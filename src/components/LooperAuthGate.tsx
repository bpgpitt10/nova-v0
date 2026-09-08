import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { bootstrapLooperCloudData } from '../cloud/cloudBootstrap'
import {
  getAllowedUserRecord,
  getCurrentLooperUser,
  isSupabaseConfigured,
  sendLooperMagicLink,
  signOutLooper,
  subscribeToLooperAuth,
  type AllowedUserRecord,
  type LooperAuthUser,
} from '../cloud/supabaseClient'
import { deactivateLocalUserScope } from '../lib/localUserScope'
import { loadSavedSessions } from '../lib/sessions'
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

  const bootstrapUserData = async (
    nextUser: LooperAuthUser,
    access: AllowedUserRecord,
  ) => {
    if (!bootstrapRef.current || bootstrapRef.current.userId !== nextUser.id) {
      bootstrapRef.current = {
        userId: nextUser.id,
        promise: bootstrapLooperCloudData(nextUser.id, {
          // Brian/admin is the controlled migration path for the old pre-auth
          // browser cache. Normal invitees always start from their own scope.
          claimUnscopedLegacyData: access.is_admin,
        })
          .then((result) => {
            if (result.warnings.length > 0) {
              console.warn('[Cloud Bootstrap] completed with local safety copy retained', result)
            } else {
              console.info('[Cloud Bootstrap] complete', result)
            }

            // RootRouter and several analysis views initialize from local storage before
            // the auth gate finishes hydrating cloud history. When cloud history changed
            // that local cache, reload once so every existing view starts from the newly
            // hydrated data. The next bootstrap sees identical history, preventing a loop.
            if (result.sessionHistoryChanged) {
              window.location.reload()
            }
          })
          .catch((bootstrapError) => {
            // If this user's isolated browser scope already has usable local history,
            // keep Looper available as an offline-safe fallback. An empty browser must
            // not silently continue after a failed cloud read.
            const hasUsableLocalHistory = loadSavedSessions().some(
              (session) => session.shots.length > 0,
            )
            if (hasUsableLocalHistory) {
              console.warn(
                '[Cloud Bootstrap] cloud bootstrap failed; continuing with existing local data',
                bootstrapError,
              )
              return
            }
            throw bootstrapError
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
      // Keep the prior user's safety copy under its private namespace, but clear
      // the generic working cache before another account can sign in.
      deactivateLocalUserScope()
      setState('signed-out')
      return
    }

    setState('checking-access')
    try {
      const allowlistRecord = await getAllowedUserRecord(nextUser)
      if (!allowlistRecord) {
        // An uninvited signed-in identity must not inherit the previous allowed
        // user's working cache while it sees the invite-only screen.
        deactivateLocalUserScope()
        setState('not-allowed')
        return
      }
      setAllowedUser(allowlistRecord)
      setState('syncing-data')
      await bootstrapUserData(nextUser, allowlistRecord)
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

    const startAuth = async () => {
      try {
        // Subscribe first so a SIGNED_IN event emitted while the implicit callback is
        // being consumed cannot slip between the initial session check and listener setup.
        const stop = await subscribeToLooperAuth((nextUser) => {
          if (!cancelled) {
            void resolveAccess(nextUser)
          }
        })
        if (cancelled) {
          stop()
          return
        }
        unsubscribe = stop

        const initialUser = await getCurrentLooperUser()
        if (!cancelled) {
          await resolveAccess(initialUser)
        }
      } catch (authError) {
        if (!cancelled) {
          setError(authError instanceof Error ? authError.message : String(authError))
          setState('error')
        }
      }
    }

    void startAuth()

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

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
      deactivateLocalUserScope()
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
          Looper is currently a small invite-only golf project. Enter the email address that was invited.
        </p>

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
              <button type="submit" className="looper-auth__primary" disabled={busy || !email.trim()}>
                {busy ? 'Sending…' : 'Send me a sign-in link'}
              </button>
            </div>
          </form>
        )}

        <p className="looper-auth__fineprint">
          No password required. Access is limited to approved email addresses.
        </p>

        {allowedUser?.display_name ? (
          <span className="looper-auth__sr-only">Signed in as {allowedUser.display_name}</span>
        ) : null}
        {error ? <div className="looper-auth__error">{error}</div> : null}
      </section>
    </main>
  )
}
