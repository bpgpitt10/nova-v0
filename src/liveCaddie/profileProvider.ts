import type { Club } from '../lib/bagConfig'
import { sortClubIds } from '../lib/bagConfig'
import { confidenceConfig } from '../lib/confidenceConfig'
import {
  isShotIncludedInAnalysis,
  isSystemOldExcludedSession,
  sessionHistoricalWeightForClub,
} from '../lib/historicalModel'
import { buildShotProfilesForIdentity } from '../lib/shotProfiles'
import {
  getShotVariantLabel,
  resolveShotVariantId,
  shotsForClubVariant,
  STOCK_SHOT_VARIANT_ID,
} from '../lib/shotVariants'
import type { SavedSession, Shot } from '../types'
import { shotProfilesToLiveCaddieClubProfile } from './profileAdapter'
import type { LiveCaddieClubProfile, LiveCaddieProfileSet } from './types'

const eligibleSessions = (sessions: SavedSession[], nowMs: number) =>
  sessions.filter(
    (session) =>
      session.metadata?.includeInAnalysis !== false &&
      !isSystemOldExcludedSession(session, nowMs),
  )

const clubsFromSessions = (sessions: SavedSession[]): Club[] =>
  sortClubIds(
    Array.from(
      new Set(
        sessions.flatMap((session) =>
          session.shots
            .filter(isShotIncludedInAnalysis)
            .map((shot) => shot.club),
        ),
      ),
    ) as Club[],
  )

const weightedIdentityShots = (
  sessions: SavedSession[],
  club: Club,
  shotVariantId: string,
  nowMs: number,
) => {
  const shots: Shot[] = []
  const weights = new Map<string, number>()
  let supportingSessions = 0

  sessions.forEach((session) => {
    const identityShots = shotsForClubVariant(
      session.shots,
      club,
      shotVariantId,
    ).filter(isShotIncludedInAnalysis)
    if (identityShots.length === 0) {
      return
    }

    const sessionWeight = sessionHistoricalWeightForClub(session, club, nowMs)
    if (sessionWeight <= 0) {
      return
    }

    supportingSessions += 1
    const normalizedShotWeight = sessionWeight / identityShots.length
    identityShots.forEach((shot) => {
      shots.push(shot)
      if (!weights.has(shot.id)) {
        weights.set(shot.id, normalizedShotWeight)
      }
    })
  })

  return { shots, weights, supportingSessions }
}

const customVariantIdsForClub = (sessions: SavedSession[], club: Club) =>
  Array.from(
    new Set(
      sessions
        .flatMap((session) => session.shots)
        .filter(
          (shot) =>
            shot.club === club &&
            isShotIncludedInAnalysis(shot) &&
            resolveShotVariantId(shot.shotVariantId) !== STOCK_SHOT_VARIANT_ID,
        )
        .map((shot) => resolveShotVariantId(shot.shotVariantId)),
    ),
  )

const explicitVariantsForClub = (
  sessions: SavedSession[],
  club: Club,
  baseProfile: LiveCaddieClubProfile,
  nowMs: number,
) => {
  return customVariantIdsForClub(sessions, club).flatMap((variantId) => {
    const weighted = weightedIdentityShots(sessions, club, variantId, nowMs)
    if (weighted.shots.length === 0) {
      return []
    }

    const profiles = buildShotProfilesForIdentity({
      shots: weighted.shots,
      club,
      shotWeightsById: weighted.weights,
    })
    const variantStock = profiles.mostLikely
    if (!variantStock || typeof variantStock.carry !== 'number') {
      return []
    }

    const baseSigma = baseProfile.carry_sigma_yds
    const variantSigma = variantStock.carryVariability
    const sigmaFactor =
      typeof baseSigma === 'number' &&
      baseSigma > 0 &&
      typeof variantSigma === 'number'
        ? variantSigma / baseSigma
        : undefined

    const hasOwnPattern =
      typeof variantStock.carryVariability === 'number' &&
      Number.isFinite(variantStock.carryVariability) &&
      typeof variantStock.dispersionVariability === 'number' &&
      Number.isFinite(variantStock.dispersionVariability)
    const modelReady =
      weighted.shots.length >= confidenceConfig.insufficientData.minIncludedShots &&
      hasOwnPattern

    return [
      {
        name: getShotVariantLabel(club, variantId),
        carry_yds: variantStock.carry,
        // A tagged variant is its own shot identity. Send its actual Looper pattern
        // outputs so the live caddie never borrows Stock wedge dispersion/bias for a
        // 40-yard pitch merely because both shots use the same physical club.
        carry_sigma_yds: variantStock.carryVariability,
        lateral_bias_yds: variantStock.offlineMean ?? 0,
        lateral_sigma_yds: variantStock.dispersionVariability,
        sigma_factor: sigmaFactor,
        support_shots: weighted.shots.length,
        supporting_sessions: weighted.supportingSessions,
        model_ready: modelReady,
        // Under-supported variants remain visible in the contract but are not a
        // modeled playable candidate until their own pattern is sufficiently supported.
        playable: modelReady,
      },
    ]
  })
}

/**
 * Build the caddie's player-model contract from the exact same persisted sessions,
 * historical weighting, Stock/Pure calculation, and dispersion calculation that
 * the normal Looper UI uses. No caddie-specific Stock/Pure math lives here.
 */
export const buildLiveCaddieProfileSet = (
  sessions: SavedSession[],
  nowMs = Date.now(),
): LiveCaddieProfileSet => {
  const analysisSessions = eligibleSessions(sessions, nowMs)
  const clubs = clubsFromSessions(analysisSessions)
  const clubSupport: LiveCaddieProfileSet['club_support'] = []
  const profiles: LiveCaddieClubProfile[] = []

  clubs.forEach((club) => {
    const weighted = weightedIdentityShots(
      analysisSessions,
      club,
      STOCK_SHOT_VARIANT_ID,
      nowMs,
    )
    if (weighted.shots.length === 0) {
      return
    }

    const shotProfiles = buildShotProfilesForIdentity({
      shots: weighted.shots,
      club,
      shotWeightsById: weighted.weights,
    })
    const liveProfile = shotProfilesToLiveCaddieClubProfile(club, shotProfiles)
    if (!liveProfile) {
      return
    }

    const explicitVariants = explicitVariantsForClub(
      analysisSessions,
      club,
      liveProfile,
      nowMs,
    )
    if (explicitVariants.length > 0) {
      liveProfile.explicit_variants = explicitVariants
    }
    profiles.push(liveProfile)

    clubSupport.push({
      club: String(club),
      included_stock_shots: weighted.shots.length,
      sessions: weighted.supportingSessions,
      pure_tagged_shots: weighted.shots.filter((shot) => shot.feltPerfect === true).length,
    })
  })

  return {
    schema_version: 'looper-live-caddie-player-profiles-v1',
    generated_at: new Date().toISOString(),
    source: 'looper-existing-shot-profile-calculations',
    historical_model_now: new Date(nowMs).toISOString(),
    session_count: analysisSessions.length,
    shot_count: analysisSessions.reduce(
      (sum, session) =>
        sum + session.shots.filter(isShotIncludedInAnalysis).length,
      0,
    ),
    clubs: profiles,
    club_support: clubSupport,
  }
}
