import type { SavedSession } from '../types'

// One-time personal migration from the pre-EML history to the EML baseline.
// This is intentionally not a product-facing launch-monitor migration feature.
export const EML_CALIBRATION_CUTOVER_ISO = '2026-09-10T00:00:00.000Z'
export const EML_CALIBRATION_MIN_SHOTS_PER_CLUB = 8

let installedExcludedPreEmlShotIds = new Set<string>()

const sessionTime = (session: SavedSession) => {
  const endedAt = new Date(session.endedAt).getTime()
  if (Number.isFinite(endedAt)) {
    return endedAt
  }
  const startedAt = new Date(session.startedAt).getTime()
  return Number.isFinite(startedAt) ? startedAt : 0
}

const isMockSession = (session: SavedSession) =>
  session.metadata?.feedMode === 'mock' ||
  (session.shots.length > 0 && session.shots.every((shot) => shot.source === 'mock'))

export const buildExcludedPreEmlShotIds = (
  sessions: SavedSession[],
  minShotsPerClub = EML_CALIBRATION_MIN_SHOTS_PER_CLUB,
) => {
  const cutoverMs = new Date(EML_CALIBRATION_CUTOVER_ISO).getTime()
  const currentShotCounts = new Map<string, number>()

  sessions.forEach((session) => {
    if (isMockSession(session) || sessionTime(session) < cutoverMs) {
      return
    }

    session.shots.forEach((shot) => {
      if (!shot.included) {
        return
      }
      currentShotCounts.set(shot.club, (currentShotCounts.get(shot.club) ?? 0) + 1)
    })
  })

  const calibratedClubs = new Set(
    [...currentShotCounts.entries()]
      .filter(([, count]) => count >= minShotsPerClub)
      .map(([club]) => club),
  )

  const excludedShotIds = new Set<string>()
  if (calibratedClubs.size === 0) {
    return excludedShotIds
  }

  sessions.forEach((session) => {
    if (sessionTime(session) >= cutoverMs) {
      return
    }

    session.shots.forEach((shot) => {
      if (calibratedClubs.has(shot.club)) {
        excludedShotIds.add(shot.id)
      }
    })
  })

  return excludedShotIds
}

export const installPersonalEmlCalibrationState = (sessions: SavedSession[]) => {
  installedExcludedPreEmlShotIds = buildExcludedPreEmlShotIds(sessions)
  return installedExcludedPreEmlShotIds
}

/**
 * Applies the one-time migration to the working session copy. The old shots are
 * not deleted; they remain in history but are marked out of analysis once the
 * same club has 8 post-cutover EML shots. This makes every existing Stock/Pure
 * code path respect the cutover without teaching the app a permanent migration
 * feature.
 */
export const applyPersonalEmlCalibration = (sessions: SavedSession[]) => {
  const excludedShotIds = installPersonalEmlCalibrationState(sessions)
  if (excludedShotIds.size === 0) {
    return sessions
  }

  return sessions.map((session) => ({
    ...session,
    shots: session.shots.map((shot) =>
      excludedShotIds.has(shot.id) && shot.included
        ? { ...shot, included: false }
        : shot,
    ),
  }))
}

export const isShotPersonalEmlCalibrationEligible = (shotId: string) =>
  !installedExcludedPreEmlShotIds.has(shotId)
