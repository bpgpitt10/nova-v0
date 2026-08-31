import type { OpenGolfCoachDerivedValues, OpenGolfCoachInput } from '../types'

export type OgcRuntimeDiagnostics = {
  version: 1
  status: 'idle' | 'skipped' | 'requesting' | 'success' | 'failure'
  updatedAt: string
  attemptCount: number
  successCount: number
  failureCount: number
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastHttpStatus: number | null
  lastInput: OpenGolfCoachInput | null
  lastMissingFields: string[]
  lastDerivedValues: OpenGolfCoachDerivedValues | null
  lastError: string | null
}

const STORAGE_KEY = 'looper:ogc-runtime-diagnostics:v1'

const now = () => new Date().toISOString()

const initialDiagnostics = (): OgcRuntimeDiagnostics => ({
  version: 1,
  status: 'idle',
  updatedAt: now(),
  attemptCount: 0,
  successCount: 0,
  failureCount: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastHttpStatus: null,
  lastInput: null,
  lastMissingFields: [],
  lastDerivedValues: null,
  lastError: null,
})

const storageAvailable = () =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'

export const readOgcRuntimeDiagnostics = (): OgcRuntimeDiagnostics => {
  if (!storageAvailable()) {
    return initialDiagnostics()
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return initialDiagnostics()
    }
    const parsed = JSON.parse(raw) as Partial<OgcRuntimeDiagnostics>
    return {
      ...initialDiagnostics(),
      ...parsed,
      version: 1,
    }
  } catch {
    return initialDiagnostics()
  }
}

const write = (value: OgcRuntimeDiagnostics) => {
  if (!storageAvailable()) {
    return value
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Diagnostics must never interrupt shot enrichment.
  }
  return value
}

const patch = (value: Partial<OgcRuntimeDiagnostics>) => {
  const current = readOgcRuntimeDiagnostics()
  return write({
    ...current,
    ...value,
    version: 1,
    updatedAt: now(),
  })
}

export const recordOgcSkipped = (input: OpenGolfCoachInput, missingFields: string[]) =>
  patch({
    status: 'skipped',
    lastInput: input,
    lastMissingFields: [...missingFields],
    lastError: `Missing or invalid OGC inputs: ${missingFields.join(', ')}`,
  })

export const recordOgcAttempt = (input: OpenGolfCoachInput) => {
  const current = readOgcRuntimeDiagnostics()
  return patch({
    status: 'requesting',
    attemptCount: current.attemptCount + 1,
    lastAttemptAt: now(),
    lastHttpStatus: null,
    lastInput: input,
    lastMissingFields: [],
    lastDerivedValues: null,
    lastError: null,
  })
}

export const recordOgcSuccess = (
  derivedValues: OpenGolfCoachDerivedValues,
  httpStatus: number,
) => {
  const current = readOgcRuntimeDiagnostics()
  return patch({
    status: 'success',
    successCount: current.successCount + 1,
    lastSuccessAt: now(),
    lastHttpStatus: httpStatus,
    lastDerivedValues: derivedValues,
    lastError: null,
  })
}

export const recordOgcFailure = (error: string, httpStatus: number | null = null) => {
  const current = readOgcRuntimeDiagnostics()
  return patch({
    status: 'failure',
    failureCount: current.failureCount + 1,
    lastFailureAt: now(),
    lastHttpStatus: httpStatus,
    lastError: error,
  })
}
