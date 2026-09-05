import {
  buildLegacySavedHistoryDataset,
  performanceDriverInputFromDataset,
} from '../adapters/legacySavedHistory'
import type { LegacyLooperFixtureV1 } from '../fixtures/legacyLooperFixture'
import { calculateLegacyPerformanceProfile } from '../models/performanceProfile/legacyV1'

type NullableNumber = number | null

export type PerformanceProfileParityRow = {
  clubId: string
  includedShots: { legacy: number; shadow: number; matches: boolean }
  distanceWindow: { legacy: number; shadow: number; matches: boolean }
  directionWindow: { legacy: number; shadow: number; matches: boolean }
  flightQuality: { legacy: NullableNumber; shadow: NullableNumber; matches: boolean }
  patternStability: { legacy: NullableNumber; shadow: NullableNumber; matches: boolean }
  dataConfidence: { legacy: number; shadow: number; matches: boolean }
  aggregateScore: { legacy: number; shadow: number; matches: boolean }
  caddieCall: { legacy: string; shadow: string; matches: boolean }
  allMatch: boolean
}

export type PerformanceProfileParityReport = {
  profileVersion: 'legacy-v1'
  fixtureCapturedAt: string
  analysisPolicyId: string
  allMatch: boolean
  rows: readonly PerformanceProfileParityRow[]
}

const sameNumber = (left: NullableNumber, right: NullableNumber) => {
  if (left === null || right === null) return left === right
  return Math.abs(left - right) <= 1e-9
}

export const comparePerformanceProfileFixture = (
  fixture: LegacyLooperFixtureV1,
): PerformanceProfileParityReport => {
  const asOfMs = new Date(fixture.capturedAt).getTime()
  const dataset = buildLegacySavedHistoryDataset(
    fixture.savedSessions,
    Number.isFinite(asOfMs) ? asOfMs : Date.now(),
  )

  const rows = Object.entries(fixture.expectedSavedHistoryReviewByClub).flatMap(
    ([clubId, expectation]) => {
      if (!expectation) return []

      const shadow = calculateLegacyPerformanceProfile(
        performanceDriverInputFromDataset(dataset, clubId),
      )

      const row: PerformanceProfileParityRow = {
        clubId,
        includedShots: {
          legacy: expectation.includedShots,
          shadow: shadow.includedShotCount,
          matches: expectation.includedShots === shadow.includedShotCount,
        },
        distanceWindow: {
          legacy: expectation.componentScores.distanceWindow,
          shadow: shadow.drivers.distanceWindow.value,
          matches: sameNumber(expectation.componentScores.distanceWindow, shadow.drivers.distanceWindow.value),
        },
        directionWindow: {
          legacy: expectation.componentScores.directionWindow,
          shadow: shadow.drivers.directionWindow.value,
          matches: sameNumber(expectation.componentScores.directionWindow, shadow.drivers.directionWindow.value),
        },
        flightQuality: {
          legacy: expectation.componentScores.flightQuality,
          shadow: shadow.drivers.flightQuality.value,
          matches: sameNumber(expectation.componentScores.flightQuality, shadow.drivers.flightQuality.value),
        },
        patternStability: {
          legacy: expectation.componentScores.patternStability,
          shadow: shadow.drivers.patternStability.value,
          matches: sameNumber(expectation.componentScores.patternStability, shadow.drivers.patternStability.value),
        },
        dataConfidence: {
          legacy: expectation.componentScores.dataConfidence,
          shadow: shadow.drivers.dataConfidence.value,
          matches: sameNumber(expectation.componentScores.dataConfidence, shadow.drivers.dataConfidence.value),
        },
        aggregateScore: {
          legacy: expectation.caddieScore,
          shadow: shadow.clubConfidence.value.score,
          matches: expectation.caddieScore === shadow.clubConfidence.value.score,
        },
        caddieCall: {
          legacy: expectation.caddieCall,
          shadow: shadow.clubConfidence.value.call,
          matches: expectation.caddieCall === shadow.clubConfidence.value.call,
        },
        allMatch: false,
      }

      row.allMatch = [
        row.includedShots.matches,
        row.distanceWindow.matches,
        row.directionWindow.matches,
        row.flightQuality.matches,
        row.patternStability.matches,
        row.dataConfidence.matches,
        row.aggregateScore.matches,
        row.caddieCall.matches,
      ].every(Boolean)

      return [row]
    },
  )

  return {
    profileVersion: 'legacy-v1',
    fixtureCapturedAt: fixture.capturedAt,
    analysisPolicyId: dataset.analysisPolicyId,
    allMatch: rows.every((row) => row.allMatch),
    rows,
  }
}
