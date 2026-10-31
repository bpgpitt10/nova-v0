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

type SupabaseQueryBuilder<T> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns?: string): SupabaseQueryBuilder<T>
  eq(column: string, value: unknown): SupabaseQueryBuilder<T>
  in(column: string, values: readonly unknown[]): SupabaseQueryBuilder<T>
  order(column: string, options?: { ascending?: boolean }): SupabaseQueryBuilder<T>
  limit(count: number): SupabaseQueryBuilder<T>
  insert(values: Record<string, unknown> | Array<Record<string, unknown>>): SupabaseQueryBuilder<T>
  single(): Promise<SupabaseQueryResult<T>>
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

type SupabaseAuthResult = {
  data: {
    user: LooperAuthUser | null
    session: SupabaseAuthSession | null
  }
  error: SupabaseError | null
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
    signInWithPassword(options: {
      email: string
      password: string
    }): Promise<SupabaseAuthResult>
    signUp(options: {
      email: string
      password: string
      options?: { emailRedirectTo?: string }
    }): Promise<SupabaseAuthResult>
    resetPasswordForEmail(
      email: string,
      options?: { redirectTo?: string },
    ): Promise<{ error: SupabaseError | null }>
    updateUser(attributes: {
      password?: string
    }): Promise<{
      data: { user: LooperAuthUser | null }
      error: SupabaseError | null
    }>
    signOut(): Promise<{ error: SupabaseError | null }>
    onAuthStateChange(
      callback: (event: string, session: SupabaseAuthSession | null) => void,
    ): { data: { subscription: AuthSubscription } }
  }
  from<T>(table: string): SupabaseQueryBuilder<T>
  functions: {
    invoke<T = unknown>(name: string, options?: { body?: unknown }): Promise<{ data: T | null; error: SupabaseError | null }>
  }
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
        // Looper handles implicit OAuth, confirmation, and recovery redirects explicitly.
        // Doing this deterministically avoids a startup race between URL detection and
        // the auth gate's first getUser() call on a fresh auth redirect.
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
    throw new Error('Looper received an incomplete authentication response. Please try again.')
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

const looperRootUrl = () => `${window.location.origin}/`

const passwordResetUrl = () => {
  const url = new URL('/', window.location.origin)
  url.searchParams.set('reset-password', '1')
  return url.toString()
}

export const signInLooperWithGoogle = async () => {
  const client = await getSupabaseClient()
  const result = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: looperRootUrl(),
    },
  })
  if (result.error) {
    throw new Error(result.error.message)
  }
}

export const signInLooperWithPassword = async (email: string, password: string) => {
  const client = await getSupabaseClient()
  const result = await client.auth.signInWithPassword({
    email,
    password,
  })
  if (result.error) {
    throw new Error(result.error.message)
  }
  return result.data
}

export const signUpLooperWithPassword = async (email: string, password: string) => {
  const client = await getSupabaseClient()
  const result = await client.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: looperRootUrl(),
    },
  })
  if (result.error) {
    throw new Error(result.error.message)
  }
  return {
    user: result.data.user,
    requiresEmailConfirmation: !result.data.session,
  }
}

export const sendLooperPasswordReset = async (email: string) => {
  const client = await getSupabaseClient()
  const result = await client.auth.resetPasswordForEmail(email, {
    redirectTo: passwordResetUrl(),
  })
  if (result.error) {
    throw new Error(result.error.message)
  }
}

export const updateLooperPassword = async (password: string) => {
  const client = await getSupabaseClient()
  const result = await client.auth.updateUser({ password })
  if (result.error) {
    throw new Error(result.error.message)
  }
  return result.data.user
}

export const signOutLooper = async () => {
  const client = await getSupabaseClient()
  const result = await client.auth.signOut()
  if (result.error) {
    throw new Error(result.error.message)
  }
}

export const subscribeToLooperAuth = async (
  callback: (event: string, user: LooperAuthUser | null) => void,
) => {
  const client = await getSupabaseClient()
  const { data } = client.auth.onAuthStateChange((event, session) => {
    callback(event, session?.user ?? null)
  })
  return () => data.subscription.unsubscribe()
}
