/**
 * Schedule exactly one fresh native wind/lie observation per *canonical*
 * physical shot, not per React render or periodic GSPro folder check.
 *
 * Hole 1 Shot 1 is handled by the separate provisional-tee capture.
 * Every subsequent physical shot (and later-hole first tee) needs new HUD
 * observations after the browser detects the new GSPro shot state.
 *
 * The snapshot shot key is required for post-tee measurements: a stale
 * previous-round file must not drive a fresh current shot capture.
 */
export type ShotHudCaptureIdentity = Readonly<{
  captureRoundId: string | null
  courseId: string
  selectedHoleNumber: number
  snapshotHoleNumber: number | null
  nextShotNumber: number | null
  latestShotKey: string | null
  teePlacement: string | null | undefined
}>

export const shotHudCaptureKey = ({
  captureRoundId, courseId, selectedHoleNumber, snapshotHoleNumber,
  nextShotNumber, latestShotKey, teePlacement,
}: ShotHudCaptureIdentity): string | null => {
  if (!courseId || courseId === '__no-course-selected__'
    || !Number.isInteger(selectedHoleNumber)
    || selectedHoleNumber < 1 || selectedHoleNumber > 18
    || snapshotHoleNumber !== selectedHoleNumber
    || !Number.isInteger(nextShotNumber)
    || nextShotNumber == null || nextShotNumber < 1
    || nextShotNumber > 30) return null

  // Existing separate native tee calibration publishes wind/lie on Hole 1
  // Shot 1. Do not start competing reads on that initial gated screen.
  if (selectedHoleNumber === 1 && nextShotNumber === 1
    && teePlacement === 'provisional') return null

  // Subsequent shots must have witnessed an actual canonical GSPro shot.
  if (!latestShotKey) return null

  return JSON.stringify([
    captureRoundId ?? 'no-looper-round', courseId,
    selectedHoleNumber, nextShotNumber, latestShotKey,
  ])
}
