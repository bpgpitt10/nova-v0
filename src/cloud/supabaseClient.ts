export type LooperAuthUser = {
  id: string
  email?: string | null
  user_metadata?: Record<string, unknown>
}

export type AllowedUserRecord = {
  email: string
  enabled: boolean
  is_admin: boolean
  display_name: string | null
}

type SupabaseError = {
  message: string
}

type SupabaseQueryResult<T> = {
  data: T | null
  error: SupabaseError | null
}

type SupabaseQueryBuilder<T> = {
  select(columns?: string): SupabaseQueryBuilder<T>
  eq(column: string, value: unknown): SupabaseQueryBuilder<T>
  maybeSingle(): Promise<SupabaseQueryResult<T>>
  upsert(
    values: Record<string, unknown> | Array<Record<string, unknown>>,
    options?: Record<string, unknown>,
  ): Promise<SupabaseQueryResult<unknown>>
  delete(): SupabaseQueryBuilder<T>
}

type AuthSubscription = {
  unsubscribe(): void
}

type SupabaseAuthSession = {
  user: LooperAuthUser
}

type SupabaseClientLike = {
  auth: {
    getUser(): Promise<{
      data: { user: LooperAuthUser | null }
      error: SupabaseError | null
    }>
    setSession(tokens: {
      access_token: string
      refresh_token: string
    }): Promise<{
      data: { session: SupabaseAuthSession | null }
      error: SupabaseError | null
    }>
    signInWithOAuth(options: {
      provider: 'google'
      options?: { redirectTo?: string }
    }): Promise<{ error: SupabaseError | null }>
    signInWithOtp(options: {
      email: string
      options?: {
        emailRedirectTo?: string
        shouldCreateUser?: boolean
      }
    }): Promise<{ error: SupabaseError | null }>
    signOut(): Promise<{ error: SupabaseError | null }>
    onAuthStateChange(
      callback: (event: string, session: SupabaseAuthSession | null) => void,
    ): { data: { subscription: AuthSubscription } }
  }
  from<T>(table: string): SupabaseQueryBuilder<T>
}

type SupabaseGlobal = Window & {
  supabase?: {
    createClient(
      url: string,
      key: string,
      options?: Record<string, unknown>,
    ): SupabaseClientLike
  }
}

const SUPABASE_JS_VERSION = '2.115.0'
const SUPABASE_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SUPABASE_JS_VERSION}/dist/umd/supabase.js`
const SUPABASE_SCRIPT_MARKER = `looper-supabase-${SUPABASE_JS_VERSION}`

// Publishable Supabase project configuration is intentionally safe to ship in a browser bundle.
// Environment variables can override these values later without changing the application code.
const DEFAULT_SUPABASE_URL = 'https://kdjfdchzfemjpmaqpobn.supabase.co'
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Lu_EV3L6mSIzQzcB0fESsA_4bJcnT4T'

let clientPromise: Promise<SupabaseClientLike> | null = null

const config = () => ({
  url:
    (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ||
    DEFAULT_SUPABASE_URL,
  key:
    (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim() ||
    (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ||
    DEFAULT_SUPABASE_PUBLISHABLE_KEY,
})

export const isSupabaseConfigured = () => {
  const current = config()
  return Boolean(current.url && current.key)
}

const loadSupabaseScript = () =>
  new Promise<void>((resolve, reject) => {
    const globalWindow = window as SupabaseGlobal
    if (globalWindow.supabase?.createClient) {
      resolve()
      return
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-looper-supabase="${SUPABASE_SCRIPT_MARKER}"]`,
    )
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener(
        'error',
        () => reject(new Error('Could not load Looper account services.')),
        { once: true },
      )
      return
    }

    const script = document.createElement('script')
    script.src = SUPABASE_SCRIPT_URL
    script.async = true
    script.dataset.looperSupabase = SUPABASE_SCRIPT_MARKER
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener(
      'error',
      () => reject(new Error('Could not load Looper account services.')),
      { once: true },
    )
    document.head.appendChild(script)
  })

export const getSupabaseClient = async (): Promise<SupabaseClientLike> => {
  if (!isSupabaseConfigured()) {
    throw new Error('Looper account services are not configured.')
  }

  if (clientPromise) {
    return clientPromise
  }

  clientPromise = (async () => {
    await loadSupabaseScript()
    const globalWindow = window as SupabaseGlobal
    const createClient = globalWindow.supabase?.createClient
    if (!createClient) {
      throw new Error('Looper account services loaded without a Supabase client.')
    }

    const current = config()
    return createClient(current.url, current.key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Looper handles the implicit callback explicitly below. Doing this
        // deterministically avoids a startup race between URL detection and the
        // auth gate's first getUser() call on a fresh magic-link redirect.
        detectSessionInUrl: false,
        flowType: 'implicit',
      },
    })
  })()

  return clientPromise
}

const consumeImplicitAuthRedirect = async (client: SupabaseClientLike) => {
  if (!window.location.hash) {
    return
  }

  const params = new URLSearchParams(window.location.hash.slice(1))
  const authError = params.get('error_description') || params.get('error')
  if (authError) {
    throw new Error(authError)
  }

  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  if (!accessToken && !refreshToken) {
    return
  }
  if (!accessToken || !refreshToken) {
    throw new Error('Looper received an incomplete sign-in response. Please request a new sign-in link.')
  }

  const result = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  })
  if (result.error) {
    throw new Error(result.error.message)
  }

  // Remove credentials from the address bar once Supabase has persisted them.
  window.history.replaceState(
    window.history.state,
    document.title,
    `${window.location.pathname}${window.location.search}`,
  )
}

export const getCurrentLooperUser = async () => {
  const client = await getSupabaseClient()
  await consumeImplicitAuthRedirect(client)

  const result = await client.auth.getUser()
  if (result.error) {
    // A brand-new visitor has no Supabase session yet. That is the normal
    // signed-out state, not an account-service failure.
    if (result.error.message.toLowerCase().includes('auth session missing')) {
      return null
    }
    throw new Error(result.error.message)
  }
  return result.data.user
}

export const getAllowedUserRecord = async (
  user: LooperAuthUser,
): Promise<AllowedUserRecord | null> => {
  if (!user.email) {
    return null
  }

  const client = await getSupabaseClient()
  const result = await client
    .from<AllowedUserRecord>('allowed_users')
    .select('email, enabled, is_admin, display_name')
    .eq('email', user.email)
    .eq('enabled', true)
    .maybeSingle()

  if (result.error) {
    throw new Error(result.error.message)
  }

  return result.data
}

export const signInLooperWithGoogle = async () => {
  const client = await getSupabaseClient()
  const result = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
    },
  })
  if (result.error) {
    throw new Error(result.error.message)
  }
}

export const sendLooperMagicLink = async (email: string) => {
  const client = await getSupabaseClient()
  const result = await client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin,
      shouldCreateUser: true,
    },
  })
  if (result.error) {
    throw new Error(result.error.message)
  }
}

export const signOutLooper = async () => {
  const client = await getSupabaseClient()
  const result = await client.auth.signOut()
  if (result.error) {
    throw new Error(result.error.message)
  }
}

export const subscribeToLooperAuth = async (
  callback: (user: LooperAuthUser | null) => void,
) => {
  const client = await getSupabaseClient()
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null)
  })
  return () => data.subscription.unsubscribe()
}
