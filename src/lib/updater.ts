import { check, type Update } from '@tauri-apps/plugin-updater'

export type LooperUpdateCheckResult =
  | { status: 'unavailable' }
  | { status: 'up-to-date' }
  | { status: 'available'; update: Update }

export const isTauriRuntime = () =>
  typeof window !== 'undefined' &&
  Boolean((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__)

export const checkForLooperUpdate = async (): Promise<LooperUpdateCheckResult> => {
  if (!isTauriRuntime()) {
    return { status: 'unavailable' }
  }

  const update = await check()
  return update ? { status: 'available', update } : { status: 'up-to-date' }
}
