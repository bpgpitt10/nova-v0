import { useEffect, useMemo, useState } from 'react'
import { activeBagClubIds, getClubLabel, type Club } from '../lib/bagConfig'
import { formatShotRank, normalizeShotRank } from '../lib/shotRank'
import {
  clearActiveSessionDraft,
  isSessionIncludedInAnalysis,
  isSessionOldExcludedBySystem,
  loadActiveSessionDraft,
  loadSavedSessions,
  saveSessionHistory,
} from '../lib/sessions'
import type { OpenGolfCoachPayload, SavedSession, Shot } from '../types'
import './DataManagementPage.css'

const formatDecimal = (value: number | undefined, unit = '') => {
  if (typeof value !== 'number') {
    return '-'
  }
  return `${value.toFixed(1)}${unit}`
}

const formatWhole = (value: number | undefined, unit = '') => {
  if (typeof value !== 'number') {
    return '-'
  }
  return `${Math.round(value)}${unit}`
}

const formatRank = (value: number | string | undefined) => formatShotRank(value)

const averageNumbers = (values: Array<number | undefined>) => {
  const defined = values.filter((value): value is number => typeof value === 'number')
  if (defined.length === 0) {
    return undefined
  }
  return defined.reduce((sum, value) => sum + value, 0) / defined.length
}

const payloadNumber = (payload: OpenGolfCoachPayload | undefined, keys: string[]) => {
  if (!payload) {
    return undefined
  }

  const parseNumberLike = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
    return undefined
  }

  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null

  const root = asRecord(payload)
  if (!root) {
    return undefined
  }

  const visited = new Set<Record<string, unknown>>()
  const stack: Record<string, unknown>[] = [root]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || visited.has(current)) {
      continue
    }
    visited.add(current)

    for (const key of keys) {
      const parsed = parseNumberLike(current[key])
      if (typeof parsed === 'number') {
        return parsed
      }
    }

    Object.values(current).forEach((value) => {
      const nested = asRecord(value)
      if (nested && !visited.has(nested)) {
        stack.push(nested)
      }
    })
  }

  return undefined
}

const carryValue = (shot: Shot) =>
  typeof shot.carryYards === 'number'
    ? shot.carryYards
    : payloadNumber(shot.openGolfCoach, ['carry_distance_yards', 'carryDistanceYards', 'carry'])

const totalValue = (shot: Shot) =>
  typeof shot.totalYards === 'number'
    ? shot.totalYards
    : payloadNumber(shot.openGolfCoach, ['total_distance_yards', 'totalDistanceYards', 'total'])

const offlineValue = (shot: Shot) =>
  typeof shot.offlineYards === 'number'
    ? shot.offlineYards
    : payloadNumber(shot.openGolfCoach, [
        'offline_distance_yards',
        'offlineDistanceYards',
        'offline',
      ])

const launchValue = (shot: Shot) =>
  typeof shot.verticalLaunchAngleDegrees === 'number'
    ? shot.verticalLaunchAngleDegrees
    : typeof shot.launchAngleDeg === 'number'
      ? shot.launchAngleDeg
      : payloadNumber(shot.openGolfCoach, [
          'vertical_launch_angle_degrees',
          'verticalLaunchAngleDegrees',
          'launch_angle_degrees',
          'launchAngleDeg',
        ])

const spinValue = (shot: Shot) =>
  typeof shot.totalSpinRpm === 'number'
    ? shot.totalSpinRpm
    : typeof shot.spinRpm === 'number'
      ? shot.spinRpm
      : payloadNumber(shot.openGolfCoach, ['backspin_rpm', 'total_spin_rpm', 'totalSpinRpm'])

const smashFactorValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, ['smash_factor', 'smashFactor'])

const clubPathValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, ['club_path_degrees', 'clubPathDegrees'])

const faceToPathValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, [
    'club_face_to_path_degrees',
    'clubFaceToPathDegrees',
  ])

const faceToTargetValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, [
    'club_face_to_target_degrees',
    'clubFaceToTargetDegrees',
  ])

const clubSpeedValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, ['club_speed_mph', 'clubSpeedMph'])

const ballSpeedMphValue = (shot: Shot) =>
  typeof shot.ballSpeedMph === 'number'
    ? shot.ballSpeedMph
    : payloadNumber(shot.openGolfCoach, ['ball_speed_mph', 'ballSpeedMph'])

const peakHeightValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, ['peak_height_yards', 'peakHeightYards'])

const descentValue = (shot: Shot) =>
  payloadNumber(shot.openGolfCoach, [
    'descent_angle_degrees',
    'descent_angle_deg',
    'descentAngleDegrees',
  ])

const sessionClubSummary = (session: SavedSession) => {
  const counts = new Map<Club, number>()
  session.shots.forEach((shot) => {
    counts.set(shot.club, (counts.get(shot.club) ?? 0) + 1)
  })

  return activeBagClubIds
    .filter((club) => counts.has(club))
    .map((club) => `${getClubLabel(club)} (${counts.get(club)})`)
    .join(', ')
}

const sessionShotGroups = (session: SavedSession) => {
  const byClub = new Map<Club, Shot[]>()
  session.shots.forEach((shot) => {
    byClub.set(shot.club, [...(byClub.get(shot.club) ?? []), shot])
  })

  return activeBagClubIds
    .filter((club) => byClub.has(club))
    .map((club) => {
      const clubShots = byClub.get(club) ?? []
      const included = clubShots.filter((shot) => shot.included)
      const rankCounts = new Map<string, number>()
      included.forEach((shot) => {
        if (typeof shot.shotRanking === 'undefined') {
          return
        }
        const rank = normalizeShotRank(shot.shotRanking) ?? String(shot.shotRanking)
        rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1)
      })

      const includedRankSummary =
        rankCounts.size > 0
          ? [...rankCounts.entries()].sort((left, right) => right[1] - left[1])[0][0]
          : '-'

      return {
        club,
        shots: clubShots,
        includedRankSummary,
        averages: {
          carry: averageNumbers(included.map(carryValue)),
          total: averageNumbers(included.map(totalValue)),
          offline: averageNumbers(included.map(offlineValue)),
          spin: averageNumbers(included.map(spinValue)),
          launch: averageNumbers(included.map(launchValue)),
          hla: averageNumbers(included.map((shot) => shot.horizontalLaunchAngleDegrees)),
          spinAxis: averageNumbers(included.map((shot) => shot.spinAxisDegrees)),
          smash: averageNumbers(included.map(smashFactorValue)),
          path: averageNumbers(included.map(clubPathValue)),
          facePath: averageNumbers(included.map(faceToPathValue)),
          faceTarget: averageNumbers(included.map(faceToTargetValue)),
          clubSpeed: averageNumbers(included.map(clubSpeedValue)),
          ballSpeed: averageNumbers(included.map(ballSpeedMphValue)),
          peak: averageNumbers(included.map(peakHeightValue)),
          descent: averageNumbers(included.map(descentValue)),
        },
      }
    })
}

const isMockSession = (session: SavedSession) =>
  session.metadata?.feedMode === 'mock' ||
  (!session.metadata?.feedMode &&
    session.shots.length > 0 &&
    session.shots.every((shot) => shot.source === 'mock'))

function DataManagementPage() {
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>(() => loadSavedSessions())
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set())
  const [allExpanded, setAllExpanded] = useState(false)
  const showDevMockControls =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('devMock') === '1'

  const sortedSessions = useMemo(
    () =>
      [...savedSessions].sort(
        (left, right) =>
          new Date(right.endedAt).getTime() - new Date(left.endedAt).getTime(),
      ),
    [savedSessions],
  )
  const nowMs = Date.now()
  const isSessionSelected = (session: SavedSession) =>
    !isSessionOldExcludedBySystem(session, nowMs) &&
    isSessionIncludedInAnalysis(session) &&
    (session.shots.length === 0 || session.shots.every((shot) => shot.included))
  const allSessionsIncluded =
    sortedSessions.filter((session) => !isSessionOldExcludedBySystem(session, nowMs)).length > 0 &&
    sortedSessions
      .filter((session) => !isSessionOldExcludedBySystem(session, nowMs))
      .every(isSessionSelected)
  const selectedSessionIds = useMemo(
    () => sortedSessions.filter(isSessionSelected).map((session) => session.id),
    [sortedSessions],
  )
  const selectedShotCount = useMemo(
    () =>
      sortedSessions.reduce((count, session) => {
        if (isSessionOldExcludedBySystem(session, nowMs)) {
          return count
        }
        return count + session.shots.filter((shot) => shot.included).length
      }, 0),
    [nowMs, sortedSessions],
  )
  const hasAnySelectedItems = selectedSessionIds.length > 0 || selectedShotCount > 0

  const persistSessions = (sessions: SavedSession[]) => {
    setSavedSessions(sessions)
    saveSessionHistory(sessions)
  }

  useEffect(() => {
    if (sortedSessions.length === 0) {
      if (allExpanded) {
        setAllExpanded(false)
      }
      return
    }

    const expandedCount = sortedSessions.filter((session) =>
      expandedSessionIds.has(session.id),
    ).length
    const nextAllExpanded = expandedCount === sortedSessions.length
    if (nextAllExpanded !== allExpanded) {
      setAllExpanded(nextAllExpanded)
    }
  }, [allExpanded, expandedSessionIds, sortedSessions])

  const setAllSessionsIncluded = (included: boolean) => {
    persistSessions(
      savedSessions.map((session) => ({
        ...session,
        shots: session.shots.map((shot) => ({
          ...shot,
          included: isSessionOldExcludedBySystem(session, nowMs) ? false : included,
        })),
        metadata: {
          ...(session.metadata ?? {
            app: 'nova-validation',
            schemaVersion: 2,
          }),
          includeInAnalysis: isSessionOldExcludedBySystem(session, nowMs)
            ? false
            : included,
        },
      })),
    )
  }

  const toggleSessionExpanded = (sessionId: string) => {
    setExpandedSessionIds((current) => {
      const next = new Set(current)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  const toggleAllExpanded = () => {
    if (sortedSessions.length === 0) {
      return
    }

    if (allExpanded) {
      setExpandedSessionIds(new Set())
      setAllExpanded(false)
      return
    }

    setExpandedSessionIds(new Set(sortedSessions.map((session) => session.id)))
    setAllExpanded(true)
  }

  const toggleSessionIncluded = (sessionId: string, included: boolean) => {
    persistSessions(
      savedSessions.map((session) =>
        session.id === sessionId
          ? isSessionOldExcludedBySystem(session, nowMs)
            ? session
            : {
                ...session,
                shots: session.shots.map((shot) => ({ ...shot, included })),
                metadata: {
                  ...(session.metadata ?? {
                    app: 'nova-validation',
                    schemaVersion: 2,
                  }),
                  includeInAnalysis: included,
                },
              }
          : session,
      ),
    )
  }

  const toggleShotIncluded = (sessionId: string, shotId: string) => {
    persistSessions(
      savedSessions.map((session) =>
        session.id === sessionId
          ? isSessionOldExcludedBySystem(session, nowMs)
            ? {
                ...session,
                shots: session.shots.map((shot) =>
                  shot.id === shotId ? { ...shot, included: false } : shot,
                ),
                metadata: {
                  ...(session.metadata ?? {
                    app: 'nova-validation',
                    schemaVersion: 2,
                  }),
                  includeInAnalysis: false,
                },
              }
            : (() => {
                const nextShots = session.shots.map((shot) =>
                  shot.id === shotId ? { ...shot, included: !shot.included } : shot,
                )
                return {
                  ...session,
                  shots: nextShots,
                  metadata: {
                    ...(session.metadata ?? {
                      app: 'nova-validation',
                      schemaVersion: 2,
                    }),
                    includeInAnalysis:
                      nextShots.length > 0 && nextShots.every((shot) => shot.included),
                  },
                }
              })()
          : session,
      ),
    )
  }

  const deleteShot = (sessionId: string, shotId: string) => {
    const confirmed = window.confirm('Delete this shot permanently?')
    if (!confirmed) {
      return
    }

    persistSessions(
      savedSessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              shots: session.shots.filter((shot) => shot.id !== shotId),
            }
          : session,
      ),
    )
  }

  const deleteSession = (sessionId: string) => {
    const confirmed = window.confirm('Delete this entire session permanently?')
    if (!confirmed) {
      return
    }

    persistSessions(savedSessions.filter((session) => session.id !== sessionId))
    setExpandedSessionIds((current) => {
      const next = new Set(current)
      next.delete(sessionId)
      return next
    })
  }

  const deleteSelectedSessions = () => {
    const selectedSessionIdSet = new Set(selectedSessionIds)
    if (!hasAnySelectedItems) {
      return
    }

    const persistedSessions = loadSavedSessions()
    const nextSessions = persistedSessions
      .filter((session) => !selectedSessionIdSet.has(session.id))
      .map((session) => {
        if (isSessionOldExcludedBySystem(session, nowMs)) {
          return session
        }
        const remainingShots = session.shots.filter((shot) => !shot.included)
        if (remainingShots.length === 0) {
          return null
        }
        return {
          ...session,
          shots: remainingShots,
          metadata: {
            ...(session.metadata ?? {
              app: 'nova-validation',
              schemaVersion: 2,
            }),
            includeInAnalysis: false,
          },
        }
      })
      .filter((session): session is SavedSession => Boolean(session))

    persistSessions(nextSessions)

    setExpandedSessionIds((current) => {
      const next = new Set(current)
      selectedSessionIds.forEach((sessionId) => {
        next.delete(sessionId)
      })
      return next
    })
  }

  const deleteAllMockData = () => {
    const mockSessionCount = savedSessions.filter(isMockSession).length
    if (mockSessionCount === 0) {
      return
    }

    const confirmed = window.confirm(
      `Delete all mock sessions from storage? (${mockSessionCount} sessions)`,
    )
    if (!confirmed) {
      return
    }

    const filteredSessions = savedSessions.filter((session) => !isMockSession(session))
    persistSessions(filteredSessions)

    const activeDraft = loadActiveSessionDraft()
    if (activeDraft?.metadata.feedMode === 'mock') {
      clearActiveSessionDraft()
    }

    setExpandedSessionIds((current) => {
      const next = new Set(current)
      savedSessions
        .filter(isMockSession)
        .forEach((session) => {
          next.delete(session.id)
        })
      return next
    })
  }

  return (
    <main className="data-management-page">
      <div className="data-management-shell">
        <header className="data-management-header">
          <h1>Data Management</h1>
          <p>Review sessions, maintain inclusion rules, and clean shot history.</p>
          <div className="data-management-controls">
            <label className="dm-master-toggle">
              <input
                checked={allSessionsIncluded}
                disabled={sortedSessions.length === 0}
                onChange={(event) => setAllSessionsIncluded(event.target.checked)}
                type="checkbox"
              />
              <span>Select All</span>
            </label>
            <button
              className="dm-action dm-delete dm-delete-selected"
              disabled={!hasAnySelectedItems}
              onClick={deleteSelectedSessions}
              type="button"
            >
              Delete Selected
            </button>
            <button
              className="dm-action dm-expand-all"
              disabled={sortedSessions.length === 0}
              onClick={toggleAllExpanded}
              type="button"
            >
              {allExpanded ? 'Collapse All' : 'Expand All'}
            </button>
            <a className="dm-action dm-return" href="/dashboard">
              Return to Dashboard
            </a>
            <a className="dm-action dm-return" href="/looper">
              Start New Session
            </a>
            {showDevMockControls ? (
              <button
                className="dm-action dm-delete dm-delete-all"
                disabled={!savedSessions.some(isMockSession)}
                onClick={deleteAllMockData}
                type="button"
              >
                Delete All Mock
              </button>
            ) : null}
          </div>
        </header>

        <section className="data-management-surface" aria-label="Session administration table">
          {sortedSessions.length === 0 ? (
            <p className="data-management-empty">No saved sessions yet.</p>
          ) : (
            <div className="data-management-table-wrap">
              <table className="data-management-table">
                <thead>
                  <tr>
                    <th>Open</th>
                    <th>In</th>
                    <th>Delete</th>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Shots</th>
                    <th>Clubs</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSessions.flatMap((session) => {
                    const expanded = expandedSessionIds.has(session.id)
                    const systemOldExcluded = isSessionOldExcludedBySystem(session, nowMs)
                    const included = isSessionSelected(session)
                    const groups = expanded ? sessionShotGroups(session) : []
                    const clubsText = sessionClubSummary(session) || '-'
                    const endedDate = new Date(session.endedAt)
                    const source = session.metadata?.feedMode ?? 'unknown'

                    return [
                      <tr
                        className={`data-session-row ${included ? '' : 'is-excluded'} ${
                          systemOldExcluded ? 'is-system-old' : ''
                        }`}
                        key={`session-${session.id}`}
                      >
                        <td>
                          <button
                            className="dm-action dm-expand"
                            onClick={() => toggleSessionExpanded(session.id)}
                            type="button"
                          >
                            <span className="dm-expand-glyph">{expanded ? '▾' : '▸'}</span>
                          </button>
                        </td>
                        <td>
                          <input
                            aria-label={`Include session ${session.id}`}
                            checked={included}
                            disabled={systemOldExcluded}
                            onChange={(event) =>
                              toggleSessionIncluded(session.id, event.target.checked)
                            }
                            type="checkbox"
                          />
                          {systemOldExcluded ? (
                            <span className="dm-system-old-label">Old / Excluded</span>
                          ) : null}
                        </td>
                        <td>
                          <button
                            className="dm-action dm-delete"
                            onClick={() => deleteSession(session.id)}
                            type="button"
                          >
                            Delete
                          </button>
                        </td>
                        <td>{endedDate.toLocaleDateString()}</td>
                        <td>{endedDate.toLocaleTimeString()}</td>
                        <td>{session.shots.length}</td>
                        <td>{clubsText}</td>
                        <td>{source}</td>
                      </tr>,
                      expanded ? (
                        <tr className="data-session-expanded-row" key={`expanded-${session.id}`}>
                          <td colSpan={8}>
                            <div className="data-session-expanded-wrap">
                              <div className="data-session-expanded-inner">
                                <table className="data-shot-table">
                                  <thead>
                                    <tr>
                                      <th>In</th>
                                      <th>Delete</th>
                                      <th>Time</th>
                                      <th>Club</th>
                                      <th>Carry</th>
                                      <th>Total</th>
                                      <th>Offline</th>
                                      <th>Spin</th>
                                      <th>Launch</th>
                                      <th>HLA</th>
                                      <th>Spin Axis</th>
                                      <th>Smash</th>
                                      <th>Rank</th>
                                      <th>Path</th>
                                      <th>Face/Path</th>
                                      <th>Face/Target</th>
                                      <th>Club Speed</th>
                                      <th>Ball Speed</th>
                                      <th>Peak</th>
                                      <th>Descent</th>
                                      <th>Shot Shape</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {groups.flatMap((group) => [
                                      <tr
                                        className="data-shot-club-header"
                                        key={`${session.id}-header-${group.club}`}
                                      >
                                        <td colSpan={21}>{getClubLabel(group.club)}</td>
                                      </tr>,
                                      <tr
                                        className="data-shot-club-average"
                                        key={`${session.id}-avg-${group.club}`}
                                      >
                                        <td>AVG</td>
                                        <td>{systemOldExcluded ? 'Old / Excluded' : 'Included'}</td>
                                        <td>-</td>
                                        <td>{getClubLabel(group.club)}</td>
                                        <td>{formatDecimal(group.averages.carry, ' yd')}</td>
                                        <td>{formatDecimal(group.averages.total, ' yd')}</td>
                                        <td>{formatDecimal(group.averages.offline, ' yd')}</td>
                                        <td>{formatWhole(group.averages.spin)}</td>
                                        <td>{formatDecimal(group.averages.launch, '°')}</td>
                                        <td>{formatDecimal(group.averages.hla, '°')}</td>
                                        <td>{formatDecimal(group.averages.spinAxis, '°')}</td>
                                        <td>
                                          {typeof group.averages.smash === 'number'
                                            ? group.averages.smash.toFixed(2)
                                            : '-'}
                                        </td>
                                        <td>{group.includedRankSummary}</td>
                                        <td>{formatDecimal(group.averages.path, '°')}</td>
                                        <td>{formatDecimal(group.averages.facePath, '°')}</td>
                                        <td>{formatDecimal(group.averages.faceTarget, '°')}</td>
                                        <td>{formatDecimal(group.averages.clubSpeed, ' mph')}</td>
                                        <td>{formatDecimal(group.averages.ballSpeed, ' mph')}</td>
                                        <td>{formatDecimal(group.averages.peak, ' yd')}</td>
                                        <td>{formatDecimal(group.averages.descent, '°')}</td>
                                        <td>-</td>
                                      </tr>,
                                      ...group.shots.map((shot) => (
                                        <tr key={`${session.id}-${shot.id}`}>
                                          <td>
                                            <input
                                              aria-label={`Include shot ${shot.id}`}
                                              checked={systemOldExcluded ? false : shot.included}
                                              disabled={systemOldExcluded}
                                              onChange={() => toggleShotIncluded(session.id, shot.id)}
                                              type="checkbox"
                                            />
                                          </td>
                                          <td>
                                            <button
                                              className="dm-action dm-delete dm-delete-shot"
                                              onClick={() => deleteShot(session.id, shot.id)}
                                              type="button"
                                            >
                                              Delete
                                            </button>
                                          </td>
                                          <td>{new Date(shot.capturedAt).toLocaleTimeString()}</td>
                                          <td>{getClubLabel(shot.club)}</td>
                                          <td>{formatDecimal(carryValue(shot), ' yd')}</td>
                                          <td>{formatDecimal(totalValue(shot), ' yd')}</td>
                                          <td>{formatDecimal(offlineValue(shot), ' yd')}</td>
                                          <td>{formatWhole(spinValue(shot))}</td>
                                          <td>{formatDecimal(launchValue(shot), '°')}</td>
                                          <td>{formatDecimal(shot.horizontalLaunchAngleDegrees, '°')}</td>
                                          <td>{formatDecimal(shot.spinAxisDegrees, '°')}</td>
                                          <td>
                                            {typeof smashFactorValue(shot) === 'number'
                                              ? smashFactorValue(shot)!.toFixed(2)
                                              : '-'}
                                          </td>
                                          <td>{formatRank(shot.shotRanking)}</td>
                                          <td>{formatDecimal(clubPathValue(shot), '°')}</td>
                                          <td>{formatDecimal(faceToPathValue(shot), '°')}</td>
                                          <td>{formatDecimal(faceToTargetValue(shot), '°')}</td>
                                          <td>{formatDecimal(clubSpeedValue(shot), ' mph')}</td>
                                          <td>{formatDecimal(ballSpeedMphValue(shot), ' mph')}</td>
                                          <td>{formatDecimal(peakHeightValue(shot), ' yd')}</td>
                                          <td>{formatDecimal(descentValue(shot), '°')}</td>
                                          <td>{shot.shotName ?? '-'}</td>
                                        </tr>
                                      )),
                                    ])}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null,
                    ]
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

export default DataManagementPage
