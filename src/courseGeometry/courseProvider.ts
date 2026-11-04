import {
  UNSELECTED_COURSE_ID,
  getCourseCatalogEntry,
  type CourseId,
} from './courseCatalog'
import { buildGsproOnlyHoleGeometry, isGsproOnlyCourseId } from './gsproOnlyCourse'
import { loadNativeCourseContext, selectNativeLayout, type NativeCourseStatus } from './nativeCourseRuntime'
import { normalizeRouteCourseGeometry } from './normalizeRouteCourseGeometry'
import { loadRoundTeeSelection } from './roundTeeSelection'
import { loadRoutePackagedCourseHoleGeometry } from './routePackagedCourseLoader'
import { resolveShotOneTee } from './shotOneTeeResolver'
import { loadCourseTeeCandidates } from './teeCandidateProvider'
import type { CourseHoleGeometry } from './types'

const withShotOneTee = async (
  courseId: CourseId,
  holeNumber: number,
  geometry: CourseHoleGeometry,
): Promise<CourseHoleGeometry> => {
  let teeCandidates = geometry.teeCandidates ?? []
  try {
    teeCandidates = await loadCourseTeeCandidates(courseId, holeNumber)
  } catch (error) {
    console.warn('[Course geometry] tee-candidate sidecar could not be loaded; keeping package tee marker.', error)
  }

  const enriched = teeCandidates.length > 0
    ? { ...geometry, teeCandidates }
    : geometry
  const selection = loadRoundTeeSelection(courseId)
  const resolution = resolveShotOneTee(enriched, selection)

  return {
    ...enriched,
    markers: {
      ...enriched.markers,
      tee: resolution.point,
    },
  }
}

const gsproOnlyUnavailable = (name: string, status: NativeCourseStatus): string => {
  switch (status.state) {
    case 'no-folder':
      return `${name} is read from GSPro's course files: start the Looper Companion on your GSPro PC.`
    case 'needs-permission':
      return `Allow read access to your GSPro course folder again to play ${name}.`
    case 'gkd-not-found':
      return `${name}: GSPro's course file (${status.courseKey}) was not found on this PC.`
    case 'error':
      return `${name}: GSPro's course file could not be read (${status.message}).`
    default:
      return `${name}: GSPro's course file is not available on this device.`
  }
}

const gsproOnlyCache = new Map<string, Promise<CourseHoleGeometry>>()

/**
 * A GSPro-only course's hole, from the course file on this PC (the layout the
 * round's tee pick names, e.g. "White (Farmlinks Kids)", else the main one).
 */
const loadGsproOnlyHoleGeometry = async (courseId: CourseId, holeNumber: number): Promise<CourseHoleGeometry> => {
  const entry = getCourseCatalogEntry(courseId)
  const { context, status } = await loadNativeCourseContext(courseId, null)
  if (!context) throw new Error(gsproOnlyUnavailable(entry.name, status))
  const selection = loadRoundTeeSelection(courseId)
  const chosen = selectNativeLayout(context, {
    holeNumber,
    preShotWorld: null,
    normalizedTeeSet: selection?.teeSet ?? null,
    rememberedLayoutName: null,
  }).context
  const key = `${courseId}|${holeNumber}|${chosen.layoutName}`
  let pending = gsproOnlyCache.get(key)
  if (!pending) {
    pending = Promise.resolve().then(() => buildGsproOnlyHoleGeometry({
      entry,
      layout: chosen.layout,
      layouts: context.layouts.map((option) => option.layout),
      registration: context.registration,
      holeNumber,
      altLayoutName: context.layouts.find((option) => option.name === chosen.layoutName)?.kind === 'alt'
        ? chosen.layoutName : null,
    }))
    gsproOnlyCache.set(key, pending)
    pending.catch(() => gsproOnlyCache.delete(key))
  }
  return pending
}

/**
 * Canonical runtime entry point for static course geometry.
 *
 * Every route package is
 * normalized to the selected-tee runtime contract before any UI or decision
 * logic consumes it.
 *
 * Shot 1 then applies the persisted round tee selection conservatively: a
 * locked calibration wins; otherwise exactly one matching OSM tee candidate is
 * required. Missing/ambiguous metadata leaves the package tee marker untouched.
 */
export const loadCourseHoleGeometry = (
  courseId: CourseId,
  holeNumber: number,
): Promise<CourseHoleGeometry> => {
  if (courseId === UNSELECTED_COURSE_ID) {
    return Promise.reject(new Error('Choose a course before loading hole geometry.'))
  }
  getCourseCatalogEntry(courseId)
  // GSPro-only: the hole comes from GSPro's course file; its tees are the
  // candidates, so the round's GSPro tee pick places the tee exactly.
  if (isGsproOnlyCourseId(courseId)) {
    return loadGsproOnlyHoleGeometry(courseId, holeNumber)
      .then((geometry) => withShotOneTee(courseId, holeNumber, geometry))
  }
  return loadRoutePackagedCourseHoleGeometry(courseId, holeNumber)
    .then(normalizeRouteCourseGeometry)
    .then((geometry) => withShotOneTee(courseId, holeNumber, geometry))
}
