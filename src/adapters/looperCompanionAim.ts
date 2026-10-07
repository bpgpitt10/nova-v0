/**
 * Stage C: convert the selected Live Caddie recommendation into a strictly
 * READ-ONLY native aim proposal. Nothing here is ever sent to Windows.
 *
 * IMPORTANT: CoursePointYds are Looper LOCAL hole coordinates, NOT proven
 * GSPro/world coordinates. The native companion must reject them for clicking
 * until an independently verified frame transform, fresh live shot identity,
 * explicit one-shot arm and user-local pairing are available.
 */
import type { BrowserGsproCourseSnapshot } from './browserGsproCourseState'
import type { CoursePointYds } from '../courseGeometry/types'

export type ReadOnlyNativeAimIntent = {
  kind: 'looper-companion-native-aim-preview-v1'
  coordinateFrame: 'looper-hole-local-yards-unverified'
  nativeInputAuthorized: false
  courseId: string
  gsproCourseKey: string
  roundId: number
  holeNumber: number
  nextShotNumber: number
  previousShotKey: string | null
  shotReference: string
  observedAt: string
  club: string
  ballLocalYds: CoursePointYds
  teeLocalYds: CoursePointYds
  pinLocalYds: CoursePointYds
  targetLocalYds: CoursePointYds
}

type Inputs = {
  snapshot: BrowserGsproCourseSnapshot | null
  courseId: string
  holeNumber: number
  club: string | null
  teeLocalYds: CoursePointYds | null
  targetLocalYds: CoursePointYds | null
}

const finitePoint = (point: CoursePointYds | null | undefined): point is CoursePointYds =>
  Boolean(point && point.length === 2 && point.every(Number.isFinite))

export const prepareReadOnlyNativeAimIntent = ({
  snapshot,
  courseId,
  holeNumber,
  club,
  teeLocalYds,
  targetLocalYds,
}: Inputs): ReadOnlyNativeAimIntent | null => {
  // These checks are for displaying a diagnostic intent, not authorization.
  // Every field must be independently revalidated by the eventual native API.
  if (!snapshot || snapshot.holeNumber !== holeNumber ||
      !snapshot.courseKey || snapshot.roundId == null ||
      !Number.isSafeInteger(snapshot.roundId) ||
      snapshot.nextShotNumber == null ||
      !Number.isSafeInteger(snapshot.nextShotNumber) ||
      (snapshot.nextShotNumber ?? 0) <= 0 ||
      !club || !club.trim() || !courseId ||
      snapshot.surface?.trim().toLowerCase() === 'green' ||
      !finitePoint(snapshot.ballLocalYds) ||
      !finitePoint(teeLocalYds) ||
      !finitePoint(snapshot.pinLocalYds) ||
      !finitePoint(targetLocalYds) ||
      (snapshot.pinDistanceValidationErrorYds != null &&
        (!Number.isFinite(snapshot.pinDistanceValidationErrorYds) ||
          snapshot.pinDistanceValidationErrorYds > 3))) {
    return null
  }
  return {
    kind: 'looper-companion-native-aim-preview-v1',
    coordinateFrame: 'looper-hole-local-yards-unverified',
    nativeInputAuthorized: false,
    courseId,
    gsproCourseKey: snapshot.courseKey,
    roundId: snapshot.roundId,
    holeNumber,
    nextShotNumber: snapshot.nextShotNumber!,
    previousShotKey: snapshot.latestShotKey,
    shotReference: [
      snapshot.roundId,
      snapshot.courseKey,
      holeNumber,
      snapshot.nextShotNumber,
      snapshot.latestShotKey ?? 'pre-tee',
    ].join(':'),
    observedAt: snapshot.observedAt,
    club: club.trim(),
    ballLocalYds: [...snapshot.ballLocalYds] as CoursePointYds,
    teeLocalYds: [...teeLocalYds] as CoursePointYds,
    pinLocalYds: [...snapshot.pinLocalYds] as CoursePointYds,
    targetLocalYds: [...targetLocalYds] as CoursePointYds,
  }
}
