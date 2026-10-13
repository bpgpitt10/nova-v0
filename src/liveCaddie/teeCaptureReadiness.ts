/**
 * A real Looper round ID, not only the GSPro RoundID, must identify the
 * one-shot native calibration attempt. During a new/manual round the GSPro
 * file can still contain yesterday's RoundID or no RoundID at all.
 */
export const firstTeeCaptureKey = (
  looperRoundId: string | null,
  courseId: string,
  holeNumber: number,
): string => JSON.stringify([looperRoundId ?? 'unarmed', courseId, holeNumber])

export type TeeCaptureStatus = 'capturing' | 'complete' | 'failed'
export type TeeCaptureProgress = Readonly<{
  key: string
  status: TeeCaptureStatus
  note?: string
}>

export const shouldHoldUnmatchedTeeRecommendation = (input: {
  matchesCurrentHole: boolean
  nextShotNumber: number | null
  teePlacement: string | null | undefined
  calibrated: boolean
  fallbackApproved: boolean
}): boolean =>
  input.matchesCurrentHole
  && input.nextShotNumber === 1
  && input.teePlacement === 'provisional'
  && !input.calibrated
  && !input.fallbackApproved

export const captureStatusForKey = (
  state: TeeCaptureProgress | null,
  key: string,
): TeeCaptureStatus | 'not-started' =>
  state?.key === key ? state.status : 'not-started'

/**
 * Opening Live Caddie can replay Start Round during bootstrap. Only a genuinely
 * different Looper round is a new test requiring calibration reset.
 */
export const isNewLooperRoundForCapture = (
  previousRoundId: string | null,
  nextRoundId: string | null | undefined,
): boolean => Boolean(nextRoundId && previousRoundId !== nextRoundId)
