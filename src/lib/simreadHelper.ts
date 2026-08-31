export type SimReadHelperStartResult = {
  ok: boolean
  status: 'already_running' | 'started' | 'failed'
  message?: string
  node_path?: string
  cli_path?: string
  cwd?: string
  detail?: string
}

// Compatibility seam for the existing session flow while the web migration is underway.
// The browser build must never launch or manage a local SimRead process.
export const isTauriRuntime = () => false

export const startSimReadHelper = async (): Promise<SimReadHelperStartResult> => ({
  ok: true,
  status: 'already_running',
  message: 'Web GSPro mode: no local SimRead helper is started.',
})
