import { activeBagClubIds, type Club } from '../../lib/bagConfig'
import { summarizeReviewClub } from '../../lib/scoring'
import type { ActiveSessionDraft, ReviewClubSummary, SavedSession } from '../../types'

export type LegacyReviewExpectation = Pick<
  ReviewClubSummary,
  'includedShots' | 'caddieScore' | 'caddieCall' | 'componentScores'
>

export type LegacyLooperFixtureV1 = {
  fixtureSchema: 'looper-legacy-fixture-v1'
  capturedAt: string
  source: {
    application: 'looper-web'
    baselineBranch: 'web-gspro-clean'
    storage: 'browser-local-storage'
  }
  savedSessions: SavedSession[]
  activeSessionDraft: ActiveSessionDraft | null
  expectedSavedHistoryReviewByClub: Partial<Record<Club, LegacyReviewExpectation>>
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * Captures both the full current persistence objects and today's legacy review outputs.
 * Expected outputs are intentionally calculated from saved history only (activeSessionId=null)
 * so the fixture remains stable and repeatable after capture.
 */
export const buildLegacyLooperFixture = (
  savedSessions: readonly SavedSession[],
  activeSessionDraft: ActiveSessionDraft | null = null,
): LegacyLooperFixtureV1 => {
  const capturedAt = new Date().toISOString()
  const savedSessionCopies = cloneJson([...savedSessions])
  const activeSessionCopy = activeSessionDraft ? cloneJson(activeSessionDraft) : null
  const allSavedShots = savedSessionCopies.flatMap((session) => session.shots)

  const expectedSavedHistoryReviewByClub = activeBagClubIds.reduce<
    Partial<Record<Club, LegacyReviewExpectation>>
  >((expectations, club) => {
    const summary = summarizeReviewClub(
      club,
      allSavedShots,
      savedSessionCopies,
      null,
    )
    if (!summary) {
      return expectations
    }

    expectations[club] = {
      includedShots: summary.includedShots,
      caddieScore: summary.caddieScore,
      caddieCall: summary.caddieCall,
      componentScores: { ...summary.componentScores },
    }
    return expectations
  }, {})

  return {
    fixtureSchema: 'looper-legacy-fixture-v1',
    capturedAt,
    source: {
      application: 'looper-web',
      baselineBranch: 'web-gspro-clean',
      storage: 'browser-local-storage',
    },
    savedSessions: savedSessionCopies,
    activeSessionDraft: activeSessionCopy,
    expectedSavedHistoryReviewByClub,
  }
}

export const serializeLegacyLooperFixture = (fixture: LegacyLooperFixtureV1) =>
  JSON.stringify(fixture, null, 2)
