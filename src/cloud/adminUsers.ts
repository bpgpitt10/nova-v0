import {
  getAllowedUserRecord,
  getCurrentLooperUser,
  getSupabaseClient,
  type AllowedUserRecord,
} from './supabaseClient'

type AwaitableQueryResult<T> = {
  data: T | null
  error: { message: string } | null
}

const awaitQuery = async <T>(query: unknown): Promise<T | null> => {
  const result = await (query as Promise<AwaitableQueryResult<T>>)
  if (result.error) {
    throw new Error(result.error.message)
  }
  return result.data
}

export const isCurrentLooperAdmin = async () => {
  const user = await getCurrentLooperUser()
  if (!user) {
    return false
  }
  const allowed = await getAllowedUserRecord(user)
  return allowed?.is_admin === true
}

export const listAllowedUsersForAdmin = async (): Promise<AllowedUserRecord[]> => {
  if (!(await isCurrentLooperAdmin())) {
    throw new Error('This Looper account is not an admin.')
  }

  const client = await getSupabaseClient()
  const rows = await awaitQuery<AllowedUserRecord[]>(
    client.from<AllowedUserRecord[]>('allowed_users').select(
      'email, enabled, is_admin, display_name',
    ),
  )
  return (rows ?? []).sort((a, b) => a.email.localeCompare(b.email))
}

export const upsertAllowedUserForAdmin = async (input: {
  email: string
  displayName?: string
  enabled?: boolean
  isAdmin?: boolean
}) => {
  if (!(await isCurrentLooperAdmin())) {
    throw new Error('This Looper account is not an admin.')
  }

  const client = await getSupabaseClient()
  const result = await client.from<unknown>('allowed_users').upsert(
    {
      email: input.email.trim().toLowerCase(),
      enabled: input.enabled ?? true,
      is_admin: input.isAdmin ?? false,
      display_name: input.displayName?.trim() || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'email' },
  )
  if (result.error) {
    throw new Error(result.error.message)
  }
}

export const setAllowedUserEnabledForAdmin = async (email: string, enabled: boolean) => {
  if (!(await isCurrentLooperAdmin())) {
    throw new Error('This Looper account is not an admin.')
  }

  const client = await getSupabaseClient()
  const current = await client
    .from<AllowedUserRecord>('allowed_users')
    .select('email, enabled, is_admin, display_name')
    .eq('email', email)
    .maybeSingle()

  if (current.error) {
    throw new Error(current.error.message)
  }
  if (!current.data) {
    throw new Error('Looper user was not found.')
  }

  const result = await client.from<unknown>('allowed_users').upsert(
    {
      email: current.data.email,
      enabled,
      is_admin: current.data.is_admin,
      display_name: current.data.display_name,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'email' },
  )
  if (result.error) {
    throw new Error(result.error.message)
  }
}
