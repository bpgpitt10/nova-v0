import type { GsproReplayFixture } from '../liveCaddie/gsproReplayHarness'

const roundText = ({
  courseKey,
  roundId,
  holeNumber,
  shotId,
  globalShotNumber,
}: {
  courseKey: string
  roundId: number
  holeNumber: number
  shotId: string
  globalShotNumber: number
}) => JSON.stringify({
  shots: [
    {
      ShotID: shotId,
      RoundID: roundId,
      Hole: holeNumber - 1,
      HoleShot: globalShotNumber,
      GlobalShotNumber: globalShotNumber,
      CourseKey: courseKey,
    },
  ],
})

const logText = (holeNumber: number, suffix = '') =>
  `currentHole : ${holeNumber - 1}\n${suffix}`

export const GS_PRO_REPLAY_FIXTURES: GsproReplayFixture[] = [
  {
    schemaVersion: 1,
    name: 'Greywolf baseline + duplicate + reconnect',
    description: 'Covers normal state, duplicate suppression, disconnect, and one shot written while Looper is away.',
    courseHint: 'greywolf_gsp',
    frames: [
      {
        id: 'g1',
        label: 'Initial live shot',
        atMs: 100_000,
        currentRound: {
          text: roundText({ courseKey: 'greywolf_gsp', roundId: 401, holeNumber: 1, shotId: 'gw-1', globalShotNumber: 1 }),
          modifiedAtMs: 99_900,
        },
        outputLog: { text: logText(1), modifiedAtMs: 99_950 },
        expect: {
          roundHole: 1,
          logHole: 1,
          effectiveHole: 1,
          latestShotId: 'gw-1',
          integrity: 'healthy',
          epoch: 1,
          duplicateSuppressed: false,
        },
      },
      {
        id: 'g2',
        label: 'Same shot polled again',
        atMs: 101_000,
        currentRound: {
          text: roundText({ courseKey: 'greywolf_gsp', roundId: 401, holeNumber: 1, shotId: 'gw-1', globalShotNumber: 1 }),
          modifiedAtMs: 99_900,
        },
        outputLog: { text: logText(1), modifiedAtMs: 99_950 },
        expect: {
          effectiveHole: 1,
          duplicateSuppressed: true,
          recoveredMissedShot: false,
        },
      },
      {
        id: 'g3',
        label: 'Looper disconnects',
        atMs: 102_000,
        connection: 'disconnected',
        currentRound: {
          text: roundText({ courseKey: 'greywolf_gsp', roundId: 401, holeNumber: 1, shotId: 'gw-1', globalShotNumber: 1 }),
          modifiedAtMs: 99_900,
        },
        outputLog: { text: logText(1), modifiedAtMs: 99_950 },
      },
      {
        id: 'g4',
        label: 'Reconnect after a new shot was written',
        atMs: 106_000,
        connection: 'reconnected',
        currentRound: {
          text: roundText({ courseKey: 'greywolf_gsp', roundId: 401, holeNumber: 1, shotId: 'gw-2', globalShotNumber: 2 }),
          modifiedAtMs: 105_800,
        },
        outputLog: { text: logText(1), modifiedAtMs: 105_850 },
        expect: {
          latestShotId: 'gw-2',
          effectiveHole: 1,
          recoveredMissedShot: true,
          duplicateSuppressed: false,
          integrity: 'healthy',
        },
      },
    ],
  },
  {
    schemaVersion: 1,
    name: 'Future course + temporary log loss',
    description: 'Proves the harness is course-key agnostic and bounds output_log fallback to five seconds.',
    courseHint: 'tobacco_road_gsp',
    frames: [
      {
        id: 'f1',
        label: 'Future course healthy state',
        atMs: 200_000,
        currentRound: {
          text: roundText({ courseKey: 'tobacco_road_gsp', roundId: 77, holeNumber: 6, shotId: 'tr-1', globalShotNumber: 18 }),
          modifiedAtMs: 199_850,
        },
        outputLog: { text: logText(6), modifiedAtMs: 199_900 },
        expect: {
          roundHole: 6,
          logHole: 6,
          effectiveHole: 6,
          integrity: 'healthy',
        },
      },
      {
        id: 'f2',
        label: 'output_log temporarily missing',
        atMs: 203_000,
        currentRound: {
          text: roundText({ courseKey: 'tobacco_road_gsp', roundId: 77, holeNumber: 6, shotId: 'tr-1', globalShotNumber: 18 }),
          modifiedAtMs: 199_850,
        },
        outputLog: { text: null, modifiedAtMs: null },
        expect: {
          effectiveHole: 6,
          integrity: 'healthy',
        },
      },
      {
        id: 'f3',
        label: 'output_log missing beyond grace window',
        atMs: 207_000,
        currentRound: {
          text: roundText({ courseKey: 'tobacco_road_gsp', roundId: 77, holeNumber: 6, shotId: 'tr-1', globalShotNumber: 18 }),
          modifiedAtMs: 199_850,
        },
        outputLog: { text: null, modifiedAtMs: null },
        expect: {
          effectiveHole: 6,
          integrity: 'degraded',
        },
      },
    ],
  },
  {
    schemaVersion: 1,
    name: 'GSPro restart quarantine',
    description: 'Old currentRound state is suppressed after a log reset until fresh round state appears.',
    courseHint: 'any-course',
    frames: [
      {
        id: 'r1',
        label: 'Prior round on Hole 18',
        atMs: 300_000,
        currentRound: {
          text: roundText({ courseKey: 'sample_course_gsp', roundId: 10, holeNumber: 18, shotId: 'old-18', globalShotNumber: 72 }),
          modifiedAtMs: 299_700,
        },
        outputLog: {
          text: `${logText(18)}\n${'x'.repeat(200)}`,
          modifiedAtMs: 299_800,
        },
        expect: { effectiveHole: 18, integrity: 'healthy', epoch: 1 },
      },
      {
        id: 'r2',
        label: 'GSPro recreates/truncates output_log',
        atMs: 301_000,
        currentRound: {
          text: roundText({ courseKey: 'sample_course_gsp', roundId: 10, holeNumber: 18, shotId: 'old-18', globalShotNumber: 72 }),
          modifiedAtMs: 299_700,
        },
        outputLog: { text: '', modifiedAtMs: 300_950, sizeBytes: 0 },
        expect: {
          effectiveHole: null,
          integrity: 'stale',
          epoch: 2,
        },
      },
      {
        id: 'r3',
        label: 'Fresh new round arrives',
        atMs: 302_000,
        currentRound: {
          text: roundText({ courseKey: 'sample_course_gsp', roundId: 11, holeNumber: 1, shotId: 'new-1', globalShotNumber: 1 }),
          modifiedAtMs: 301_900,
        },
        outputLog: { text: logText(1), modifiedAtMs: 301_950 },
        expect: {
          roundHole: 1,
          logHole: 1,
          effectiveHole: 1,
          integrity: 'healthy',
          epoch: 3,
        },
      },
    ],
  },
  {
    schemaVersion: 1,
    name: 'Partial currentRound write',
    description: 'A malformed/partial JSON write must surface as stale rather than becoming trusted live state.',
    frames: [
      {
        id: 'p1',
        label: 'Partial JSON',
        atMs: 400_000,
        currentRound: { text: '{"shots":[{"ShotID":"partial"', modifiedAtMs: 399_950 },
        outputLog: { text: logText(4), modifiedAtMs: 399_960 },
        expect: {
          roundState: 'invalid',
          roundHole: null,
          effectiveHole: 4,
          integrity: 'stale',
        },
      },
    ],
  },
]

export const GS_PRO_REPLAY_FIXTURE_JSON_EXAMPLE = JSON.stringify({
  schemaVersion: 1,
  name: 'Imported course capture',
  courseHint: 'future_course_gsp',
  frames: [
    {
      id: 'frame-1',
      label: 'First captured state',
      atMs: 1000,
      connection: 'connected',
      currentRound: {
        text: roundText({ courseKey: 'future_course_gsp', roundId: 1, holeNumber: 1, shotId: 'shot-1', globalShotNumber: 1 }),
        modifiedAtMs: 950,
      },
      outputLog: {
        text: logText(1),
        modifiedAtMs: 975,
      },
      expect: {
        effectiveHole: 1,
        integrity: 'healthy',
      },
    },
  ],
}, null, 2)
