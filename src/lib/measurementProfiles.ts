import type { SavedSession, SessionSource } from '../types'

export const LEGACY_UNKNOWN_MEASUREMENT_PROFILE = 'legacy/unknown'
export const LEGACY_IMPORT_MEASUREMENT_PROFILE = 'legacy/import-v1'
export const GSPRO_SIMREAD_MEASUREMENT_PROFILE = 'gspro/simread-v1'
export const NOVA_DIRECT_MEASUREMENT_PROFILE = 'nova/direct-v1'
export const MOCK_MEASUREMENT_PROFILE = 'mock/v1'

const normalizeMeasurementProfile = (value: string | undefined) => {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

export const defaultMeasurementProfileForSessionSource = (
  source: SessionSource | undefined,
) => {
  switch (source) {
    case 'gspro':
      return GSPRO_SIMREAD_MEASUREMENT_PROFILE
    case 'nova':
      return NOVA_DIRECT_MEASUREMENT_PROFILE
    case 'mock':
      return MOCK_MEASUREMENT_PROFILE
    default:
      return LEGACY_UNKNOWN_MEASUREMENT_PROFILE
  }
}

/**
 * Measurement profiles keep launch-monitor-dependent metrics from teaching one
 * another when their numeric scales differ. Explicit session metadata wins.
 * Older history falls back to stable pipeline/source buckets so existing data
 * is separated safely without rewriting raw Shot records.
 */
export const resolveMeasurementProfile = (
  session: Pick<SavedSession, 'metadata' | 'shots'>,
) => {
  const explicit = normalizeMeasurementProfile(session.metadata?.measurementProfile)
  if (explicit) {
    return explicit
  }

  const shotSources = new Set(
    session.shots.map((shot) => String(shot.source ?? '').trim()).filter(Boolean),
  )

  if (shotSources.size > 0 && [...shotSources].every((source) => source === 'simread')) {
    return GSPRO_SIMREAD_MEASUREMENT_PROFILE
  }

  if (shotSources.size > 0 && [...shotSources].every((source) => source === 'mock')) {
    return MOCK_MEASUREMENT_PROFILE
  }

  if (
    shotSources.size > 0 &&
    [...shotSources].every((source) => source === 'legacy_csv' || source === 'legacy-import')
  ) {
    return LEGACY_IMPORT_MEASUREMENT_PROFILE
  }

  return defaultMeasurementProfileForSessionSource(session.metadata?.source)
}
