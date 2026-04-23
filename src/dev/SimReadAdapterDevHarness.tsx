// DEV ONLY — safe to delete. Do not import into production flow.

import { mapGsproExtractedFrameToShot } from '../adapters/gsproExtractor'
import type { Club } from '../types'
import { simreadMockFrames } from './simreadMockFrames'

const harnessClub: Club = 'Driver'

export function SimReadAdapterDevHarness() {
  const mappedShots = simreadMockFrames.map((frame, index) => ({
    index,
    mappedShot: mapGsproExtractedFrameToShot(frame, { club: harnessClub }),
  }))

  return (
    <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>SimRead Adapter Dev Harness</h1>
      <pre style={{ whiteSpace: 'pre-wrap' }}>
        {JSON.stringify(mappedShots, null, 2)}
      </pre>
    </main>
  )
}
