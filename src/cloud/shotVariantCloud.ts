import type { ShotVariant } from '../lib/shotVariants'
import {
  getAllowedUserRecord,
  getCurrentLooperUser,
  getSupabaseClient,
  isSupabaseConfigured,
  type LooperAuthUser,
} from './supabaseClient'

export type ShotVariantCloudSyncResult =
  | {
      status: 'skipped'
      reason: 'not-configured' | 'signed-out' | 'not-allowed' | 'user-changed'
    }
  | { status: 'synced' }
  | { status: 'failed'; error: string }

type CloudShotVariantSetRow = {
  variants: ShotVariant[] | null
}

const getAllowedSignedInUser = async (): Promise<LooperAuthUser | null> => {
  if (!isSupabaseConfigured()) {
    return null
  }

  const user = await getCurrentLooperUser()
  if (!user) {
    return null
  }

  const allowed = await getAllowedUserRecord(user)
  return allowed ? user : null
}

const syncFailure = (error: unknown): ShotVariantCloudSyncResult => ({
  status: 'failed',
  error: error instanceof Error ? error.message : String(error),
})

export const syncShotVariantsToCloud = async (
  variants: ShotVariant[],
  expectedUserId?: string,
): Promise<ShotVariantCloudSyncResult> => {
  if (!isSupabaseConfigured()) {
    return { status: 'skipped', reason: 'not-configured' }
  }

  try {
    const user = await getAllowedSignedInUser()
    if (!user) {
      const currentUser = await getCurrentLooperUser()
      return {
        status: 'skipped',
        reason: currentUser ? 'not-allowed' : 'signed-out',
      }
    }

    if (expectedUserId && user.id !== expectedUserId) {
      return { status: 'skipped', reason: 'user-changed' }
    }

    const client = await getSupabaseClient()
    const result = await client.from<unknown>('shot_variant_sets').upsert(
      {
        user_id: user.id,
        variants,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

    if (result.error) {
      throw new Error(result.error.message)
    }

    return { status: 'synced' }
  } catch (error) {
    return syncFailure(error)
  }
}

export const loadShotVariantsForUser = async (
  userId: string,
): Promise<ShotVariant[] | null> => {
  const client = await getSupabaseClient()
  const result = await client
    .from<CloudShotVariantSetRow>('shot_variant_sets')
    .select('variants')
    .eq('user_id', userId)
    .maybeSingle()

  if (result.error) {
    throw new Error(result.error.message)
  }

  if (!result.data) {
    return null
  }

  return Array.isArray(result.data.variants) ? result.data.variants : []
}
