import {
  buildLegacySavedHistoryDataset,
  patternStabilityInputFromDataset,
} from '../adapters/legacySavedHistory'
import type { LegacyLooperFixtureV1 } from '../fixtures/legacyLooperFixture'
import { calculatePatternStabilityLegacyV1 } from '../models/patternStability/legacyV1'

export type PatternStabilityParityRow = {
  clubId: string
  legacyValue: number | null
  shadowValue: number | null
  matches: boolean
  explanation: string
}

export type PatternStabilityParityReport = {
  modelId: 'performance.pattern_stability'
  modelVersion: 'legacy-v1'
  fixtureCapturedAt: string
  allMatch: boolean
  rows: readonly PatternStabilityParityRow[]
}

export const comparePatternStabilityFixture = (
  fixture: LegacyLooperFixtureV1,
): PatternStabilityParityReport => {
  const asOfMs = new Date(fixture.capturedAt).getTime()
  const dataset = buildLegacySavedHistoryDataset(
    fixture.savedSessions,
    Number.isFinite(asOfMs) ? asOfMs : Date.now(),
  )

  const rows = Object.entries(fixture.expectedSavedHistoryReviewByClub).map(
    ([clubId, expectation]) => {
      const legacyValue = expectation?.componentScores.patternStability ?? null
      const shadowResult = calculatePatternStabilityLegacyV1(
        patternStabilityInputFromDataset(dataset, clubId),
      )
      const shadowValue = shadowResult.value

      return {
        clubId,
        legacyValue,
        shadowValue,
        matches: legacyValue === shadowValue,
        explanation: shadowResult.explanation,
      }
    },
  )

  return {
    modelId: 'performance.pattern_stability',
    modelVersion: 'legacy-v1',
    fixtureCapturedAt: fixture.capturedAt,
    allMatch: rows.every((row) => row.matches),
    rows,
  }
}
