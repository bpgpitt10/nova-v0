import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import looperLogo from '../assets/LooperLogoWhite.png'
import authBackground from '../assets/Backgrounds/looper-auth-background.webp'
import { bootstrapLooperCloudData } from '../cloud/cloudBootstrap'
import {
  getAllowedUserRecord,
  getCurrentLooperUser,
  isSupabaseConfigured,
  sendLooperPasswordReset,
  signInLooperWithGoogle,
  signInLooperWithPassword,
  signOutLooper,
  signUpLooperWithPassword,
  subscribeToLooperAuth,
  updateLooperPassword,
  type AllowedUserRecord,
  type LooperAuthUser,
} from '../cloud/supabaseClient'
import { deactivateLocalUserScope } from '../lib/localUserScope'
import { loadSavedSessions } from '../lib/sessions'
import { flushPendingShotVariantSync } from '../lib/shotVariants'
import './LooperAuthGate.css'

type AuthState =
  | 'checking'
  | 'signed-out'
  | 'checking-access'
  | 'syncing-data'
  | 'reset-password'
  | 'allowed'
  | 'not-allowed'
  | 'error'

type AuthMode = 'sign-in' | 'sign-up' | 'forgot-password'

type Props = {
  children: ReactNode
}

const GOOGLE_AUTH_ENABLED = import.meta.env.VITE_ENABLE_GOOGLE_AUTH === 'true'

const AUTH_BACKGROUND_STYLE = {
  '--looper-auth-background': `url(${authBackground})`,
} as CSSProperties

const AuthBrand = () => (
  <img className="looper-auth__logo" src={looperLogo} alt="The Looper" />
)

const isPasswordResetReturn = () =>
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('reset-password') === '1'

export default function LooperAuthGate({ children }: Props) {
  const [state, setState] = useState<AuthState>(
    isSupabaseConfigured() ? 'checking' : 'allowed',
  )
  const [user, setUser] = useState<LooperAuthUser | null>(null)
  const [allowedUser, setAllowedUser] = useState<AllowedUserRecord | null>(null)
  const [mode, setMode] = useState<AuthMode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const bootstrapRef = useRef<{ userId: string; promise: Promise<void> } | null>(null)
  const passwordResetFlowRef = useRef(isPasswordResetReturn())
  const authorizedUserIdRef = useRef<string | null>(null)

  const bootstrapUserData = async (
    nextUser: LooperAuthUser,
    access: AllowedUserRecord,
  ) => {
    if (!bootstrapRef.current || bootstrapRef.current.userId !== nextUser.id) {
      bootstrapRef.current = {
        userId: nextUser.id,
        promise: bootstrapLooperCloudData(nextUser.id, {
          // Brian/admin is the controlled migration path for the old pre-auth
          // browser cache. Normal users always start from their own scope.
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
      authorizedUserIdRef.current = null
      // Keep the prior user's safety copy under its private namespace, but clear
      // the generic working cache before another account can sign in.
      deactivateLocalUserScope()
      setState('signed-out')
      return
    }

    // Password recovery creates a temporary authenticated Supabase session. Keep
    // the app gated until the golfer has actually chosen the new password.
    if (passwordResetFlowRef.current) {
      authorizedUserIdRef.current = null
      setState('reset-password')
      return
    }

    // A genuinely different account must pass the access/bootstrap path. Same-user
    // refresh/focus events are filtered by the auth listener before reaching here.
    if (authorizedUserIdRef.current !== nextUser.id) {
      authorizedUserIdRef.current = null
    }

    setState('checking-access')
    try {
      const allowlistRecord = await getAllowedUserRecord(nextUser)
      if (!allowlistRecord) {
        authorizedUserIdRef.current = null
        // A disabled or otherwise unprovisioned signed-in identity must not inherit
        // the previous allowed user's working cache while access is blocked.
        deactivateLocalUserScope()
        setState('not-allowed')
        return
      }
      setAllowedUser(allowlistRecord)
      setState('syncing-data')
      await bootstrapUserData(nextUser, allowlistRecord)
      authorizedUserIdRef.current = nextUser.id
      setState('allowed')
    } catch (accessError) {
      authorizedUserIdRef.current = null
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
        // Subscribe first so a SIGNED_IN event emitted while an implicit OAuth,
        // confirmation, or recovery callback is being consumed cannot slip between
        // the initial session check and listener setup.
        const stop = await subscribeToLooperAuth((event, nextUser) => {
          if (cancelled) {
            return
          }

          // getCurrentLooperUser() immediately below is the single source of truth
          // for startup. Ignoring Supabase's initial callback avoids duplicate access
          // checks and bootstraps during first render.
          if (event === 'INITIAL_SESSION') {
            return
          }

          // Supabase may emit SIGNED_IN/TOKEN_REFRESHED again when a tab regains focus
          // even though the golfer has not changed. Do not tear down the authenticated
          // app for those same-user events; doing so remounts pages and loses route/view
          // state. A real account change or sign-out still goes through resolveAccess.
          if (
            nextUser &&
            authorizedUserIdRef.current === nextUser.id &&
            !passwordResetFlowRef.current
          ) {
            setUser(nextUser)
            return
          }

          void resolveAccess(nextUser)
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
          authorizedUserIdRef.current = null
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

  const clearFormFeedback = () => {
    setError(null)
    setSuccessMessage(null)
  }

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode)
    setPassword('')
    setConfirmPassword('')
    clearFormFeedback()
  }

  const handleGoogle = async () => {
    setBusy(true)
    clearFormFeedback()
    try {
      await signInLooperWithGoogle()
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : String(signInError))
      setBusy(false)
    }
  }

  const handlePasswordAuth = async (event: FormEvent) => {
    event.preventDefault()
    const normalized = email.trim().toLowerCase()
    if (!normalized || !password) {
      return
    }

    if (mode === 'sign-up' && password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setBusy(true)
    clearFormFeedback()
    try {
      if (mode === 'sign-up') {
        const result = await signUpLooperWithPassword(normalized, password)
        if (result.requiresEmailConfirmation) {
          setSuccessMessage(
            'Check your email to verify your account, then sign in with your password.',
          )
          setPassword('')
          setConfirmPassword('')
        } else {
          setSuccessMessage('Account created. Signing you in…')
        }
      } else {
        await signInLooperWithPassword(normalized, password)
      }
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : String(signInError))
    } finally {
      setBusy(false)
    }
  }

  const handleForgotPassword = async (event: FormEvent) => {
    event.preventDefault()
    const normalized = email.trim().toLowerCase()
    if (!normalized) {
      return
    }

    setBusy(true)
    clearFormFeedback()
    try {
      await sendLooperPasswordReset(normalized)
      setSuccessMessage('Check your email for a secure password-reset link.')
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError))
    } finally {
      setBusy(false)
    }
  }

  const handleResetPassword = async (event: FormEvent) => {
    event.preventDefault()
    if (!password) {
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setBusy(true)
    clearFormFeedback()
    // updateUser can emit USER_UPDATED. Drop recovery mode before that event so
    // the listener can continue through the normal access/data bootstrap path.
    passwordResetFlowRef.current = false
    try {
      await updateLooperPassword(password)
      const url = new URL(window.location.href)
      url.searchParams.delete('reset-password')
      window.history.replaceState(
        window.history.state,
        document.title,
        `${url.pathname}${url.search}${url.hash}`,
      )
      setPassword('')
      setConfirmPassword('')
      if (user) {
        await resolveAccess(user)
      }
    } catch (resetError) {
      passwordResetFlowRef.current = true
      setError(resetError instanceof Error ? resetError.message : String(resetError))
    } finally {
      setBusy(false)
    }
  }

  const handleSignOut = async () => {
    setBusy(true)
    setError(null)
    try {
      // Let the last account-owned variant edit finish while this user's auth
      // session is still valid. The dirty marker remains as the recovery path if
      // the network write cannot complete.
      await flushPendingShotVariantSync()
      await signOutLooper()
      authorizedUserIdRef.current = null
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
    return (
      <>
        {user ? (
          <div className="looper-account-control">
            <details className="looper-account-control__details">
              <summary className="looper-account-control__summary">
                <span className="looper-account-control__email">{user.email ?? 'Account'}</span>
                <span aria-hidden="true" className="looper-account-control__chevron">▾</span>
              </summary>
              <div className="looper-account-control__menu">
                <button
                  type="button"
                  className="looper-account-control__logout"
                  disabled={busy}
                  onClick={() => void handleSignOut()}
                >
                  {busy ? 'Logging out…' : 'Log out'}
                </button>
                {error ? <div className="looper-account-control__error">{error}</div> : null}
              </div>
            </details>
          </div>
        ) : null}
        {children}
      </>
    )
  }

  if (state === 'checking' || state === 'checking-access' || state === 'syncing-data') {
    const heading =
      state === 'checking-access'
        ? 'Checking your account…'
        : state === 'syncing-data'
          ? 'Preparing your Looper data…'
          : 'Signing you in…'
    return (
      <main className="looper-auth" style={AUTH_BACKGROUND_STYLE}>
        <section className="looper-auth__card looper-auth__card--compact">
          <AuthBrand />
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

  if (state === 'reset-password') {
    return (
      <main className="looper-auth" style={AUTH_BACKGROUND_STYLE}>
        <section className="looper-auth__card looper-auth__card--compact">
          <AuthBrand />
          <h1>Set a new password</h1>
          <p className="looper-auth__lead">
            Choose the password you’ll use to sign in to Looper from now on.
          </p>
          <form className="looper-auth__form" onSubmit={(event) => void handleResetPassword(event)}>
            <div className="looper-auth__field">
              <label className="looper-auth__label" htmlFor="looper-new-password">New password</label>
              <input
                id="looper-new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={6}
              />
            </div>
            <div className="looper-auth__field">
              <label className="looper-auth__label" htmlFor="looper-confirm-new-password">Confirm password</label>
              <input
                id="looper-confirm-new-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
                minLength={6}
              />
            </div>
            <button type="submit" className="looper-auth__primary looper-auth__full" disabled={busy}>
              {busy ? 'Saving…' : 'Save password'}
            </button>
          </form>
          {error ? <div className="looper-auth__error">{error}</div> : null}
        </section>
      </main>
    )
  }

  if (state === 'not-allowed') {
    return (
      <main className="looper-auth" style={AUTH_BACKGROUND_STYLE}>
        <section className="looper-auth__card">
          <AuthBrand />
          <h1>Account access disabled</h1>
          <p className="looper-auth__lead">
            {user?.email
              ? `${user.email} is signed in, but this account is not currently enabled for Looper.`
              : 'This account is not currently enabled for Looper.'}
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
      <main className="looper-auth" style={AUTH_BACKGROUND_STYLE}>
        <section className="looper-auth__card">
          <AuthBrand />
          <h1>Account connection needs attention</h1>
          <p className="looper-auth__lead">{error ?? 'Looper could not check your account.'}</p>
          <button type="button" className="looper-auth__primary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </section>
      </main>
    )
  }

  const isForgotPassword = mode === 'forgot-password'
  const isSignUp = mode === 'sign-up'

  return (
    <main className="looper-auth" style={AUTH_BACKGROUND_STYLE}>
      <section className="looper-auth__card">
        <AuthBrand />
        {isForgotPassword || isSignUp ? (
          <>
            <h1>{isForgotPassword ? 'Reset password' : 'Create account'}</h1>
            <p className="looper-auth__lead">
              {isForgotPassword
                ? 'Enter your email and we’ll send you a secure link to choose a new password.'
                : 'Create your Looper account with your email and password.'}
            </p>
          </>
        ) : null}

        {GOOGLE_AUTH_ENABLED && !isForgotPassword ? (
          <>
            <button
              type="button"
              className="looper-auth__secondary looper-auth__full looper-auth__google"
              disabled={busy}
              onClick={() => void handleGoogle()}
            >
              Continue with Google
            </button>
            <div className="looper-auth__divider">or</div>
          </>
        ) : null}

        {isForgotPassword ? (
          <form className="looper-auth__form" onSubmit={(event) => void handleForgotPassword(event)}>
            <div className="looper-auth__field">
              <label className="looper-auth__label" htmlFor="looper-reset-email">Email</label>
              <input
                id="looper-reset-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
            </div>
            <button type="submit" className="looper-auth__primary looper-auth__full" disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        ) : (
          <form className="looper-auth__form" onSubmit={(event) => void handlePasswordAuth(event)}>
            <div className="looper-auth__field">
              <label className="looper-auth__label" htmlFor="looper-email">Email</label>
              <input
                id="looper-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
            </div>
            <div className="looper-auth__field">
              <label className="looper-auth__label" htmlFor="looper-password">Password</label>
              <input
                id="looper-password"
                type="password"
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={6}
              />
            </div>
            {isSignUp ? (
              <div className="looper-auth__field">
                <label className="looper-auth__label" htmlFor="looper-confirm-password">Confirm password</label>
                <input
                  id="looper-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  minLength={6}
                />
              </div>
            ) : null}
            <button type="submit" className="looper-auth__primary looper-auth__full" disabled={busy || !email.trim() || !password}>
              {busy ? (isSignUp ? 'Creating…' : 'Signing in…') : isSignUp ? 'Create account' : 'Sign in'}
            </button>
          </form>
        )}

        {successMessage ? <div className="looper-auth__success">{successMessage}</div> : null}
        {error ? <div className="looper-auth__error">{error}</div> : null}

        <div className="looper-auth__actions">
          {isForgotPassword ? (
            <button type="button" className="looper-auth__text-button" disabled={busy} onClick={() => switchMode('sign-in')}>
              Back to sign in
            </button>
          ) : isSignUp ? (
            <button type="button" className="looper-auth__text-button" disabled={busy} onClick={() => switchMode('sign-in')}>
              Already have an account? Sign in
            </button>
          ) : (
            <>
              <button type="button" className="looper-auth__text-button" disabled={busy} onClick={() => switchMode('forgot-password')}>
                Forgot password?
              </button>
              <button type="button" className="looper-auth__text-button" disabled={busy} onClick={() => switchMode('sign-up')}>
                Create account
              </button>
            </>
          )}
        </div>

        {!isForgotPassword && !isSignUp ? (
          <p className="looper-auth__fineprint">
            Used Looper before without a password? Use “Forgot password?” once to set one. Your Looper data stays tied to your account.
          </p>
        ) : (
          <p className="looper-auth__fineprint">Your Looper data stays tied to your account.</p>
        )}

        {allowedUser?.display_name ? (
          <span className="looper-auth__sr-only">Signed in as {allowedUser.display_name}</span>
        ) : null}
      </section>
    </main>
  )
}
