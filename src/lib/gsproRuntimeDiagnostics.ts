export type GsproRuntimeDiagnostics = {
  version: 1
  status: 'idle' | 'connecting' | 'waiting' | 'error' | 'disconnected'
  sessionStartedAt: string | null
  updatedAt: string
  pageVisibility: DocumentVisibilityState | 'unknown'
  lastVisibilityChangeAt: string | null
  pollCount: number
  successfulReads: number
  readRetryCount: number
  baselineRowId: number | null
  lastObservedRowId: number | null
  lastEmittedRowId: number | null
  rowsEmitted: number
  lastFileSignature: string | null
  lastFileModified: number | null
  lastPollAt: string | null
  lastReadAt: string | null
  lastShotAt: string | null
  lastError: string | null
  lastErrorAt: string | null
}

const STORAGE_KEY = 'looper:gspro-runtime-diagnostics:v1'

const now = () => new Date().toISOString()

const currentVisibility = (): DocumentVisibilityState | 'unknown' =>
  typeof document === 'undefined' ? 'unknown' : document.visibilityState

const initialDiagnostics = (): GsproRuntimeDiagnostics => ({
  version: 1,
  status: 'idle',
  sessionStartedAt: null,
  updatedAt: now(),
  pageVisibility: currentVisibility(),
  lastVisibilityChangeAt: null,
  pollCount: 0,
  successfulReads: 0,
  readRetryCount: 0,
  baselineRowId: null,
  lastObservedRowId: null,
  lastEmittedRowId: null,
  rowsEmitted: 0,
  lastFileSignature: null,
  lastFileModified: null,
  lastPollAt: null,
  lastReadAt: null,
  lastShotAt: null,
  lastError: null,
  lastErrorAt: null,
})

const storageAvailable = () =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'

export const readGsproRuntimeDiagnostics = (): GsproRuntimeDiagnostics => {
  if (!storageAvailable()) {
    return initialDiagnostics()
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return initialDiagnostics()
    }
    const parsed = JSON.parse(raw) as Partial<GsproRuntimeDiagnostics>
    return {
      ...initialDiagnostics(),
      ...parsed,
      version: 1,
    }
  } catch {
    return initialDiagnostics()
  }
}

const write = (value: GsproRuntimeDiagnostics) => {
  if (!storageAvailable()) {
    return value
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Diagnostics must never interrupt live shot capture.
  }
  return value
}

export const resetGsproRuntimeDiagnostics = () =>
  write({
    ...initialDiagnostics(),
    status: 'connecting',
    sessionStartedAt: now(),
    updatedAt: now(),
  })

export const patchGsproRuntimeDiagnostics = (
  patch: Partial<GsproRuntimeDiagnostics>,
) => {
  const current = readGsproRuntimeDiagnostics()
  return write({
    ...current,
    ...patch,
    version: 1,
    updatedAt: now(),
  })
}

export const recordGsproVisibility = () =>
  patchGsproRuntimeDiagnostics({
    pageVisibility: currentVisibility(),
    lastVisibilityChangeAt: now(),
  })

export const recordGsproRuntimeError = (error: unknown) =>
  patchGsproRuntimeDiagnostics({
    status: 'error',
    lastError: error instanceof Error ? error.message : String(error),
    lastErrorAt: now(),
  })
