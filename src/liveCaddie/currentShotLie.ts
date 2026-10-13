export type ManualLieSurface = 'rough' | 'deep-rough' | 'sand' | 'fairway'
export type ManualLieSelection = Readonly<{ shotKey: string; surface: ManualLieSurface }>

export const activeManualLieSurface = (
  currentShotKey: string,
  saved: ManualLieSelection | null,
): ManualLieSurface | null =>
  saved?.shotKey === currentShotKey ? saved.surface : null

/**
 * Surface selection is per physical shot, not sticky round- or hole-wide.
 * This lets a golfer use the actual GSPro HUD (e.g. "Deep Rough") while
 * we lack a validated numeric code or live lie-label OCR.
 */
export const liveShotLieKey = (
  courseId: string,
  holeNumber: number,
  roundId: number | null,
  shotNumber: number | null,
  latestShotKey: string | null,
): string => JSON.stringify([courseId, holeNumber, roundId, shotNumber, latestShotKey])
