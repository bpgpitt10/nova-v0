import type { BrowserGsproCourseArchiveShot } from '../adapters/browserGsproCourseArchive'
import type { SavedSession, Shot } from '../types'
import {
  loadBagConfig,
  type Club,
} from './bagConfig'
import { isShotIncludedInAnalysis } from './historicalModel'
import {
  LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY,
  persistWorkingCacheValueForActiveUser,
} from './localUserScope'
import { buildShotProfilesForIdentity } from './shotProfiles'

export const LIVE_CADDIE_ARMED_CLUB_UPDATED_EVENT = 'looper-live-caddie-armed-club-updated'
export const CLUB_INFERENCE_MODEL_VERSION = 'player-gaussian-v1'

export type ArmedLiveClub = {
  club: Club
  armedAt: string
  recommendedClub: Club | null
}

export type ClubInferenceAlternative = {
  club: Club
  probability: number
  score: number
  supportShots: number
}

export type ClubInferenceResult = {
  predictedClub: Club | null
  confidence: number | null
  alternatives: ClubInferenceAlternative[]
  modelVersion: typeof CLUB_INFERENCE_MODEL_VERSION
  evaluatedAt: string
  metricsUsed: string[]
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isClub = (value: unknown): value is Club => {
  const configured = loadBagConfig()?.selectedClubs ?? []
  return typeof value === 'string' && configured.includes(value as Club)
}

export const loadArmedLiveClub = (): ArmedLiveClub | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ArmedLiveClub>
    if (!isClub(parsed.club) || typeof parsed.armedAt !== 'string') return null
    return {
      club: parsed.club,
      armedAt: parsed.armedAt,
      recommendedClub: isClub(parsed.recommendedClub) ? parsed.recommendedClub : null,
    }
  } catch {
    return null
  }
}

export const armLiveClub = (
  club: Club,
  recommendedClub: Club | null = null,
): ArmedLiveClub => {
  const armed: ArmedLiveClub = {
    club,
    armedAt: new Date().toISOString(),
    recommendedClub,
  }
  const serialized = JSON.stringify(armed)
  window.localStorage.setItem(LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY, serialized)
  persistWorkingCacheValueForActiveUser(LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY, serialized)
  window.dispatchEvent(new Event(LIVE_CADDIE_ARMED_CLUB_UPDATED_EVENT))
  return armed
}

export const clearArmedLiveClub = () => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY)
  persistWorkingCacheValueForActiveUser(LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY, null)
  window.dispatchEvent(new Event(LIVE_CADDIE_ARMED_CLUB_UPDATED_EVENT))
}

type MetricDefinition = {
  name: string
  observed: number | null
  mean: number | undefined
  sigma: number | undefined
  floorSigma: number
  weight: number
}

const inferenceScore = (metrics: readonly MetricDefinition[]) => {
  const usable = metrics.filter(
    (metric) => finite(metric.observed) && finite(metric.mean),
  )
  if (usable.length === 0) return null

  let weightedSquaredZ = 0
  let totalWeight = 0
  for (const metric of usable) {
    const sigma = Math.max(
      metric.floorSigma,
      finite(metric.sigma) ? Math.abs(metric.sigma) : 0,
    )
    const z = ((metric.observed as number) - (metric.mean as number)) / sigma
    weightedSquaredZ += metric.weight * z * z
    totalWeight += metric.weight
  }

  return {
    score: totalWeight > 0 ? weightedSquaredZ / totalWeight : Number.POSITIVE_INFINITY,
    metricsUsed: usable.map((metric) => metric.name),
  }
}

const sessionShotsForClub = (sessions: readonly SavedSession[], club: Club): Shot[] =>
  sessions
    .filter((session) => session.metadata?.includeInAnalysis !== false)
    .flatMap((session) => session.shots)
    .filter((shot) => shot.club === club && isShotIncludedInAnalysis(shot))

/**
 * Shadow-only club classifier. Manual attribution remains authoritative.
 *
 * This intentionally starts simple and player-specific: compare the observed
 * GSPro shot with each club's historical Stock profile using robust per-metric
 * spreads (plus conservative floors), then normalize the relative likelihoods.
 * The stored predictions give us labeled validation data before inference is
 * ever allowed to assign a club operationally.
 */
export const inferClubForGsproShot = (
  sessions: readonly SavedSession[],
  shot: BrowserGsproCourseArchiveShot,
  evaluatedAt = new Date().toISOString(),
): ClubInferenceResult => {
  const configuredClubs = loadBagConfig()?.selectedClubs ?? []
  const candidates = configuredClubs.flatMap((club) => {
    const historicalShots = sessionShotsForClub(sessions, club)
    if (historicalShots.length < 3) return []

    const profile = buildShotProfilesForIdentity({
      shots: historicalShots,
      club,
    }).mostLikely
    if (!profile) return []

    const result = inferenceScore([
      {
        name: 'carry',
        observed: shot.carryYards,
        mean: profile.carry,
        sigma: profile.carryVariability,
        floorSigma: 7,
        weight: 1.5,
      },
      {
        name: 'total',
        observed: shot.totalYards,
        mean: profile.total,
        sigma: profile.totalVariability,
        floorSigma: 9,
        weight: 0.8,
      },
      {
        name: 'ball_speed',
        observed: shot.ballSpeedMph,
        mean: profile.ballSpeed,
        sigma: undefined,
        floorSigma: 5,
        weight: 1.25,
      },
      {
        name: 'launch',
        observed: shot.verticalLaunchAngleDegrees,
        mean: profile.launch,
        sigma: profile.launchVariability,
        floorSigma: 3.5,
        weight: 0.55,
      },
      {
        name: 'spin',
        observed: shot.totalSpinRpm,
        mean: profile.spin,
        sigma: profile.spinVariability,
        floorSigma: 800,
        weight: 0.45,
      },
    ])
    if (!result || result.metricsUsed.length < 2) return []

    // Slightly temper tiny historical samples without allowing support volume
    // to overwhelm the actual launch/distance similarity.
    const supportPrior = Math.min(1, Math.sqrt(historicalShots.length / 10))
    const likelihood = Math.exp(-0.5 * result.score) * supportPrior
    return [{
      club,
      score: result.score,
      likelihood,
      supportShots: historicalShots.length,
      metricsUsed: result.metricsUsed,
    }]
  })

  if (candidates.length === 0) {
    return {
      predictedClub: null,
      confidence: null,
      alternatives: [],
      modelVersion: CLUB_INFERENCE_MODEL_VERSION,
      evaluatedAt,
      metricsUsed: [],
    }
  }

  const denominator = candidates.reduce((sum, candidate) => sum + candidate.likelihood, 0)
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      probability: denominator > 0 ? candidate.likelihood / denominator : 0,
    }))
    .sort((left, right) => right.probability - left.probability)

  const top = ranked[0]
  return {
    predictedClub: top?.club ?? null,
    confidence: top?.probability ?? null,
    alternatives: ranked.slice(0, 3).map((candidate) => ({
      club: candidate.club,
      probability: candidate.probability,
      score: candidate.score,
      supportShots: candidate.supportShots,
    })),
    modelVersion: CLUB_INFERENCE_MODEL_VERSION,
    evaluatedAt,
    metricsUsed: top?.metricsUsed ?? [],
  }
}
