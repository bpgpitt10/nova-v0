// DEV ONLY — safe to delete. Do not import into production flow.

import type { ExtractedFrame } from '../adapters/gsproExtractor'

export const simreadMockFrames: ExtractedFrame[] = [
  {
    frame: { timestampMs: 1760000000000, source: 'screenshot' },
    mode: 'practice',
    practice: {
      club: 'Driver',
      statePhase: 'post_shot',
      shotCount: null,
      resolvedShot: {
        club: 'Driver',
        carry: 135.8,
        carrySource: 'gspro',
        hla: -1.9,
        hlaSource: 'gspro',
        peakHeight: 68.6,
        peakHeightSource: 'gspro',
        offline: -12.1,
        offlineSource: 'gspro',
        enrichmentRecommended: false,
      },
      gsproFields: {
        club: 'Driver',
        carryGame: 135.8,
        carryRaw: 135.8,
        offline: -12.1,
        peakHeight: 68.6,
        hla: -1.9,
      },
    },
  },
  {
    frame: { timestampMs: 1760000005000, source: 'screenshot' },
    mode: 'practice',
    practice: {
      club: 'Driver',
      statePhase: 'post_shot',
      shotCount: null,
      resolvedShot: {
        club: 'Driver',
        hla: -0.7,
        hlaSource: 'gspro',
      },
      gsproFields: {
        club: 'Driver',
        carryGame: 128.4,
        offline: -3.2,
        ballSpeed: 96.4,
        hla: -0.7,
      },
    },
  },
  {
    frame: { timestampMs: 1760000010000, source: 'screenshot' },
    mode: 'practice',
    practice: {
      club: '7i',
      statePhase: 'post_shot',
      shotCount: null,
      resolvedShot: {
        club: '7i',
        hla: 1.2,
        hlaSource: 'gspro',
      },
      gsproFields: {
        club: '7i',
        offline: 4.5,
      },
    },
  },
]
