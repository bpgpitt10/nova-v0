import type { GsproStartingPositionObservation } from '../adapters/gsproStartingPosition'
import {
  GREYWOLF_COURSE_ID,
  resolveCourseIdFromGsproName,
  type CourseId,
} from './courseCatalog'
import {
  captureGreywolfH1StartingPosition,
  GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT,
} from './greywolfH1StartingPositionCalibration'
import { loadRoundTeeSelection } from './roundTeeSelection'
import { loadTeeCalibration } from './teeCalibrationStore'
import type { CoursePointYds } from './types'

export type GreywolfH1LiveTeePosition = Readonly<{
  courseLocalYds: CoursePointYds | null
  source: 'gspro-startingpos' | 'cached-calibration' | 'unresolved'
  teeSet: string | null
  warning: string | null
}>

const cachedResolution = (teeSet: string): GreywolfH1LiveTeePosition | null => {
  const cached = loadTeeCalibration(
    GREYWOLF_H1_TEE_CALIBRATION_FINGERPRINT,
    1,
    teeSet,
  )
  if (!cached) return null
  return {
    courseLocalYds: cached.courseLocalYds,
    source: 'cached-calibration',
    teeSet,
    warning: null,
  }
}

/**
 * Resolves the selected Greywolf H1 tee in the fixed course package frame.
 * A CurrentShot StartingPOS is preferred. A previously learned calibration is
 * safe fallback because it is keyed to the explicitly selected round tee set.
 * The generic hole marker is intentionally not used here.
 */
export const resolveGreywolfH1LiveTeePosition = (
  selectedCourseId: CourseId,
  holeNumber: number,
  preShotStart: GsproStartingPositionObservation | null,
): GreywolfH1LiveTeePosition | null => {
  if (selectedCourseId !== GREYWOLF_COURSE_ID || holeNumber !== 1) return null

  const selectedTee = loadRoundTeeSelection(GREYWOLF_COURSE_ID)
  if (!selectedTee) {
    return {
      courseLocalYds: null,
      source: 'unresolved',
      teeSet: null,
      warning: 'Greywolf H1 physical tee is unresolved because no round tee set is selected.',
    }
  }

  const teeSet = selectedTee.teeSet
  const startIsH1Tee = Boolean(
    preShotStart
    && preShotStart.holeNumber === 1
    && (preShotStart.surface === 'tee' || preShotStart.shotNumber === 1),
  )

  if (preShotStart && startIsH1Tee) {
    const observedCourseId = preShotStart.courseKey
      ? resolveCourseIdFromGsproName(preShotStart.courseKey)
      : null
    if (observedCourseId && observedCourseId !== GREYWOLF_COURSE_ID) {
      return {
        courseLocalYds: null,
        source: 'unresolved',
        teeSet,
        warning: `GSPro StartingPOS reports ${preShotStart.courseKey}; refusing to calibrate it as Greywolf H1.`,
      }
    }

    const captured = captureGreywolfH1StartingPosition({
      teeSet,
      world: preShotStart.world,
      distanceToPinYds: preShotStart.distanceToPinYds,
    })

    if (
      captured.status === 'anchor-locked'
      || captured.status === 'candidate-saved'
      || captured.status === 'unchanged'
    ) {
      return {
        courseLocalYds: captured.record.courseLocalYds,
        source: 'gspro-startingpos',
        teeSet,
        warning: null,
      }
    }

    const cached = cachedResolution(teeSet)
    if (cached) return cached

    return {
      courseLocalYds: null,
      source: 'unresolved',
      teeSet,
      warning: 'reason' in captured ? captured.reason : 'Greywolf H1 physical tee could not be resolved.',
    }
  }

  const cached = cachedResolution(teeSet)
  if (cached) return cached

  return {
    courseLocalYds: null,
    source: 'unresolved',
    teeSet,
    warning: 'Greywolf H1 physical tee has not been calibrated for the selected tee set yet.',
  }
}
