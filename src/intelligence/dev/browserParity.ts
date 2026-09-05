import {
  loadActiveSessionDraft,
  loadSavedSessions,
} from '../../lib/sessions'
import {
  buildLegacyLooperFixture,
  serializeLegacyLooperFixture,
} from '../fixtures/legacyLooperFixture'
import { comparePerformanceProfileFixture } from '../parity/performanceProfileParity'
import { comparePatternStabilityFixture } from '../parity/patternStabilityParity'

const downloadJson = (filename: string, content: string) => {
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

const dateStamp = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const buildCurrentBrowserLegacyFixture = () =>
  buildLegacyLooperFixture(loadSavedSessions(), loadActiveSessionDraft())

export const downloadCurrentBrowserLegacyFixture = () => {
  const fixture = buildCurrentBrowserLegacyFixture()
  const filename = `looper-intelligence-fixture-${dateStamp(new Date())}.json`
  downloadJson(filename, serializeLegacyLooperFixture(fixture))
  return fixture
}

export const runCurrentBrowserPatternStabilityParity = () => {
  const fixture = buildCurrentBrowserLegacyFixture()
  const report = comparePatternStabilityFixture(fixture)
  console.table(report.rows)
  return { fixture, report }
}

export const runCurrentBrowserPerformanceProfileParity = () => {
  const fixture = buildCurrentBrowserLegacyFixture()
  const report = comparePerformanceProfileFixture(fixture)
  console.table(
    report.rows.map((row) => ({
      club: row.clubId,
      included: row.includedShots.matches,
      distance: row.distanceWindow.matches,
      direction: row.directionWindow.matches,
      flight: row.flightQuality.matches,
      pattern: row.patternStability.matches,
      data: row.dataConfidence.matches,
      aggregate: row.aggregateScore.matches,
      call: row.caddieCall.matches,
      all: row.allMatch,
    })),
  )
  return { fixture, report }
}
