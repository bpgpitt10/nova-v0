export type SimReadHelperStartResult = {
  ok: boolean
  status: 'already_running' | 'started' | 'failed'
  message?: string
  node_path?: string
  cli_path?: string
  cwd?: string
  detail?: string
}

const DEFAULT_SIMREAD_HEALTH_URL = 'http://127.0.0.1:8788/health'

const resolveHealthUrl = () =>
  (import.meta.env.VITE_SIMREAD_HEALTH_URL as string | undefined)?.trim()
  || DEFAULT_SIMREAD_HEALTH_URL

// Retained for caller compatibility: a browser cannot spawn local processes.
// This now verifies the independently-run localhost service instead.
export const startSimReadHelper = async (): Promise<SimReadHelperStartResult> => {
  const healthUrl = resolveHealthUrl()
  try {
    const response = await fetch(healthUrl, { cache: 'no-store' })
    if (!response.ok) {
      return {
        ok: false,
        status: 'failed',
        message: `SimRead local service returned HTTP ${response.status}. Start the local service separately and retry.`,
        detail: healthUrl,
      }
    }

    return {
      ok: true,
      status: 'already_running',
      message: 'SimRead local service is reachable.',
      detail: healthUrl,
    }
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      message: 'SimRead local service is not reachable. Start it separately; the Looper web app does not launch local executables.',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
