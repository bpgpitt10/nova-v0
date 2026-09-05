import {
  includedClubShotsForSession,
  isShotIncludedInAnalysis,
  isSystemOldExcludedSession,
  sessionHistoricalWeightForClub,
} from '../../lib/historicalModel'
import type { SavedSession } from '../../types'
import type {
  IntelligenceAnalysisDataset,
  IntelligenceSession,
  IntelligenceShot,
  PatternStabilityInput,
} from '../input'

const validTimestampOrFallback = (
  capturedAt: string | undefined,
  fallbackEndedAt: string | undefined,
) => {
  if (capturedAt && Number.isFinite(new Date(capturedAt).getTime())) {
    return capturedAt
  }
  if (fallbackEndedAt && Number.isFinite(new Date(fallbackEndedAt).getTime())) {
    return fallbackEndedAt
  }
  return null
}

/**
 * Converts today's SavedSession persistence shape into a storage-agnostic dataset.
 *
 * Important: analysisWeight intentionally reproduces the weighting currently used by
 * summarizeReviewClub on saved history. This is an adapter for parity, not a new
 * weighting policy.
 */
export const buildLegacySavedHistoryDataset = (
  savedSessions: readonly SavedSession[],
  asOfMs = Date.now(),
): IntelligenceAnalysisDataset => {
  const eligibleSessions = savedSessions.filter(
    (session) => !isSystemOldExcludedSession(session, asOfMs),
  )

  const sessions: IntelligenceSession[] = savedSessions.map((session) => ({
    id: session.id,
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    includedInAnalysis: session.metadata?.includeInAnalysis !== false,
  }))

  const shots: IntelligenceShot[] = []

  eligibleSessions.forEach((session) => {
    const clubsInSession = new Set(session.shots.map((shot) => shot.club))
    const sessionWeightByClub = new Map(
      [...clubsInSession].map((club) => [
        club,
        sessionHistoricalWeightForClub(session, club, asOfMs),
      ]),
    )
    const includedCountByClub = new Map(
      [...clubsInSession].map((club) => [
        club,
        includedClubShotsForSession(session, club).length,
      ]),
    )

    session.shots.forEach((shot) => {
      const included = isShotIncludedInAnalysis(shot)
      const sessionWeight = sessionWeightByClub.get(shot.club) ?? 0
      const includedCount = includedCountByClub.get(shot.club) ?? 0
      const analysisWeight =
        included && sessionWeight > 0 && includedCount > 0
          ? sessionWeight / includedCount
          : 0

      shots.push({
        id: shot.id,
        clubId: shot.club,
        included,
        capturedAt: validTimestampOrFallback(shot.capturedAt, session.endedAt),
        sessionId: session.id,
        analysisWeight,
        carryYards:
          typeof shot.carryYards === 'number' && Number.isFinite(shot.carryYards)
            ? shot.carryYards
            : null,
        totalYards:
          typeof shot.totalYards === 'number' && Number.isFinite(shot.totalYards)
            ? shot.totalYards
            : null,
        offlineYards:
          typeof shot.offlineYards === 'number' && Number.isFinite(shot.offlineYards)
            ? shot.offlineYards
            : null,
        ballSpeedMph:
          typeof shot.ballSpeedMph === 'number' && Number.isFinite(shot.ballSpeedMph)
            ? shot.ballSpeedMph
            : null,
        verticalLaunchAngleDegrees:
          typeof shot.verticalLaunchAngleDegrees === 'number' &&
          Number.isFinite(shot.verticalLaunchAngleDegrees)
            ? shot.verticalLaunchAngleDegrees
            : null,
        horizontalLaunchAngleDegrees:
          typeof shot.horizontalLaunchAngleDegrees === 'number' &&
          Number.isFinite(shot.horizontalLaunchAngleDegrees)
            ? shot.horizontalLaunchAngleDegrees
            : null,
        totalSpinRpm:
          typeof shot.totalSpinRpm === 'number' && Number.isFinite(shot.totalSpinRpm)
            ? shot.totalSpinRpm
            : null,
        spinAxisDegrees:
          typeof shot.spinAxisDegrees === 'number' && Number.isFinite(shot.spinAxisDegrees)
            ? shot.spinAxisDegrees
            : null,
      })
    })
  })

  return {
    asOf: new Date(asOfMs).toISOString(),
    shots,
    sessions,
  }
}

export const patternStabilityInputFromDataset = (
  dataset: IntelligenceAnalysisDataset,
  clubId: string,
): PatternStabilityInput => ({
  clubId,
  shots: dataset.shots.filter((shot) => shot.clubId === clubId),
})
