import type { SavedSession, SessionSource } from '../types'
import { resolveShotVariantId } from './shotVariants'

export const LEGACY_UNKNOWN_MEASUREMENT_PROFILE = 'legacy/unknown'
export const LEGACY_IMPORT_MEASUREMENT_PROFILE = 'legacy/import-v1'
export const GSPRO_SIMREAD_MEASUREMENT_PROFILE = 'gspro/simread-v1'
export const NOVA_DIRECT_MEASUREMENT_PROFILE = 'nova/direct-v1'
export const MOCK_MEASUREMENT_PROFILE = 'mock/v1'

// Personal migration guard for the NOVA/import -> EML era change. Once a club +
// shot variant has enough shots from the newest real measurement profile, older
// measurement profiles stop contributing to planning calculations for that same
// identity. Raw sessions remain untouched and visible in history.
export const CURRENT_MEASUREMENT_ERA_MIN_SHOTS = 8

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

type MeasurementEraProfileStats = {
  profile: string
  latestSessionMs: number
  shotIds: string[]
}

type MeasurementEraIdentityStats = Map<string, MeasurementEraProfileStats>

let installedExcludedMeasurementEraShotIds = new Set<string>()

const sessionTimestamp = (session: SavedSession) => {
  const endedAt = new Date(session.endedAt).getTime()
  if (Number.isFinite(endedAt)) {
    return endedAt
  }
  const startedAt = new Date(session.startedAt).getTime()
  return Number.isFinite(startedAt) ? startedAt : 0
}

const measurementEraIdentityKey = (shot: SavedSession['shots'][number]) =>
  `${shot.club}::${resolveShotVariantId(shot.shotVariantId)}`

const isRealCurrentProfileCandidate = (profile: string) =>
  !profile.startsWith('legacy/') && profile !== MOCK_MEASUREMENT_PROFILE

/**
 * Builds a derived, non-persistent rollover state for launch-monitor eras.
 *
 * Before the newest real measurement profile reaches 8 included shots for a
 * club + variant, all historical profiles remain eligible as a cold-start
 * fallback. At 8 shots, only the newest profile is planning-eligible for that
 * identity. Nothing is deleted, redated, or rewritten in SavedSession data.
 */
export const buildMeasurementEraExcludedShotIds = (
  sessions: SavedSession[],
  minCurrentProfileShots = CURRENT_MEASUREMENT_ERA_MIN_SHOTS,
) => {
  const identities = new Map<string, MeasurementEraIdentityStats>()

  sessions.forEach((session) => {
    const profile = resolveMeasurementProfile(session)
    const latestSessionMs = sessionTimestamp(session)

    session.shots.forEach((shot) => {
      if (shot.included === false) {
        return
      }

      const identityKey = measurementEraIdentityKey(shot)
      const profileStatsByName = identities.get(identityKey) ?? new Map()
      const existing = profileStatsByName.get(profile)
      const next: MeasurementEraProfileStats = existing
        ? {
            ...existing,
            latestSessionMs: Math.max(existing.latestSessionMs, latestSessionMs),
            shotIds: [...existing.shotIds, shot.id],
          }
        : {
            profile,
            latestSessionMs,
            shotIds: [shot.id],
          }

      profileStatsByName.set(profile, next)
      identities.set(identityKey, profileStatsByName)
    })
  })

  const excludedShotIds = new Set<string>()

  identities.forEach((profiles) => {
    if (profiles.size <= 1) {
      return
    }

    const newestRealProfile = [...profiles.values()]
      .filter((stats) => isRealCurrentProfileCandidate(stats.profile))
      .sort((left, right) => right.latestSessionMs - left.latestSessionMs)[0]

    if (!newestRealProfile || newestRealProfile.shotIds.length < minCurrentProfileShots) {
      return
    }

    profiles.forEach((stats) => {
      if (stats.profile === newestRealProfile.profile) {
        return
      }
      stats.shotIds.forEach((shotId) => excludedShotIds.add(shotId))
    })
  })

  return excludedShotIds
}

export const installMeasurementEraState = (sessions: SavedSession[]) => {
  installedExcludedMeasurementEraShotIds = buildMeasurementEraExcludedShotIds(sessions)
  return installedExcludedMeasurementEraShotIds
}

export const isShotMeasurementEraEligible = (shotId: string) =>
  !installedExcludedMeasurementEraShotIds.has(shotId)

export const getInstalledMeasurementEraExcludedShotIds = () =>
  new Set(installedExcludedMeasurementEraShotIds)
