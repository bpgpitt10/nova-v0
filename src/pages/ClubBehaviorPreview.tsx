import { useMemo } from 'react'
import {
  activeBagClubIds,
  getClubDisplayName,
  getClubLabel,
  type Club,
} from '../lib/bagConfig'
import {
  isShotIncludedInAnalysis,
  sessionHistoricalWeightForClub,
} from '../lib/historicalModel'
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

type WeightedMovementRow = {
  startOffset: number
  finishOffset: number
  movement: number
  carry: number
  weight: number
}

const balancedPercents = (counts: number[]) => {
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total <= 0) {
    return counts.map(() => 0)
  }

  const raw = counts.map((count) => (count / total) * 100)
  const rounded = raw.map((value) => Math.floor(value))
  let remainder = 100 - rounded.reduce((sum, value) => sum + value, 0)

  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction)

  for (let cursor = 0; cursor < order.length && remainder > 0; cursor += 1) {
    rounded[order[cursor].index] += 1
    remainder -= 1
  }

  return rounded
}

// Trim by curve movement once, then use those same adjusted row weights for
// start, movement, and finish. That preserves finish = start + movement while
// preventing a few extreme curves from dragging the expected flight around.
const robustMovementWeights = (rows: WeightedMovementRow[], trimPct: number) => {
  const originalWeights = rows.map((row) => row.weight)
  if (rows.length < 10) {
    return originalWeights
  }

  const boundedTrimPct = Math.min(Math.max(trimPct, 0), 0.49)
  const sorted = rows
    .map((row, index) => ({ index, movement: row.movement, weight: row.weight }))
    .filter((row) => Number.isFinite(row.weight) && row.weight > 0)
    .sort((left, right) => left.movement - right.movement)

  const totalWeight = sorted.reduce((sum, row) => sum + row.weight, 0)
  if (totalWeight <= 0) {
    return originalWeights
  }

  const adjustedWeights = [...originalWeights]
  const trimWeight = totalWeight * boundedTrimPct
  let remainingLowTrim = trimWeight
  let remainingHighTrim = trimWeight

  for (const row of sorted) {
    if (remainingLowTrim <= 0) {
      break
    }
    const applied = Math.min(adjustedWeights[row.index], remainingLowTrim)
    adjustedWeights[row.index] -= applied
    remainingLowTrim -= applied
  }

  for (let index = sorted.length - 1; index >= 0 && remainingHighTrim > 0; index -= 1) {
    const row = sorted[index]
    const applied = Math.min(adjustedWeights[row.index], remainingHighTrim)
    adjustedWeights[row.index] -= applied
    remainingHighTrim -= applied
  }

  return adjustedWeights
}

const weightedMovementRowAverage = (
  rows: WeightedMovementRow[],
  weights: number[],
  accessor: (row: WeightedMovementRow) => number,
) => {
  let weightedSum = 0
  let totalWeight = 0

  rows.forEach((row, index) => {
    const weight = weights[index]
    const value = accessor(row)
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) {
      return
    }
    weightedSum += value * weight
    totalWeight += weight
  })

  return totalWeight > 0 ? weightedSum / totalWeight : undefined
}

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
  return { startOffset, finishOffset: offline, movement, carry }
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

const buildFlightScale = (startOffset: number | undefined, finishOffset: number | undefined) => {
  const plotLeft = 12
  const plotRight = 168
  const definedStart = typeof startOffset === 'number' ? startOffset : 0
  const definedFinish = typeof finishOffset === 'number' ? finishOffset : 0
  const rawMin = Math.min(0, definedStart, definedFinish)
  const rawMax = Math.max(0, definedStart, definedFinish)
  const rawSpan = Math.max(rawMax - rawMin, 1)
  const padding = Math.max(1.2, rawSpan * 0.28)
  const domainMin = rawMin - padding
  const domainMax = rawMax + padding
  const domainSpan = Math.max(domainMax - domainMin, 1)

  const xFor = (value: number | undefined) => {
    const resolved = typeof value === 'number' ? value : 0
    return plotLeft + ((resolved - domainMin) / domainSpan) * (plotRight - plotLeft)
  }

  return {
    startX: xFor(startOffset),
    finishX: xFor(finishOffset),
    targetX: xFor(0),
  }
}

const markerAnchor = (x: number): 'start' | 'middle' | 'end' => {
  if (x < 30) {
    return 'start'
  }
  if (x > 150) {
    return 'end'
  }
  return 'middle'
}

export default function ClubBehaviorPreview({
  clubLabel,
  selectedVariantId,
}: ClubBehaviorPreviewProps) {
  const summary = useMemo(() => {
    const club = resolveClub(clubLabel)
    if (!club) {
      return null
    }

    // Loading history also refreshes the installed mishit classifier so this
    // uses the same planning truth as the rest of Looper.
    const sessions = loadSavedSessions().filter((session) => isSessionEligibleForAnalysis(session))

    // Strike reliability is intentionally a simple recent-frequency read.
    const recentShots = sessions
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

    if (recentShots.length === 0) {
      return {
        expectedShape: 'Building',
        expectedDirection: 'Need more shots',
        expectedMovement: undefined,
        startOffset: undefined,
        finishOffset: undefined,
        shapeWeights: { Draw: 0, Straight: 0, Fade: 0 } as Record<ShapeBucket, number>,
        strikeReady: false,
        normalPercent: 0,
        mishitPercent: 0,
        severePercent: 0,
      }
    }

    const classifications = recentShots.map((shot) => getInstalledMishitClassification(shot.id))
    const severeCount = classifications.filter(
      (classification) => classification?.classification === 'severe_mishit',
    ).length
    const mishitCount = classifications.filter(
      (classification) => classification?.classification === 'mishit',
    ).length
    const normalCount = classifications.filter(
      (classification) => classification?.classification === 'normal',
    ).length
    const unclassifiedCount = recentShots.length - severeCount - mishitCount - normalCount
    const strikeReady = unclassifiedCount === 0

    // Shape follows the same historical weighting philosophy as Stock:
    // planning-eligible shots, recency/support weighting, and equal sharing of
    // each session's total weight across shots for this club/variant.
    const historicalNowMs = Date.now()
    const movementRows: WeightedMovementRow[] = sessions.flatMap((session) => {
      const planningShots = session.shots.filter(
        (shot) =>
          shotMatchesIdentity(shot, club, selectedVariantId) &&
          isShotIncludedInAnalysis(shot),
      )
      if (planningShots.length === 0) {
        return []
      }

      const sessionWeight = sessionHistoricalWeightForClub(
        session,
        club,
        historicalNowMs,
      )
      const shotWeight = sessionWeight / planningShots.length
      if (!Number.isFinite(shotWeight) || shotWeight <= 0) {
        return []
      }

      return planningShots.flatMap((shot) => {
        const movement = movementForShot(shot)
        if (!movement) {
          return []
        }
        return [{ ...movement, weight: shotWeight }]
      })
    })

    // At 10+ valid shape observations, shave 10% of weighted influence from
    // each movement tail. The same adjusted row weights drive Start and Curve,
    // so Finish is always exactly Start + Movement.
    const robustWeights = robustMovementWeights(movementRows, 0.1)
    const startOffset = weightedMovementRowAverage(
      movementRows,
      robustWeights,
      (row) => row.startOffset,
    )
    const expectedMovement = weightedMovementRowAverage(
      movementRows,
      robustWeights,
      (row) => row.movement,
    )
    const expectedCarry = weightedMovementRowAverage(
      movementRows,
      robustWeights,
      (row) => row.carry,
    )
    const finishOffset =
      typeof startOffset === 'number' && typeof expectedMovement === 'number'
        ? startOffset + expectedMovement
        : undefined

    const shapeWeights: Record<ShapeBucket, number> = { Draw: 0, Straight: 0, Fade: 0 }
    movementRows.forEach((row) => {
      shapeWeights[shapeBucketFromMovement(row.movement, row.carry)] += row.weight
    })

    const shapeTotal = shapeWeights.Draw + shapeWeights.Straight + shapeWeights.Fade
    const rankedShapes = (Object.entries(shapeWeights) as Array<[ShapeBucket, number]>)
      .sort((left, right) => right[1] - left[1])
    const [topShape, topWeight] = rankedShapes[0]
    const [, secondWeight] = rankedShapes[1]
    const topShare = shapeTotal > 0 ? topWeight / shapeTotal : 0
    const leadShare = shapeTotal > 0 ? (topWeight - secondWeight) / shapeTotal : 0
    const hasDominantShape = topShare >= 0.6 && leadShare >= 0.15
    const expectedBucket =
      typeof expectedMovement === 'number'
        ? shapeBucketFromMovement(expectedMovement, expectedCarry)
        : undefined
    const hasCoherentDominantShape = hasDominantShape && topShape === expectedBucket

    const expectedShape = (() => {
      if (shapeTotal === 0 || typeof expectedMovement !== 'number') {
        return 'Building'
      }
      if (!hasCoherentDominantShape) {
        return 'Mixed'
      }
      if (topShape === 'Straight') {
        return 'Straight'
      }
      return Math.abs(expectedMovement) < 5 ? `Baby ${topShape}` : topShape
    })()

    const expectedDirection = (() => {
      if (shapeTotal === 0 || typeof expectedMovement !== 'number') {
        return 'Need more shots'
      }
      if (hasCoherentDominantShape) {
        if (topShape === 'Straight') {
          return 'Minimal curve'
        }
        return topShape === 'Draw' ? 'Right → Left' : 'Left → Right'
      }

      const [secondShape] = rankedShapes[1]
      if (topShape === 'Straight') {
        return leadShare < 0.08 && secondWeight > 0
          ? `Straight / ${secondShape.toLowerCase()} split`
          : 'Mixed pattern'
      }
      return leadShare < 0.12
        ? `Slight ${topShape.toLowerCase()} bias`
        : `${topShape} bias`
    })()

    const [normalPercent, mishitPercent, severePercent] = strikeReady
      ? balancedPercents([normalCount, mishitCount, severeCount])
      : [0, 0, 0]

    return {
      expectedShape,
      expectedDirection,
      expectedMovement,
      startOffset,
      finishOffset,
      shapeWeights,
      strikeReady,
      normalPercent,
      mishitPercent,
      severePercent,
    }
  }, [clubLabel, selectedVariantId])

  if (!summary) {
    return null
  }

  const [drawPercent, straightPercent, fadePercent] = balancedPercents([
    summary.shapeWeights.Draw,
    summary.shapeWeights.Straight,
    summary.shapeWeights.Fade,
  ])

  const { startX, finishX, targetX } = buildFlightScale(
    summary.startOffset,
    summary.finishOffset,
  )
  const controlX = (startX + finishX) / 2

  return (
    <article
      aria-label="Expected shot shape and strike reliability"
      className="dashboard-card club-v2-behavior-preview"
    >
      <div className="club-v2-behavior-cell club-v2-behavior-shape">
        <div className="club-v2-behavior-label">Shape</div>
        <div className="club-v2-behavior-primary">{summary.expectedShape}</div>
        <div className="club-v2-behavior-secondary">{summary.expectedDirection}</div>
      </div>

      <div className="club-v2-behavior-cell club-v2-behavior-movement">
        <div className="club-v2-behavior-label">Movement</div>
        <div className="club-v2-behavior-primary">
          {movementLabel(summary.expectedMovement)}
        </div>
        <svg aria-hidden="true" className="club-v2-behavior-flight-svg" viewBox="0 0 180 50">
          <defs>
            <marker
              id="club-v2-behavior-flight-arrow"
              markerHeight="6"
              markerUnits="strokeWidth"
              markerWidth="6"
              orient="auto"
              refX="5.2"
              refY="3"
              viewBox="0 0 6 6"
            >
              <path className="club-v2-behavior-flight-arrowhead" d="M 0 0 L 6 3 L 0 6 z" />
            </marker>
          </defs>
          <line
            className="club-v2-behavior-target-line"
            x1={targetX}
            x2={targetX}
            y1="9"
            y2="37"
          />
          <text
            className="club-v2-behavior-target-label"
            textAnchor="start"
            x={targetX + 3}
            y="25"
          >
            Target
          </text>
          <path
            className="club-v2-behavior-flight-path"
            d={`M ${startX.toFixed(1)} 32 Q ${controlX.toFixed(1)} 18 ${finishX.toFixed(1)} 14`}
            markerEnd="url(#club-v2-behavior-flight-arrow)"
          />
          <circle className="club-v2-behavior-start-dot" cx={startX} cy="32" r="3.3" />
          <text
            className="club-v2-behavior-marker-label finish"
            textAnchor={markerAnchor(finishX)}
            x={finishX}
            y="7"
          >
            Finish {directionalLabel(summary.finishOffset)}
          </text>
          <text
            className="club-v2-behavior-marker-label start"
            textAnchor={markerAnchor(startX)}
            x={startX}
            y="48"
          >
            Start {directionalLabel(summary.startOffset)}
          </text>
        </svg>
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
          {summary.strikeReady ? (
            <>
              <span><b>Normal</b> {summary.normalPercent}%</span>
              <span><b>Mishit</b> {summary.mishitPercent}%</span>
              <span><b>Severe</b> {summary.severePercent}%</span>
            </>
          ) : (
            <span><b>Building</b></span>
          )}
        </div>
      </div>
    </article>
  )
}
