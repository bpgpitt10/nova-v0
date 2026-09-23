import { useMemo } from 'react'
import {
  activeBagClubIds,
  getClubDisplayName,
  getClubLabel,
  type Club,
} from '../lib/bagConfig'
import { getInstalledMishitClassification } from '../lib/mishitPlanningPopulation'
import { resolveHandedOpenGolfCoachValue } from '../lib/openGolfCoach'
import { isSessionEligibleForAnalysis, loadSavedSessions } from '../lib/sessions'
import { shotMatchesIdentity } from '../lib/shotVariants'
import type { OpenGolfCoachPayload, Shot } from '../types'
import './ClubBehaviorPreview.css'

type ShapeBucket = 'Draw' | 'Straight' | 'Fade'

type ClubBehaviorPreviewProps = {
  clubLabel: string
  selectedVariantId: string
}

const previewEnabled = () => {
  if (typeof window === 'undefined') {
    return false
  }
  return new URLSearchParams(window.location.search).get('clubDetailPreview') === '1'
}

const average = (values: number[]) =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined

const percent = (count: number, total: number) =>
  total > 0 ? Math.round((count / total) * 100) : 0

const payloadNumber = (payload: OpenGolfCoachPayload | undefined, keys: string[]) => {
  if (!payload) {
    return undefined
  }

  const stack: unknown[] = [payload]
  const visited = new Set<object>()

  while (stack.length > 0) {
    const value = stack.pop()
    if (!value || typeof value !== 'object' || Array.isArray(value) || visited.has(value)) {
      continue
    }
    visited.add(value)
    const record = value as Record<string, unknown>

    for (const key of keys) {
      const resolved = resolveHandedOpenGolfCoachValue(record[key])
      if (typeof resolved === 'number' && Number.isFinite(resolved)) {
        return resolved
      }
      if (typeof resolved === 'string') {
        const parsed = Number(resolved)
        if (Number.isFinite(parsed)) {
          return parsed
        }
      }
    }

    Object.values(record).forEach((nested) => stack.push(nested))
  }

  return undefined
}

const carryValue = (shot: Shot) =>
  typeof shot.carryYards === 'number'
    ? shot.carryYards
    : payloadNumber(shot.openGolfCoach, ['carry_distance_yards', 'carryDistanceYards', 'carry'])

const offlineValue = (shot: Shot) =>
  typeof shot.offlineYards === 'number'
    ? shot.offlineYards
    : payloadNumber(shot.openGolfCoach, ['offline_distance_yards', 'offlineDistanceYards', 'offline'])

const hlaValue = (shot: Shot) =>
  typeof shot.horizontalLaunchAngleDegrees === 'number'
    ? shot.horizontalLaunchAngleDegrees
    : payloadNumber(shot.openGolfCoach, [
        'horizontal_launch_angle_degrees',
        'horizontalLaunchAngleDegrees',
        'horizontal_launch_angle',
      ])

const movementForShot = (shot: Shot) => {
  const carry = carryValue(shot)
  const offline = offlineValue(shot)
  const hla = hlaValue(shot)
  if (
    typeof carry !== 'number' ||
    typeof offline !== 'number' ||
    typeof hla !== 'number' ||
    !Number.isFinite(carry) ||
    !Number.isFinite(offline) ||
    !Number.isFinite(hla)
  ) {
    return null
  }

  const startOffset = Math.tan((hla * Math.PI) / 180) * carry
  const movement = offline - startOffset
  return { startOffset, finishOffset: offline, movement }
}

const shapeBucketFromMovement = (movement: number, carry: number | undefined): ShapeBucket => {
  const threshold = Math.max(1.5, typeof carry === 'number' ? carry * 0.01 : 1.5)
  if (movement < -threshold) {
    return 'Draw'
  }
  if (movement > threshold) {
    return 'Fade'
  }
  return 'Straight'
}

const resolveClub = (clubLabel: string): Club | null =>
  activeBagClubIds.find(
    (club) => getClubDisplayName(club) === clubLabel || getClubLabel(club) === clubLabel,
  ) ?? null

const movementLabel = (movement: number | undefined) => {
  if (typeof movement !== 'number') {
    return '—'
  }
  if (Math.abs(movement) < 0.05) {
    return '0.0 yd'
  }
  return `${Math.abs(movement).toFixed(1)} yd ${movement < 0 ? 'L' : 'R'}`
}

const directionalLabel = (value: number | undefined) => {
  if (typeof value !== 'number') {
    return '—'
  }
  if (Math.abs(value) < 0.05) {
    return '0.0'
  }
  return `${Math.abs(value).toFixed(1)} ${value < 0 ? 'L' : 'R'}`
}

export default function ClubBehaviorPreview({
  clubLabel,
  selectedVariantId,
}: ClubBehaviorPreviewProps) {
  const enabled = previewEnabled()

  const summary = useMemo(() => {
    if (!enabled) {
      return null
    }

    const club = resolveClub(clubLabel)
    if (!club) {
      return null
    }

    // loadSavedSessions also refreshes the installed mishit classifier from the
    // current user's same-origin history, so this preview uses the same derived
    // mishit truth as the rest of Looper rather than a separate rank heuristic.
    const sessions = loadSavedSessions().filter((session) => isSessionEligibleForAnalysis(session))
    const shots = sessions
      .flatMap((session) => session.shots)
      .filter(
        (shot) =>
          shot.included !== false &&
          shotMatchesIdentity(shot, club, selectedVariantId),
      )
      .sort(
        (left, right) =>
          new Date(right.capturedAt).getTime() - new Date(left.capturedAt).getTime(),
      )
      .slice(0, 50)

    if (shots.length === 0) {
      return {
        sampleCount: 0,
        expectedShape: 'Building',
        expectedDirection: 'Need more shots',
        expectedMovement: undefined,
        startOffset: undefined,
        finishOffset: undefined,
        shapeCounts: { Draw: 0, Straight: 0, Fade: 0 } as Record<ShapeBucket, number>,
        normalPercent: 0,
        mishitPercent: 0,
        severePercent: 0,
      }
    }

    const severeShots = shots.filter(
      (shot) => getInstalledMishitClassification(shot.id)?.classification === 'severe_mishit',
    )
    const mishitShots = shots.filter(
      (shot) => getInstalledMishitClassification(shot.id)?.classification === 'mishit',
    )
    const normalShots = shots.filter((shot) => {
      const classification = getInstalledMishitClassification(shot.id)?.classification
      return classification !== 'mishit' && classification !== 'severe_mishit'
    })

    // Shape is intentionally built from the normal/planning population. Mishits
    // remain visible in Strike Reliability instead of teaching the expected shot.
    const shapePopulation = normalShots.length > 0 ? normalShots : shots
    const movementRows = shapePopulation.flatMap((shot) => {
      const movement = movementForShot(shot)
      if (!movement) {
        return []
      }
      return [{ ...movement, carry: carryValue(shot) }]
    })

    const expectedMovement = average(movementRows.map((row) => row.movement))
    const startOffset = average(movementRows.map((row) => row.startOffset))
    const finishOffset = average(movementRows.map((row) => row.finishOffset))

    const shapeCounts: Record<ShapeBucket, number> = { Draw: 0, Straight: 0, Fade: 0 }
    movementRows.forEach((row) => {
      shapeCounts[shapeBucketFromMovement(row.movement, row.carry)] += 1
    })

    const expectedShape = (() => {
      if (typeof expectedMovement !== 'number' || Math.abs(expectedMovement) < 1.5) {
        return 'Straight'
      }
      const base = expectedMovement < 0 ? 'Draw' : 'Fade'
      return Math.abs(expectedMovement) < 5 ? `Baby ${base}` : base
    })()

    const expectedDirection = (() => {
      if (typeof expectedMovement !== 'number' || Math.abs(expectedMovement) < 1.5) {
        return 'Minimal curve'
      }
      return expectedMovement < 0 ? 'Right → Left' : 'Left → Right'
    })()

    return {
      sampleCount: shots.length,
      expectedShape,
      expectedDirection,
      expectedMovement,
      startOffset,
      finishOffset,
      shapeCounts,
      normalPercent: percent(shots.length - mishitShots.length - severeShots.length, shots.length),
      mishitPercent: percent(mishitShots.length, shots.length),
      severePercent: percent(severeShots.length, shots.length),
    }
  }, [clubLabel, enabled, selectedVariantId])

  if (!enabled || !summary) {
    return null
  }

  const shapeTotal =
    summary.shapeCounts.Draw + summary.shapeCounts.Straight + summary.shapeCounts.Fade
  const drawPercent = percent(summary.shapeCounts.Draw, shapeTotal)
  const straightPercent = percent(summary.shapeCounts.Straight, shapeTotal)
  const fadePercent = percent(summary.shapeCounts.Fade, shapeTotal)

  const visualExtent = Math.max(
    6,
    Math.abs(summary.startOffset ?? 0),
    Math.abs(summary.finishOffset ?? 0),
  ) * 1.25
  const xFor = (value: number | undefined) => {
    if (typeof value !== 'number') {
      return 90
    }
    return 90 + (value / visualExtent) * 68
  }
  const startX = xFor(summary.startOffset)
  const finishX = xFor(summary.finishOffset)
  const controlX = (startX + finishX) / 2

  return (
    <article
      aria-label="Expected shot shape and strike reliability preview"
      className="dashboard-card club-v2-behavior-preview"
    >
      <div className="club-v2-behavior-cell club-v2-behavior-shape">
        <div className="club-v2-behavior-label">Expected Shape</div>
        <div className="club-v2-behavior-primary">{summary.expectedShape}</div>
        <div className="club-v2-behavior-secondary">{summary.expectedDirection}</div>
      </div>

      <div className="club-v2-behavior-cell club-v2-behavior-movement">
        <div className="club-v2-behavior-label">Expected Movement</div>
        <div className="club-v2-behavior-primary">
          {movementLabel(summary.expectedMovement)}
        </div>
        <svg aria-hidden="true" className="club-v2-behavior-flight-svg" viewBox="0 0 180 42">
          <line className="club-v2-behavior-target-line" x1="90" x2="90" y1="4" y2="36" />
          <path
            className="club-v2-behavior-flight-path"
            d={`M ${startX.toFixed(1)} 31 Q ${controlX.toFixed(1)} 13 ${finishX.toFixed(1)} 8`}
          />
          <circle className="club-v2-behavior-start-dot" cx={startX} cy="31" r="3.3" />
          <circle className="club-v2-behavior-finish-dot" cx={finishX} cy="8" r="3.3" />
        </svg>
        <div className="club-v2-behavior-movement-read">
          <span>Start {directionalLabel(summary.startOffset)}</span>
          <span>Finish {directionalLabel(summary.finishOffset)}</span>
        </div>
      </div>

      <div className="club-v2-behavior-cell club-v2-behavior-mix">
        <div className="club-v2-behavior-label">Shape Mix</div>
        <div className="club-v2-behavior-segment-bar" aria-hidden="true">
          <span className="draw" style={{ width: `${drawPercent}%` }} />
          <span className="straight" style={{ width: `${straightPercent}%` }} />
          <span className="fade" style={{ width: `${fadePercent}%` }} />
        </div>
        <div className="club-v2-behavior-legend club-v2-behavior-shape-legend">
          <span><b>Draw</b> {drawPercent}%</span>
          <span><b>Straight</b> {straightPercent}%</span>
          <span><b>Fade</b> {fadePercent}%</span>
        </div>
      </div>

      <div className="club-v2-behavior-cell club-v2-behavior-strike">
        <div className="club-v2-behavior-label">Strike Reliability</div>
        <div className="club-v2-behavior-segment-bar" aria-hidden="true">
          <span className="normal" style={{ width: `${summary.normalPercent}%` }} />
          <span className="mishit" style={{ width: `${summary.mishitPercent}%` }} />
          <span className="severe" style={{ width: `${summary.severePercent}%` }} />
        </div>
        <div className="club-v2-behavior-legend club-v2-behavior-strike-legend">
          <span><b>Normal</b> {summary.normalPercent}%</span>
          <span><b>Mishit</b> {summary.mishitPercent}%</span>
          <span><b>Severe</b> {summary.severePercent}%</span>
        </div>
        <div className="club-v2-behavior-sample">Recent {summary.sampleCount} shots</div>
      </div>
    </article>
  )
}
