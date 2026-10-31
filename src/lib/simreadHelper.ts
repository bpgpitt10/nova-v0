// Looper is web-only. The desktop shell that could launch the SimRead helper
// process is gone, so the helper is always expected to be run separately.

export type SimReadHelperStartResult = {
  ok: boolean
  status: 'already_running' | 'started' | 'failed'
  message?: string
  node_path?: string
  cli_path?: string
  cwd?: string
  detail?: string
}

export const startSimReadHelper = async (): Promise<SimReadHelperStartResult> => ({
  ok: true,
  status: 'already_running',
  message: 'Web build: the SimRead server is managed separately.',
})
