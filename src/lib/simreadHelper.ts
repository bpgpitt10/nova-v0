import { invoke } from '@tauri-apps/api/core'

export type SimReadHelperStartResult = {
  ok: boolean
  status: 'already_running' | 'started' | 'failed'
  message?: string
}

export const isTauriRuntime = () =>
  typeof window !== 'undefined' &&
  Boolean((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__)

export const startSimReadHelper = async (): Promise<SimReadHelperStartResult> => {
  if (!isTauriRuntime()) {
    return {
      ok: true,
      status: 'already_running',
      message: 'Running outside Tauri; assuming the dev SimRead server is managed separately.',
    }
  }

  return invoke<SimReadHelperStartResult>('start_simread_helper')
}
