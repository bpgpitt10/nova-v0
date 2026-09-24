import { useEffect, useMemo, useState } from 'react'
import { connectToGsproLieObservation } from '../adapters/gsproLieObservation'
import { connectToGsproWindObservation } from '../adapters/gsproWindObservation'
import { getRouteHoleHeadingDegreesTrue } from '../courseGeometry/generatedRouteHoleHeadings'
import type { CoursePointYds } from '../courseGeometry/types'
import type { GsproLieObservation, WindObservation } from '../liveState/types'
import { projectWindObservation } from '../liveState/windProjection'

const normalizeDegrees = (value: number) => ((value % 360) + 360) % 360

const localBearingDegrees = (from: CoursePointYds, to: CoursePointYds) => {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (Math.hypot(dx, dy) <= Number.EPSILON) return null
  return normalizeDegrees(Math.atan2(dx, dy) * 180 / Math.PI)
}

export const resolveShotCompassBearingDegrees = (
  courseId: string,
  holeNumber: number,
  ball: CoursePointYds,
  target: CoursePointYds,
) => {
  const holeHeading = getRouteHoleHeadingDegreesTrue(courseId, holeNumber)
  const localBearing = localBearingDegrees(ball, target)
  if (holeHeading == null || localBearing == null) return null
  return normalizeDegrees(holeHeading + localBearing)
}

const axisLabel = (
  value: number | null | undefined,
  positive: string,
  negative: string,
) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (Math.abs(value) < 0.05) return 'level'
  return `${Math.abs(value).toFixed(1)}° ${value > 0 ? positive : negative}`
}

export type LiveCaddieOcrState = {
  windObservation: WindObservation | null
  lieObservation: GsproLieObservation | null
  hasLiveWind: boolean
  windMph: number
  windRelativeDeg: number
  shotCompassBearingDeg: number | null
  surfaceOverride: string | null
  lieUpDownDeg: number | null
  /** Live Caddie convention: positive = LEFT / ball above feet. */
  lieLeftRightDeg: number | null
  lieSource: string | null
  windDisplay: string
  lieDisplay: string
}

/**
 * Browser-only pre-shot OCR bridge for LIVE Caddie.
 *
 * The OCR detectors remain independent localhost helpers. This hook subscribes
 * to their canonical browser adapters, rejects non-READY observations from the
 * recommendation inputs, projects validated wind into the current target line,
 * and converts the lie side-sign into Live Caddie's established convention.
 */
export const useLiveCaddieOcr = (
  ball: CoursePointYds,
  target: CoursePointYds,
  courseId: string,
  holeNumber: number,
): LiveCaddieOcrState => {
  const [windObservation, setWindObservation] = useState<WindObservation | null>(null)
  const [lieObservation, setLieObservation] = useState<GsproLieObservation | null>(null)

  useEffect(() => {
    const windConnection = connectToGsproWindObservation({
      onObservation: setWindObservation,
    })
    const lieConnection = connectToGsproLieObservation({
      onObservation: setLieObservation,
    })

    return () => {
      windConnection.disconnect()
      lieConnection.disconnect()
    }
  }, [])

  const aimBearingDegrees = useMemo(
    () => localBearingDegrees(ball, target),
    [ball, target],
  )
  const shotCompassBearingDeg = useMemo(
    () => resolveShotCompassBearingDegrees(courseId, holeNumber, ball, target),
    [courseId, holeNumber, ball, target],
  )
  const projectedWind = useMemo(
    () => projectWindObservation(
      windObservation,
      aimBearingDegrees,
      shotCompassBearingDeg,
    ),
    [windObservation, aimBearingDegrees, shotCompassBearingDeg],
  )
  const hasLiveWind = Boolean(
    windObservation?.status === 'READY'
    && windObservation.speedMph != null
    && projectedWind.projection,
  )
  const windMph = hasLiveWind ? windObservation?.speedMph ?? 0 : 0
  const windRelativeDeg = hasLiveWind
    ? projectedWind.projection?.relativeFromDegrees ?? 0
    : 0

  const lieReady = lieObservation?.status === 'READY'
  const surfaceOverride = lieReady ? lieObservation.surface : null
  const lieUpDownDeg = lieReady ? lieObservation.upDownDegrees : null
  // OCR canonical convention is +RIGHT / -LEFT. Live Caddie's sidehill model
  // intentionally uses +LEFT / -RIGHT, so invert exactly once at this seam.
  const lieLeftRightDeg = lieReady && lieObservation.leftRightDegrees != null
    ? -lieObservation.leftRightDegrees
    : null
  const lieSource = lieReady ? lieObservation.source : null

  const windDisplay = hasLiveWind
    ? `Wind ${windMph.toFixed(windMph >= 10 ? 0 : 1)} mph · OCR`
    : windObservation?.status === 'READY' && shotCompassBearingDeg == null
      ? 'Wind OCR ready · course bearing unavailable'
      : windObservation
        ? `Wind OCR ${windObservation.status.toLowerCase()}`
        : 'Wind OCR waiting'

  const lieAxes = [
    axisLabel(lieObservation?.upDownDegrees, 'up', 'down'),
    axisLabel(lieObservation?.leftRightDegrees, 'right', 'left'),
  ].filter(Boolean)
  const lieDisplay = lieReady
    ? `Lie ${lieObservation?.surface ?? 'surface ?'}${lieAxes.length ? ` · ${lieAxes.join(' / ')}` : ''} · OCR`
    : lieObservation
      ? `Lie OCR ${lieObservation.status.toLowerCase()}`
      : 'Lie OCR waiting'

  return {
    windObservation,
    lieObservation,
    hasLiveWind,
    windMph,
    windRelativeDeg,
    shotCompassBearingDeg,
    surfaceOverride,
    lieUpDownDeg,
    lieLeftRightDeg,
    lieSource,
    windDisplay,
    lieDisplay,
  }
}
