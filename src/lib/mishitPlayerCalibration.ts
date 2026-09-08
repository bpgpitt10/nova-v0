import type { MishitPlayerCalibration } from '../mishit-classifier'

const STORAGE_KEY = 'looper-mishit-player-calibrations-v1'

export type MishitPlayerCalibrationMap = Record<string, MishitPlayerCalibration>

const isCalibration = (value: unknown): value is MishitPlayerCalibration => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Partial<MishitPlayerCalibration>
  return (
    typeof candidate.version === 'number' &&
    Number.isFinite(candidate.version) &&
    (candidate.source === 'manual' ||
      candidate.source === 'human_review' ||
      candidate.source === 'imported') &&
    (candidate.status === 'provisional' || candidate.status === 'stable')
  )
}

/**
 * Player calibration is Looper/profile state, not classifier configuration.
 * The pure classifier never imports localStorage or this module.
 */
export const loadMishitPlayerCalibrations = (): MishitPlayerCalibrationMap => {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    const normalized: MishitPlayerCalibrationMap = {}
    Object.entries(parsed as Record<string, unknown>).forEach(([populationKey, value]) => {
      if (isCalibration(value)) {
        normalized[populationKey] = {
          ...value,
          populationKey,
        }
      }
    })
    return normalized
  } catch {
    return {}
  }
}

export const saveMishitPlayerCalibrations = (
  calibrations: MishitPlayerCalibrationMap,
) => {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(calibrations))
}

export const getMishitPlayerCalibration = (populationKey: string) =>
  loadMishitPlayerCalibrations()[populationKey]

export const setMishitPlayerCalibration = (
  populationKey: string,
  calibration: MishitPlayerCalibration,
) => {
  const calibrations = loadMishitPlayerCalibrations()
  const next = {
    ...calibrations,
    [populationKey]: {
      ...calibration,
      populationKey,
    },
  }
  saveMishitPlayerCalibrations(next)
  return next
}

export const removeMishitPlayerCalibration = (populationKey: string) => {
  const calibrations = loadMishitPlayerCalibrations()
  const next = { ...calibrations }
  delete next[populationKey]
  saveMishitPlayerCalibrations(next)
  return next
}
