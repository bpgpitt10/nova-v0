import type { Update } from '@tauri-apps/plugin-updater'

export type LooperUpdateCheckResult =
  | { status: 'unavailable' }
  | { status: 'up-to-date' }
  | { status: 'available'; update: Update }

// Web deployments update when the site is redeployed/refreshed. Keep this API
// temporarily so the existing App shell does not need to change during migration.
export const isTauriRuntime = () => false

export const checkForLooperUpdate = async (): Promise<LooperUpdateCheckResult> => ({
  status: 'unavailable',
})
