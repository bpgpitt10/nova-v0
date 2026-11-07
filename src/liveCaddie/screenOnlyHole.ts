import type {
  CourseHoleGeometry,
  CoursePointYds,
  CoursePolygonYds,
  CourseSurface,
} from '../courseGeometry/types'

/**
 * Screen-only caddie: a recommendation from what the sim's screen says, with
 * no course geometry at all (Brian, 11/7: PurePlay, or any course Looper has
 * no map or course file for).
 *
 * The screen gives the distance to the pin, the elevation change, the lie
 * (surface and slope) and the wind. Looper builds a stand-in hole from that:
 * the ball, the pin straight ahead at the read distance, a green round the
 * pin, a fairway corridor up the line and rough everywhere else. No water, no
 * bunkers, no OB: hazards aren't on the screen, so the advice doesn't pretend
 * to know them. The same engine then does the rest: plays-like distance from
 * elevation, wind, lie and altitude, clubs ranked against the player's own
 * dispersion, and the left/right aim that centres the pattern on the pin.
 */

export const SCREEN_ONLY_COURSE_ID = 'screen-only'

/** A typical green: 600–650 sq yd. */
export const SCREEN_ONLY_GREEN_RADIUS_YDS = 14
/** Half-width of the stand-in fairway (a 36-yd corridor, about average). */
export const SCREEN_ONLY_FAIRWAY_HALF_WIDTH_YDS = 18
const SIDE_MARGIN_YDS = 90
const BEHIND_YDS = 25
const PAST_PIN_YDS = 60
const RING_POINTS = 36

const circle = (center: CoursePointYds, radius: number): CoursePolygonYds => {
  const ring: CoursePointYds[] = []
  for (let i = 0; i < RING_POINTS; i += 1) {
    const a = (i / RING_POINTS) * Math.PI * 2
    ring.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)])
  }
  ring.push(ring[0])
  return ring as unknown as CoursePolygonYds
}

const rect = (minX: number, minY: number, maxX: number, maxY: number): CoursePolygonYds =>
  [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]] as unknown as CoursePolygonYds

export type ScreenOnlyHoleInput = Readonly<{
  distanceToPinYds: number
  /** The ball sits on the tee (driver allowed, a tee box under the ball). */
  onTee?: boolean
  holeNumber?: number | null
  par?: number | null
  /** Shown as the course name ("PurePlay", "The Old Game"). */
  label?: string | null
}>

/** The stand-in hole: ball at the origin, pin straight up the y axis. */
export const screenOnlyHole = (input: ScreenOnlyHoleInput): CourseHoleGeometry => {
  const d = Math.max(1, input.distanceToPinYds)
  const pin: CoursePointYds = [0, d]
  const greenR = Math.min(SCREEN_ONLY_GREEN_RADIUS_YDS, Math.max(6, d * 0.4))
  const fairwayEnd = d - greenR * 0.5
  const minX = -SIDE_MARGIN_YDS
  const maxX = SIDE_MARGIN_YDS
  const minY = -BEHIND_YDS
  const maxY = d + PAST_PIN_YDS
  const provenance = { source: 'derived' as const, confidence: 'low' as const, note: 'Screen-only stand-in hole' }
  const surfaces: CourseSurface[] = [
    { id: 'screen-rough', kind: 'rough', polygons: [rect(minX, minY, maxX, maxY)], provenance },
    { id: 'screen-green', kind: 'green', polygons: [circle(pin, greenR)], provenance },
  ]
  if (fairwayEnd > 20) {
    surfaces.push({
      id: 'screen-fairway',
      kind: 'fairway',
      polygons: [rect(-SCREEN_ONLY_FAIRWAY_HALF_WIDTH_YDS, 10, SCREEN_ONLY_FAIRWAY_HALF_WIDTH_YDS, fairwayEnd)],
      provenance,
    })
  }
  if (input.onTee) {
    surfaces.push({ id: 'screen-tee', kind: 'tee', polygons: [rect(-4, -4, 4, 4)], provenance })
  }
  const bounds = { minX, minY, maxX, maxY }
  return {
    schemaVersion: 'looper-course-geometry-v1',
    courseId: SCREEN_ONLY_COURSE_ID,
    courseName: input.label?.trim() || 'Screen only',
    holeNumber: input.holeNumber ?? 0,
    ...(input.par != null ? { par: input.par } : {}),
    statedYardageYds: Math.round(d),
    coordinateSystem: { units: 'yards', origin: 'selected-tee', xAxis: 'right', yAxis: 'forward' },
    bounds,
    viewBounds: bounds,
    markers: { tee: [0, 0], pin },
    surfaces,
    availability: {
      tee: input.onTee ? 'available' : 'unavailable',
      fairway: 'partial',
      rough: 'partial',
      'deep-rough': 'unavailable',
      green: 'partial',
      bunker: 'unavailable',
      water: 'unavailable',
      penalty: 'unavailable',
    },
    registration: {
      status: 'approximate',
      method: 'other',
      targetCoordinateSystem: 'looper-hole-local-yards',
      note: 'Screen-only: ball and pin from the sim screen, nothing else placed.',
    },
    provenance: {
      geometrySource: 'screen-only',
      sourceElementIdsComplete: false,
      note: 'No map and no course file: distance, elevation, lie and wind read off the screen.',
    },
  }
}

export type ScreenOnlyReading = Readonly<{
  distanceToPinYds: number | null
  /** + uphill to the pin, − downhill. */
  elevationFt?: number | null
  surface?: string | null
  /** + up (GSPro "UP"). */
  lieUpDownDeg?: number | null
  /** + ball above the feet / GSPro "LEFT". */
  lieLeftRightDeg?: number | null
  windMph?: number | null
  /** Where the wind comes FROM relative to the line to the pin: 0 = into you, 180 = helping, 90 = from the right. */
  windRelativeDeg?: number | null
  onTee?: boolean
}>

export type ScreenOnlyAdvice = Readonly<{
  club: string
  /** A second club within CLOSE_CALL_STROKES of the pick, shown as "9i (8i close)". */
  closeClub: string | null
  /** What the shot plays like after elevation, wind, lie and air. */
  playsLikeYds: number
  /** Where to start it: negative = left of the pin, positive = right. Whole yards. */
  aimOffsetYds: number
  aimText: string
  /** How the distance was adjusted, for the "why" line. */
  adjustments: readonly Readonly<{ label: string; yds: number }>[]
  missing: readonly string[]
}>

/** Two clubs this close in expected strokes are a coin flip; say so. */
export const CLOSE_CALL_STROKES = 0.03

type PickLike = Readonly<{
  club: string
  stockCarryYds: number
  modeledCarryYds: number
  elevationCarryDeltaYds?: number
  windCarryDeltaYds?: number
  lieCarryDeltaYds?: number
  surfaceCarryDeltaYds?: number
  altitudeCarryDeltaYds?: number
  bestCandidate?: Readonly<{ aimOffsetYds: number }> | null
  decisionValue?: Readonly<{ expectedFutureStrokes: number | null }> | null
}>

const sideText = (yds: number) => (Math.abs(yds) < 1 ? 'at the pin' : `${Math.abs(yds)} yd ${yds < 0 ? 'left' : 'right'} of the pin`)

/**
 * Turn the engine's evaluation of the pick into advice that makes sense with
 * no map: plays-like distance, club, and where to start it.
 */
export const screenOnlyAdvice = (
  reading: ScreenOnlyReading,
  pick: PickLike,
  runnerUp?: PickLike | null,
): ScreenOnlyAdvice | null => {
  if (reading.distanceToPinYds == null || !Number.isFinite(reading.distanceToPinYds)) return null
  const d = reading.distanceToPinYds
  const deltas = [
    { label: 'elevation', yds: pick.elevationCarryDeltaYds ?? 0 },
    { label: 'wind', yds: pick.windCarryDeltaYds ?? 0 },
    { label: 'lie', yds: (pick.lieCarryDeltaYds ?? 0) + (pick.surfaceCarryDeltaYds ?? 0) },
    { label: 'air', yds: pick.altitudeCarryDeltaYds ?? 0 },
  ]
  // A shot the conditions shorten by N yd plays N yd longer.
  const adjustments = deltas
    .map(({ label, yds }) => ({ label, yds: Math.round(-yds) }))
    .filter(({ yds }) => yds !== 0)
  const playsLikeYds = Math.round(d + adjustments.reduce((sum, a) => sum + a.yds, 0))
  const aimOffsetYds = Math.round(pick.bestCandidate?.aimOffsetYds ?? 0)
  const pickEv = pick.decisionValue?.expectedFutureStrokes
  const nextEv = runnerUp?.decisionValue?.expectedFutureStrokes
  const closeClub = runnerUp && pickEv != null && nextEv != null && nextEv - pickEv <= CLOSE_CALL_STROKES
    ? runnerUp.club : null
  const missing: string[] = []
  if (reading.elevationFt == null) missing.push('elevation')
  if (reading.windMph == null) missing.push('wind')
  if (!reading.surface) missing.push('lie')
  // Off a long tee the target isn't the pin; say "the line to the pin".
  const longShot = d > 280
  return {
    club: pick.club,
    closeClub,
    playsLikeYds,
    aimOffsetYds,
    aimText: longShot
      ? `Start it ${Math.abs(aimOffsetYds) < 1 ? 'on the line to the pin' : `${Math.abs(aimOffsetYds)} yd ${aimOffsetYds < 0 ? 'left' : 'right'} of the line to the pin`}`
      : `Start it ${sideText(aimOffsetYds)}`,
    adjustments,
    missing,
  }
}
