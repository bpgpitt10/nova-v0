import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useState } from 'react'
import { activeBagClubIds, getClubLabel, type Club } from '../lib/bagConfig'
import { toggleFeltPerfectShot } from '../lib/feltPerfect'
import { formatShotRank, normalizeShotRank } from '../lib/shotRank'
import { getShotVariantLabel, resolveShotVariantId } from '../lib/shotVariants'
import { resolveHandedOpenGolfCoachValue } from '../lib/openGolfCoach'
import { sessionSourceFromMetadata, sessionSourceLabel } from '../lib/sessionSources'
import {
  clearActiveSessionDraft,
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

const shotTableColumns = [
  'Select',
  'Delete',
  'Pure',
  'Time',
  'Club',
  'Variant',
  'Carry',
  'Total',
  'Offline',
  'Spin',
  'Launch',
  'HLA',
  'Spin Axis',
  'Smash',
  'Rank',
  'Path',
  'Face/Path',
  'Face/Target',
  'Club Speed',
  'Ball Speed',
  'Peak',
  'Descent',
  'Shot Shape',
]

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
    const resolved = resolveHandedOpenGolfCoachValue(value)
    if (typeof resolved === 'number' && Number.isFinite(resolved)) {
      return resolved
    }
    if (typeof resolved === 'string') {
      const parsed = Number(resolved)
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

const payloadStringOrNumber = (payload: OpenGolfCoachPayload | undefined, keys: string[]) => {
  if (!payload) {
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
      const resolved = resolveHandedOpenGolfCoachValue(current[key])
      if (typeof resolved === 'string' || typeof resolved === 'number') {
        return resolved
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
  shot.clubPathDegrees ??
  shot.club_path_degrees ??
  shot.clubPathDeg ??
  shot.club_path_deg ??
  shot.clubPath ??
  shot.club_path ??
  payloadNumber(shot.openGolfCoach, ['club_path_degrees', 'clubPathDegrees'])

const faceToPathValue = (shot: Shot) =>
  shot.faceToPathDegrees ??
  shot.face_to_path_degrees ??
  shot.clubFaceToPathDegrees ??
  shot.club_face_to_path_degrees ??
  shot.faceToPathDeg ??
  shot.face_to_path_deg ??
  shot.faceToPath ??
  shot.face_to_path ??
  shot.clubFaceToPath ??
  shot.club_face_to_path ??
  payloadNumber(shot.openGolfCoach, ['club_face_to_path_degrees', 'clubFaceToPathDegrees'])

const faceToTargetValue = (shot: Shot) =>
  shot.faceToTargetDegrees ??
  shot.face_to_target_degrees ??
  shot.clubFaceToTargetDegrees ??
  shot.club_face_to_target_degrees ??
  shot.faceToTargetDeg ??
  shot.face_to_target_deg ??
  shot.faceToTarget ??
  shot.face_to_target ??
  shot.clubFaceToTarget ??
  shot.club_face_to_target ??
  payloadNumber(shot.openGolfCoach, [
    'club_face_to_target_degrees',
    'clubFaceToTargetDegrees',
  ])

const shotRankValue = (shot: Shot) =>
  shot.shotRanking ?? payloadStringOrNumber(shot.openGolfCoach, ['shot_rank', 'shotRank'])

const shotShapeValue = (shot: Shot) => {
  const value = shot.shotName ?? payloadStringOrNumber(shot.openGolfCoach, ['shot_name', 'shotName'])
  return typeof value === 'string' ? value : undefined
}

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

const sessionClubSummary = (session: SavedSession, shots = session.shots) => {
  const counts = new Map<Club, number>()
  shots.forEach((shot) => {
    counts.set(shot.club, (counts.get(shot.club) ?? 0) + 1)
  })

  return activeBagClubIds
    .filter((club) => counts.has(club))
    .map((club) => `${getClubLabel(club)} (${counts.get(club)})`)
    .join(', ')
}

const sessionShotGroups = (session: SavedSession, shots = session.shots) => {
  const byClub = new Map<Club, Shot[]>()
  shots.forEach((shot) => {
    byClub.set(shot.club, [...(byClub.get(shot.club) ?? []), shot])
  })

  return activeBagClubIds
    .filter((club) => byClub.has(club))
    .map((club) => {
      const clubShots = byClub.get(club) ?? []
      const included = clubShots
      const rankCounts = new Map<string, number>()
      included.forEach((shot) => {
        const shotRank = shotRankValue(shot)
        if (typeof shotRank === 'undefined') {
          return
        }
        const rank = normalizeShotRank(shotRank) ?? String(shotRank)
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
  sessionSourceFromMetadata(session.metadata) === 'mock' ||
  (!session.metadata?.feedMode &&
    !session.metadata?.source &&
    session.shots.length > 0 &&
    session.shots.every((shot) => shot.source === 'mock'))

const shotTableRowValues = (shot: Shot, _systemOldExcluded: boolean) => [
  '',
  'Delete',
  shot.feltPerfect ? '✓ Pure' : 'Pure',
  new Date(shot.capturedAt).toLocaleTimeString(),
  getClubLabel(shot.club),
  getShotVariantLabel(shot.club, shot.shotVariantId),
  formatDecimal(carryValue(shot), ' yd'),
  formatDecimal(totalValue(shot), ' yd'),
  formatDecimal(offlineValue(shot), ' yd'),
  formatWhole(spinValue(shot)),
  formatDecimal(launchValue(shot), '°'),
  formatDecimal(shot.horizontalLaunchAngleDegrees, '°'),
  formatDecimal(shot.spinAxisDegrees, '°'),
  typeof smashFactorValue(shot) === 'number' ? smashFactorValue(shot)!.toFixed(2) : '-',
  formatRank(shotRankValue(shot)),
  formatDecimal(clubPathValue(shot), '°'),
  formatDecimal(faceToPathValue(shot), '°'),
  formatDecimal(faceToTargetValue(shot), '°'),
  formatDecimal(clubSpeedValue(shot), ' mph'),
  formatDecimal(ballSpeedMphValue(shot), ' mph'),
  formatDecimal(peakHeightValue(shot), ' yd'),
  formatDecimal(descentValue(shot), '°'),
  shotShapeValue(shot) ?? '-',
]

const escapeCsvField = (value: string | null | undefined) => {
  if (value == null) {
    return ''
  }

  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }

  return value
}

const csvDateStamp = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function DataManagementPage() {
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>(() => loadSavedSessions())
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set())
  const [allExpanded, setAllExpanded] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set())
  const [selectedShotKeys, setSelectedShotKeys] = useState<Set<string>>(() => new Set())
  const [selectedClubFilter, setSelectedClubFilter] = useState<'all' | Club>('all')
  const [selectedVariantFilter, setSelectedVariantFilter] = useState('all')
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
  const shotSelectionKey = (sessionId: string, shotId: string) => `${sessionId}:${shotId}`
  const hasActiveFilters = selectedClubFilter !== 'all' || selectedVariantFilter !== 'all'
  const shotMatchesFilters = (shot: Shot) =>
    (selectedClubFilter === 'all' || shot.club === selectedClubFilter) &&
    (selectedVariantFilter === 'all' ||
      resolveShotVariantId(shot.shotVariantId) === selectedVariantFilter)
  const visibleSessions = useMemo(
    () =>
      sortedSessions
        .map((session) => ({
          ...session,
          shots: hasActiveFilters ? session.shots.filter(shotMatchesFilters) : session.shots,
        }))
        .filter((session) => session.shots.length > 0),
    [hasActiveFilters, selectedClubFilter, selectedVariantFilter, sortedSessions],
  )
  const clubFilterOptions = useMemo(() => {
    const presentClubs = new Set<Club>()
    sortedSessions.forEach((session) => {
      session.shots.forEach((shot) => presentClubs.add(shot.club))
    })
    return activeBagClubIds.filter((club) => presentClubs.has(club))
  }, [sortedSessions])
  const variantFilterOptions = useMemo(() => {
    const variants = new Map<string, string>()
    sortedSessions.forEach((session) => {
      session.shots.forEach((shot) => {
        if (selectedClubFilter !== 'all' && shot.club !== selectedClubFilter) {
          return
        }
        const variantId = resolveShotVariantId(shot.shotVariantId)
        if (!variants.has(variantId)) {
          variants.set(variantId, getShotVariantLabel(shot.club, variantId))
        }
      })
    })
    return [...variants.entries()].map(([id, label]) => ({ id, label }))
  }, [selectedClubFilter, sortedSessions])
  const visibleShotKeys = useMemo(
    () =>
      new Set(
        visibleSessions.flatMap((session) =>
          session.shots.map((shot) => shotSelectionKey(session.id, shot.id)),
        ),
      ),
    [visibleSessions],
  )
  const allRowsSelected =
    visibleSessions.length > 0 &&
    (hasActiveFilters
      ? visibleShotKeys.size > 0 &&
        [...visibleShotKeys].every((key) => selectedShotKeys.has(key))
      : visibleSessions.every((session) => selectedSessionIds.has(session.id)))
  const selectedShotCount = selectedShotKeys.size
  const hasAnySelectedItems = selectedSessionIds.size > 0 || selectedShotCount > 0
  const exportableShotCount = useMemo(
    () => sortedSessions.reduce((count, session) => count + session.shots.length, 0),
    [sortedSessions],
  )

  const persistSessions = (sessions: SavedSession[]) => {
    setSavedSessions(sessions)
    saveSessionHistory(sessions)
  }

  useEffect(() => {
    if (visibleSessions.length === 0) {
      if (allExpanded) {
        setAllExpanded(false)
      }
      if (selectedSessionIds.size > 0) {
        setSelectedSessionIds(new Set())
      }
      if (selectedShotKeys.size > 0) {
        setSelectedShotKeys(new Set())
      }
      return
    }

    const expandedCount = visibleSessions.filter((session) =>
      expandedSessionIds.has(session.id),
    ).length
    const nextAllExpanded = expandedCount === visibleSessions.length
    if (nextAllExpanded !== allExpanded) {
      setAllExpanded(nextAllExpanded)
    }
  }, [allExpanded, expandedSessionIds, selectedSessionIds.size, selectedShotKeys.size, visibleSessions])

  useEffect(() => {
    if (
      selectedVariantFilter !== 'all' &&
      !variantFilterOptions.some((variant) => variant.id === selectedVariantFilter)
    ) {
      setSelectedVariantFilter('all')
    }
  }, [selectedVariantFilter, variantFilterOptions])

  useEffect(() => {
    setSelectedSessionIds(new Set())
    setSelectedShotKeys(new Set())
  }, [selectedClubFilter, selectedVariantFilter])

  const setAllRowsSelected = (selected: boolean) => {
    if (!selected) {
      setSelectedSessionIds(new Set())
      setSelectedShotKeys(new Set())
      return
    }

    if (hasActiveFilters) {
      setSelectedSessionIds(new Set())
      setSelectedShotKeys(new Set(visibleShotKeys))
      return
    }

    setSelectedSessionIds(new Set(visibleSessions.map((session) => session.id)))
    setSelectedShotKeys(new Set())
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
    if (visibleSessions.length === 0) {
      return
    }

    if (allExpanded) {
      setExpandedSessionIds(new Set())
      setAllExpanded(false)
      return
    }

    setExpandedSessionIds(new Set(visibleSessions.map((session) => session.id)))
    setAllExpanded(true)
  }

  const toggleSessionSelected = (sessionId: string, selected: boolean) => {
    if (hasActiveFilters) {
      const visibleSession = visibleSessions.find((session) => session.id === sessionId)
      const visibleKeys =
        visibleSession?.shots.map((shot) => shotSelectionKey(sessionId, shot.id)) ?? []
      setSelectedSessionIds((current) => {
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
      setSelectedShotKeys((current) => {
        const next = new Set(current)
        visibleKeys.forEach((key) => {
          if (selected) {
            next.add(key)
          } else {
            next.delete(key)
          }
        })
        return next
      })
      return
    }

    setSelectedSessionIds((current) => {
      const next = new Set(current)
      if (selected) {
        next.add(sessionId)
      } else {
        next.delete(sessionId)
      }
      return next
    })
    setSelectedShotKeys((current) => {
      const next = new Set(current)
      savedSessions
        .find((session) => session.id === sessionId)
        ?.shots.forEach((shot) => {
          next.delete(shotSelectionKey(sessionId, shot.id))
        })
      return next
    })
  }

  const toggleShotSelected = (sessionId: string, shotId: string) => {
    const key = shotSelectionKey(sessionId, shotId)
    setSelectedShotKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const toggleShotPure = (sessionId: string, shotId: string) => {
    persistSessions(
      savedSessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              shots: session.shots.map((shot) =>
                shot.id === shotId ? toggleFeltPerfectShot(shot, 'data_management') : shot,
              ),
            }
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
    setSelectedShotKeys((current) => {
      const next = new Set(current)
      next.delete(shotSelectionKey(sessionId, shotId))
      return next
    })
  }

  const deleteSession = (sessionId: string) => {
    const confirmed = window.confirm('Delete this entire session permanently?')
    if (!confirmed) {
      return
    }

    persistSessions(savedSessions.filter((session) => session.id !== sessionId))
    setSelectedSessionIds((current) => {
      const next = new Set(current)
      next.delete(sessionId)
      return next
    })
    setSelectedShotKeys((current) => {
      const next = new Set(current)
      savedSessions
        .find((session) => session.id === sessionId)
        ?.shots.forEach((shot) => {
          next.delete(shotSelectionKey(sessionId, shot.id))
        })
      return next
    })
    setExpandedSessionIds((current) => {
      const next = new Set(current)
      next.delete(sessionId)
      return next
    })
  }

  const deleteSelectedSessions = () => {
    if (!hasAnySelectedItems) {
      return
    }

    const persistedSessions = loadSavedSessions()
    if (hasActiveFilters) {
      const nextSessions = persistedSessions
        .map((session) => {
          const remainingShots = session.shots.filter(
            (shot) => !selectedShotKeys.has(shotSelectionKey(session.id, shot.id)),
          )
          if (remainingShots.length === 0) {
            return null
          }
          return {
            ...session,
            shots: remainingShots,
          }
        })
        .filter((session): session is SavedSession => Boolean(session))

      persistSessions(nextSessions)
      setSelectedSessionIds(new Set())
      setSelectedShotKeys(new Set())
      return
    }

    const nextSessions = persistedSessions
      .filter((session) => !selectedSessionIds.has(session.id))
      .map((session) => {
        const remainingShots = session.shots.filter(
          (shot) => !selectedShotKeys.has(shotSelectionKey(session.id, shot.id)),
        )
        if (remainingShots.length === 0) {
          return null
        }
        return {
          ...session,
          shots: remainingShots,
        }
      })
      .filter((session): session is SavedSession => Boolean(session))

    persistSessions(nextSessions)
    setSelectedSessionIds(new Set())
    setSelectedShotKeys(new Set())

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
    if (sessionSourceFromMetadata(activeDraft?.metadata) === 'mock') {
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

  const exportShotsCsv = async () => {
    if (exportableShotCount === 0) {
      return
    }

    const rows = sortedSessions.flatMap((session) => {
      const systemOldExcluded = isSessionOldExcludedBySystem(session, nowMs)
      return session.shots.map((shot) => shotTableRowValues(shot, systemOldExcluded))
    })
    const csv = [shotTableColumns, ...rows]
      .map((row) => row.map((value) => escapeCsvField(value)).join(','))
      .join('\n')
    const suggestedFilename = `the-looper-shots-export-${csvDateStamp(new Date())}.csv`

    try {
      await invoke('export_shots_csv', { suggestedFilename, csv })
    } catch (error) {
      console.error('Failed to export CSV.', error)
      window.alert('Failed to export CSV. Please try again.')
    }
  }

  return (
    <main className="data-management-page">
      <div className="data-management-shell">
        <header className="data-management-header">
          <h1>Data Management</h1>
          <p>Review sessions, select rows for deletion, and clean shot history.</p>
          <div className="data-management-controls">
            <label className="dm-master-toggle">
              <input
                checked={allRowsSelected}
                disabled={visibleSessions.length === 0}
                onChange={(event) => setAllRowsSelected(event.target.checked)}
                type="checkbox"
              />
              <span>Select All</span>
            </label>
            <button
              className="dm-action dm-expand-all"
              disabled={visibleSessions.length === 0}
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
            <div className="dm-export-actions">
              <button
                className="dm-action dm-delete dm-delete-selected"
                disabled={!hasAnySelectedItems}
                onClick={deleteSelectedSessions}
                type="button"
              >
                Delete Selected
              </button>
              <button
                className="dm-action dm-export"
                disabled={exportableShotCount === 0}
                onClick={exportShotsCsv}
                type="button"
              >
                Export CSV
              </button>
            </div>
          </div>
          <div className="data-management-filters" aria-label="Data filters">
            <label>
              <span>Club</span>
              <select
                onChange={(event) => setSelectedClubFilter(event.target.value as 'all' | Club)}
                value={selectedClubFilter}
              >
                <option value="all">All clubs</option>
                {clubFilterOptions.map((club) => (
                  <option key={club} value={club}>
                    {getClubLabel(club)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Variant</span>
              <select
                onChange={(event) => setSelectedVariantFilter(event.target.value)}
                value={selectedVariantFilter}
              >
                <option value="all">All variants</option>
                {variantFilterOptions.map((variant) => (
                  <option key={variant.id} value={variant.id}>
                    {variant.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="dm-filter-helper">CSV exports full history.</span>
          </div>
        </header>

        <section className="data-management-surface" aria-label="Session administration table">
          {visibleSessions.length === 0 ? (
            <p className="data-management-empty">
              {sortedSessions.length === 0 ? 'No saved sessions yet.' : 'No shots match these filters.'}
            </p>
          ) : (
            <div className="data-management-table-wrap">
              <table className="data-management-table">
                <thead>
                  <tr>
                    <th>Open</th>
                    <th>Select</th>
                    <th>Delete</th>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Shots</th>
                    <th>Clubs</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSessions.flatMap((session) => {
                    const expanded = expandedSessionIds.has(session.id)
                    const originalSession = sortedSessions.find(
                      (candidate) => candidate.id === session.id,
                    )
                    const originalShotCount = originalSession?.shots.length ?? session.shots.length
                    const systemOldExcluded = isSessionOldExcludedBySystem(session, nowMs)
                    const visibleSessionShotKeys = session.shots.map((shot) =>
                      shotSelectionKey(session.id, shot.id),
                    )
                    const sessionSelected = hasActiveFilters
                      ? visibleSessionShotKeys.length > 0 &&
                        visibleSessionShotKeys.every((key) => selectedShotKeys.has(key))
                      : selectedSessionIds.has(session.id)
                    const groups = expanded ? sessionShotGroups(session) : []
                    const clubsText = sessionClubSummary(session) || '-'
                    const endedDate = new Date(session.endedAt)
                    const source = sessionSourceFromMetadata(session.metadata)

                    return [
                      <tr
                        className={`data-session-row ${systemOldExcluded ? 'is-system-old' : ''}`}
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
                            aria-label={`Select session ${session.id}`}
                            checked={sessionSelected}
                            onChange={(event) =>
                              toggleSessionSelected(session.id, event.target.checked)
                            }
                            type="checkbox"
                          />
                          {systemOldExcluded ? (
                            <span className="dm-system-old-label">Old / System Filtered</span>
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
                        <td>
                          {hasActiveFilters && session.shots.length !== originalShotCount
                            ? `${session.shots.length} of ${originalShotCount}`
                            : session.shots.length}
                        </td>
                        <td>{clubsText}</td>
                        <td>{source ? sessionSourceLabel(source) : 'unknown'}</td>
                      </tr>,
                      expanded ? (
                        <tr className="data-session-expanded-row" key={`expanded-${session.id}`}>
                          <td colSpan={8}>
                            <div className="data-session-expanded-wrap">
                              <div className="data-session-expanded-inner">
                                <table className="data-shot-table">
                                  <thead>
                                    <tr>
                                      {shotTableColumns.map((column) => (
                                        <th key={column}>{column}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {groups.flatMap((group) => [
                                      <tr
                                        className="data-shot-club-header"
                                        key={`${session.id}-header-${group.club}`}
                                      >
                                        <td colSpan={23}>{getClubLabel(group.club)}</td>
                                      </tr>,
                                      <tr
                                        className="data-shot-club-average"
                                        key={`${session.id}-avg-${group.club}`}
                                      >
                                        <td>AVG</td>
                                        <td>-</td>
                                        <td>-</td>
                                        <td>-</td>
                                        <td>{getClubLabel(group.club)}</td>
                                        <td>-</td>
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
                                              aria-label={`Select shot ${shot.id}`}
                                              checked={selectedShotKeys.has(
                                                shotSelectionKey(session.id, shot.id),
                                              )}
                                              disabled={sessionSelected}
                                              onChange={() => toggleShotSelected(session.id, shot.id)}
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
                                          <td>
                                            <button
                                              aria-pressed={shot.feltPerfect === true}
                                              className={`dm-action dm-pure-toggle ${
                                                shot.feltPerfect ? 'is-selected' : ''
                                              }`}
                                              onClick={() => toggleShotPure(session.id, shot.id)}
                                              type="button"
                                            >
                                              {shot.feltPerfect ? '✓ Pure' : 'Pure'}
                                            </button>
                                          </td>
                                          <td>{new Date(shot.capturedAt).toLocaleTimeString()}</td>
                                          <td>{getClubLabel(shot.club)}</td>
                                          <td>{getShotVariantLabel(shot.club, shot.shotVariantId)}</td>
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
                                          <td>{formatRank(shotRankValue(shot))}</td>
                                          <td>{formatDecimal(clubPathValue(shot), '°')}</td>
                                          <td>{formatDecimal(faceToPathValue(shot), '°')}</td>
                                          <td>{formatDecimal(faceToTargetValue(shot), '°')}</td>
                                          <td>{formatDecimal(clubSpeedValue(shot), ' mph')}</td>
                                          <td>{formatDecimal(ballSpeedMphValue(shot), ' mph')}</td>
                                          <td>{formatDecimal(peakHeightValue(shot), ' yd')}</td>
                                          <td>{formatDecimal(descentValue(shot), '°')}</td>
                                          <td>{shotShapeValue(shot) ?? '-'}</td>
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
