import type { CoursePointYds } from './types'

export type LiveFirstTeeSnapshot = Readonly<{
  holeNumber: number | null
  nextShotNumber: number | null
  teePlacement?: 'mapped' | 'locked' | 'provisional' | null
  ballLocalYds: CoursePointYds | null
  distanceToPinYds: number | null
}>
export type MeasuredFirstTee = Readonly<{
  point: CoursePointYds
  distanceYds: number
  uncertaintyYds: number
  source: string
}>

/**
 * Resolve what Live Caddie should actually render while waiting on Shot 1.
 * A manual setup snapshot often begins at the OSM back-tee (e.g. FarmLinks
 * 572 yards), while a later validated native ruler provisionally identifies
 * another tee (~493 yards). The display must use one spatial/distance source.
 *
 * The completed physical shot is always authoritative for Shot 2 onward.
 */
export const resolveLiveFirstTeeDisplay = (
  snapshot: LiveFirstTeeSnapshot | null,
  displayedHoleNumber: number,
  native: MeasuredFirstTee | null,
  saved: MeasuredFirstTee | null,
): Readonly<{
  measured: MeasuredFirstTee | null
  ball: CoursePointYds | null
  distanceToPinYds: number | null
}> => {
  if (!snapshot || snapshot.holeNumber !== displayedHoleNumber) {
    return { measured: null, ball: snapshot?.ballLocalYds ?? null, distanceToPinYds: snapshot?.distanceToPinYds ?? null }
  }
  const measured = snapshot.nextShotNumber === 1 && snapshot.teePlacement === 'provisional'
    ? native ?? saved : null
  const acceptable = measured
    && measured.point.length === 2
    && measured.point.every(Number.isFinite)
    && Number.isFinite(measured.distanceYds)
    && measured.distanceYds > 45 && measured.distanceYds < 750
    && Number.isFinite(measured.uncertaintyYds)
    && measured.uncertaintyYds > 0
    ? measured : null
  return {
    measured: acceptable,
    ball: acceptable?.point ?? snapshot.ballLocalYds,
    distanceToPinYds: acceptable?.distanceYds ?? snapshot.distanceToPinYds,
  }
}
