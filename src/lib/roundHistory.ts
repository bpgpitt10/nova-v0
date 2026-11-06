import {
  BROADIE_2012_OFF_GREEN_TABLE,
  PGA_TOUR_PUTTING_TABLE,
} from '../liveCaddie/nextStateValue'

/**
 * Round history: turns the raw GSPro round records the companion captures
 * (`live_course_shots` / the local round archive) into clean holes, putts,
 * scores and strokes gained per shot.
 *
 * Rules learned from real captures (2 Nov 2026):
 * - A real hole chains: every shot starts where the previous one stopped.
 *   Test re-hits and copied putt rows break the chain; the hole is kept for
 *   reference but never scored, and a round with many broken holes is a test.
 * - Gimme rows copy the previous stroke's launch data with isGimme=true. They
 *   count toward the score but not toward putting make rates.
 * - Putts are identified by where they start (the green), not by the inferred
 *   club: club inference labels putter strokes "SW". GSPro club index 26 is
 *   the putter.
 * - Distance to pin in a record is the distance LEFT after the shot; a shot's
 *   start distance is the previous shot's end, and a hole's first shot is
 *   measured from the pin (the holed shot's resting position).
 */

export type WorldPoint = Readonly<{ x: number; y: number; z: number }>

export type RoundShotRecord = {
  roundId: number
  courseKey: string | null
  holeNumber: number
  holeShot: number
  observedAt: string | null
  startSurface: number | null
  endSurface: number | null
  /** GSPro's distance to the pin after the shot, in yards. */
  distanceToPinYds: number | null
  carryYards: number | null
  totalYards: number | null
  spinAxisDegrees: number | null
  gsproClubIndex: number | null
  isHoled: boolean
  isGimme: boolean
  /** GSPro world metres. */
  start: WorldPoint | null
  end: WorldPoint | null
  club: string | null
  clubSource: 'armed' | 'inferred' | null
  clubConfidence: number | null
  recommendedClub: string | null
  /** armed − recommended expected strokes at arm time; null when Looper didn't price it. */
  paperCostStrokes?: number | null
  /** 'starting-bag' | 'learning' | 'measured': what the recommendation rested on. */
  modelBasis?: string | null
}

export type ShotLie = 'tee' | 'fairway' | 'fringe' | 'rough' | 'deep-rough' | 'sand' | 'green' | 'unknown'

export type ShotCategory = 'off-the-tee' | 'approach' | 'around-green' | 'putting'

export type RoundShot = {
  holeNumber: number
  number: number
  club: string | null
  clubSource: 'armed' | 'inferred' | 'gspro-putter' | null
  clubConfidence: number | null
  recommendedClub: string | null
  paperCostStrokes: number | null
  modelBasis: string | null
  isPutt: boolean
  /** A conceded putt (gimme): counts as a stroke, not as a made putt. */
  conceded: boolean
  holed: boolean
  startLie: ShotLie
  endLie: ShotLie | 'holed'
  startSurfaceRaw: number | null
  endSurfaceRaw: number | null
  /** Yards to the pin before the shot; null when it can't be known. */
  startYds: number | null
  endYds: number
  carryYards: number | null
  spinAxisDegrees: number | null
  category: ShotCategory | null
  /** Strokes gained vs the PGA Tour baseline; null without a start distance. */
  sg: number | null
  /** Start or end lie is a GSPro surface code we haven't identified yet. */
  provisional: boolean
  start: WorldPoint | null
  end: WorldPoint | null
}

export type RoundHole = {
  holeNumber: number
  par: number | null
  /** Hole finished, captured from its first shot, and every shot chains. */
  complete: boolean
  /** Shots that don't chain (test re-hits, copied rows). */
  broken: boolean
  strokes: number
  putts: number
  gir: boolean | null
  fir: boolean | null
  sg: number | null
  pin: WorldPoint | null
  shots: RoundShot[]
}

export type RoundStatus = 'full' | 'partial' | 'test' | 'fragment' | 'range'

export type CategoryTotals = Record<ShotCategory, { sg: number; shots: number }>

export type RoundSummary = {
  roundId: number
  courseKey: string | null
  courseName: string
  playedAt: string | null
  status: RoundStatus
  holes: RoundHole[]
  holesPlayed: number
  completeHoles: number
  /** Strokes on complete holes. */
  strokes: number
  /** Par of the complete holes, when every one of them has a known par. */
  par: number | null
  putts: number
  gir: { hit: number; of: number }
  fir: { hit: number; of: number }
  sg: { total: number | null; categories: CategoryTotals }
  autoPutt: boolean
  /** The player's choice on the Rounds page; null when Looper decides. */
  countState: RoundCountChoice | null
  /** Conceded or re-hit holes, shots that don't follow on, or a hole or two then quit. */
  looksLikeTest: boolean
  /** Whether the round goes into stats: the player's choice, else not when it looks like a test. */
  counts: boolean
  unknownLieShots: number
  brokenHoles: number
  shotCount: number
}

export type CourseInfo = Readonly<{
  name?: string | null
  pars?: Readonly<Record<number, number>>
}>

/** The player's choice for a round. 'deleted' rounds never reach these functions. */
export type RoundCountChoice = 'counts' | 'excluded'

export type RoundFlags = Readonly<{ autoPutt?: boolean; countState?: RoundCountChoice | null }>

/**
 * A round that looks like testing rather than golf: shots that don't follow on
 * (status 'test'), a hole or two then quit ('fragment'), or most holes left
 * unfinished (conceded). These don't count until the player says they do.
 */
export const roundLooksLikeTest = (round: Pick<RoundSummary, 'status' | 'holesPlayed' | 'completeHoles'>) =>
  round.status === 'test' || round.status === 'fragment'
  || (round.holesPlayed >= 2 && round.completeHoles / round.holesPlayed < 0.5)

export const roundCounts = (
  round: Pick<RoundSummary, 'status' | 'holesPlayed' | 'completeHoles'>,
  choice: RoundCountChoice | null | undefined,
) => round.status !== 'range' && (choice === 'counts' || (choice == null && !roundLooksLikeTest(round)))

export const GSPRO_PUTTER_CLUB_INDEX = 26
const METERS_TO_YARDS = 1.0936132983377078
const CHAIN_TOLERANCE_M = 1.0
const AROUND_GREEN_MAX_YDS = 30
const LONG_TEE_SHOT_YDS = 250

const SURFACE_LIES: Readonly<Record<number, ShotLie>> = {
  18: 'tee',
  2: 'fairway',
  1: 'rough',
  3: 'deep-rough',
  11: 'sand',
  5: 'green',
  // Brian, 3 Nov 2026: Royal New Kent round 279, hole 2 shot 3 finished on the
  // fringe (21 yd out, then chipped). Rounds only; Live Caddie's surface library
  // (src/adapters/gsproSurfaceCodes.ts) waits for a paired HUD confirmation.
  12: 'fringe',
}

export const lieFromSurface = (code: number | null): ShotLie =>
  code == null ? 'unknown' : SURFACE_LIES[code] ?? 'unknown'

/**
 * Average strokes to hole out from the tee, PGA Tour (Broadie, "Every Shot
 * Counts", 2014). Broadie 2012 Table B.1 (used by the decision engine) has no
 * tee column; tee shots are worth slightly less than the same distance from
 * the fairway.
 */
const BROADIE_TEE_TABLE: readonly { distanceYds: number; expected: number }[] = [
  { distanceYds: 100, expected: 2.92 },
  { distanceYds: 120, expected: 2.99 },
  { distanceYds: 140, expected: 2.97 },
  { distanceYds: 160, expected: 2.99 },
  { distanceYds: 180, expected: 3.05 },
  { distanceYds: 200, expected: 3.12 },
  { distanceYds: 220, expected: 3.17 },
  { distanceYds: 240, expected: 3.25 },
  { distanceYds: 260, expected: 3.45 },
  { distanceYds: 280, expected: 3.65 },
  { distanceYds: 300, expected: 3.71 },
  { distanceYds: 320, expected: 3.79 },
  { distanceYds: 340, expected: 3.86 },
  { distanceYds: 360, expected: 3.92 },
  { distanceYds: 380, expected: 3.96 },
  { distanceYds: 400, expected: 3.99 },
  { distanceYds: 420, expected: 4.02 },
  { distanceYds: 440, expected: 4.08 },
  { distanceYds: 460, expected: 4.17 },
  { distanceYds: 480, expected: 4.28 },
  { distanceYds: 500, expected: 4.41 },
  { distanceYds: 520, expected: 4.54 },
  { distanceYds: 540, expected: 4.65 },
  { distanceYds: 560, expected: 4.74 },
  { distanceYds: 580, expected: 4.79 },
  { distanceYds: 600, expected: 4.82 },
]

const interpolate = (x: number, rows: readonly { x: number; y: number }[]) => {
  if (x <= rows[0].x) return rows[0].y
  const last = rows[rows.length - 1]
  if (x >= last.x) return last.y
  for (let index = 1; index < rows.length; index += 1) {
    const upper = rows[index]
    if (x > upper.x) continue
    const lower = rows[index - 1]
    return lower.y + ((upper.y - lower.y) * (x - lower.x)) / (upper.x - lower.x)
  }
  return last.y
}

const offGreenRows = (column: 'fairway' | 'rough' | 'sand') =>
  BROADIE_2012_OFF_GREEN_TABLE.map((row) => ({ x: row.distanceYds, y: row[column] }))

const BASELINES = {
  tee: BROADIE_TEE_TABLE.map((row) => ({ x: row.distanceYds, y: row.expected })),
  fairway: offGreenRows('fairway'),
  rough: offGreenRows('rough'),
  sand: offGreenRows('sand'),
  putting: PGA_TOUR_PUTTING_TABLE.map((row) => ({ x: row.distanceFeet, y: row.expectedPutts })),
}

/**
 * PGA Tour expected strokes to hole out. GSPro deep rough uses the rough
 * column (it is heavier rough, not a punch-out recovery); unidentified
 * surfaces use rough too and the shot is marked provisional.
 */
export const tourExpectedStrokes = (lie: ShotLie, yards: number): number => {
  if (lie === 'green') return interpolate(Math.max(0, yards) * 3, BASELINES.putting)
  if (lie === 'tee') {
    // The tee table starts at 100 yd; shorter tee shots are valued from the fairway.
    return yards >= 100 ? interpolate(yards, BASELINES.tee) : interpolate(yards, BASELINES.fairway)
  }
  // Fringe has no tour table of its own; it plays like the fairway.
  if (lie === 'fairway' || lie === 'fringe') return interpolate(yards, BASELINES.fairway)
  if (lie === 'sand') return interpolate(yards, BASELINES.sand)
  return interpolate(yards, BASELINES.rough)
}

const horizontalMeters = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.z - b.z)

const samePoint = (a: WorldPoint | null, b: WorldPoint | null) =>
  a != null && b != null && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.z - b.z) < 0.01

const isJunkRecord = (record: RoundShotRecord) =>
  record.start == null ||
  (record.start.x === 0 && record.start.z === 0) ||
  record.endSurface === 0 && record.carryYards === 0

export const isRangeRound = (courseKey: string | null, roundId: number) =>
  roundId < 0 || /range/i.test(courseKey ?? '')

/** "GreyWolf_gsp" → "Grey Wolf"; used until the course file gives a real name. */
export const prettifyCourseKey = (courseKey: string | null) => {
  if (!courseKey) return 'Unknown course'
  const base = courseKey
    .replace(/_gsp$/i, '')
    .replace(/_v\d+$/i, '')
    .replace(/_\d+(_\d+)*$/, '')
    .replace(/_(al|[a-z]{2})$/i, '')
  return base
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

const categoryFor = (
  isPutt: boolean,
  startLie: ShotLie,
  startYds: number | null,
  par: number | null,
): ShotCategory | null => {
  if (isPutt) return 'putting'
  if (startYds == null) return null
  if (startLie === 'tee' && (par != null ? par >= 4 : startYds > LONG_TEE_SHOT_YDS)) return 'off-the-tee'
  if (startYds <= AROUND_GREEN_MAX_YDS) return 'around-green'
  return 'approach'
}

const emptyCategories = (): CategoryTotals => ({
  'off-the-tee': { sg: 0, shots: 0 },
  approach: { sg: 0, shots: 0 },
  'around-green': { sg: 0, shots: 0 },
  putting: { sg: 0, shots: 0 },
})

const buildHole = (
  holeNumber: number,
  records: RoundShotRecord[],
  par: number | null,
  autoPutt: boolean,
): RoundHole => {
  const ordered = [...records].sort((a, b) => a.holeShot - b.holeShot)
  const kept: RoundShotRecord[] = []
  let broken = false
  for (const record of ordered) {
    const previous = kept[kept.length - 1]
    if (previous) {
      const chained = previous.end != null && record.start != null
        && horizontalMeters(previous.end, record.start) <= CHAIN_TOLERANCE_M
      const copied = samePoint(previous.start, record.start) && samePoint(previous.end, record.end)
      if (!chained || copied) {
        broken = true
        break
      }
    }
    kept.push(record)
  }

  const holedRecord = kept.find((record) => record.isHoled) ?? null
  const pin = holedRecord?.end ?? null
  const startsAtTee = kept[0]?.holeShot === 1 && lieFromSurface(kept[0]?.startSurface ?? null) === 'tee'
  const complete = !broken && holedRecord != null && startsAtTee

  const shots: RoundShot[] = []
  let previousEnd: number | null = null
  kept.forEach((record, index) => {
    const startLie = lieFromSurface(record.startSurface)
    const isPutt = startLie === 'green'
    const endLie: ShotLie | 'holed' = record.isHoled ? 'holed' : lieFromSurface(record.endSurface)
    let startYds: number | null = null
    if (index === 0) {
      startYds = pin && record.start ? horizontalMeters(record.start, pin) * METERS_TO_YARDS : null
    } else {
      startYds = previousEnd
    }
    const endYds = record.isHoled ? 0 : Math.max(0, record.distanceToPinYds ?? 0)
    previousEnd = record.isHoled ? 0 : record.distanceToPinYds
    const provisional = startLie === 'unknown' || endLie === 'unknown'
    const startValue = startYds != null ? tourExpectedStrokes(startLie, startYds) : null
    const endValue = endLie === 'holed' ? 0 : tourExpectedStrokes(endLie, endYds)
    const sg = startValue != null && (!isPutt || !autoPutt) ? startValue - endValue - 1 : null
    const putterByIndex = record.gsproClubIndex === GSPRO_PUTTER_CLUB_INDEX
    shots.push({
      holeNumber,
      number: record.holeShot,
      // Inference only knows full swings and labels putter strokes "SW"; a
      // stroke from the green is a putt unless the player armed another club.
      club: isPutt && !(record.clubSource === 'armed' && record.club) ? 'Putter' : record.club,
      clubSource: isPutt && record.clubSource !== 'armed'
        ? (putterByIndex ? 'gspro-putter' : null)
        : record.clubSource,
      clubConfidence: record.clubConfidence,
      recommendedClub: record.recommendedClub,
      paperCostStrokes: record.paperCostStrokes ?? null,
      modelBasis: record.modelBasis ?? null,
      isPutt,
      conceded: record.isGimme,
      holed: record.isHoled,
      startLie,
      endLie,
      startSurfaceRaw: record.startSurface,
      endSurfaceRaw: record.endSurface,
      startYds,
      endYds,
      carryYards: record.carryYards,
      spinAxisDegrees: record.spinAxisDegrees,
      category: categoryFor(isPutt, startLie, startYds, par),
      sg,
      provisional,
      start: record.start,
      end: record.end,
    })
  })

  const putts = shots.filter((shot) => shot.isPutt).length
  let gir: boolean | null = null
  if (complete && par != null) {
    const firstOnGreen = shots.findIndex((shot) => shot.endLie === 'green' || shot.endLie === 'holed')
    gir = firstOnGreen >= 0 && firstOnGreen + 1 <= par - 2
  }
  const fir = complete && par != null && par >= 4 ? shots[0]?.endLie === 'fairway' : null
  const sg = complete && shots.every((shot) => shot.sg != null || (shot.isPutt && autoPutt))
    ? shots.reduce((sum, shot) => sum + (shot.sg ?? 0), 0)
    : null

  return {
    holeNumber,
    par,
    complete,
    broken,
    strokes: complete ? kept.length : shots.length,
    putts,
    gir,
    fir,
    sg,
    pin,
    shots,
  }
}

export const buildRound = (
  roundId: number,
  records: RoundShotRecord[],
  course: CourseInfo = {},
  flags: RoundFlags = {},
): RoundSummary => {
  const courseKey = records.find((record) => record.courseKey)?.courseKey ?? null
  const playedAt = records
    .map((record) => record.observedAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0] ?? null
  const autoPutt = flags.autoPutt === true
  const usable = records.filter((record) => !isJunkRecord(record))
  const byHole = new Map<number, RoundShotRecord[]>()
  usable.forEach((record) => {
    const list = byHole.get(record.holeNumber) ?? []
    list.push(record)
    byHole.set(record.holeNumber, list)
  })
  const holes = [...byHole.entries()]
    .sort(([a], [b]) => a - b)
    .map(([holeNumber, list]) => buildHole(holeNumber, list, course.pars?.[holeNumber] ?? null, autoPutt))

  const complete = holes.filter((hole) => hole.complete)
  const brokenHoles = holes.filter((hole) => hole.broken).length
  const categories = emptyCategories()
  let total = 0
  let totalShots = 0
  complete.forEach((hole) => {
    hole.shots.forEach((shot) => {
      if (shot.sg == null || shot.category == null) return
      categories[shot.category].sg += shot.sg
      categories[shot.category].shots += 1
      total += shot.sg
      totalShots += 1
    })
  })

  let status: RoundStatus
  if (isRangeRound(courseKey, roundId)) status = 'range'
  else if (brokenHoles > 0 && brokenHoles / Math.max(1, holes.length) >= 0.25) status = 'test'
  else if (complete.length >= 18) status = 'full'
  else if (complete.length < 2) status = 'fragment'
  else status = 'partial'

  const parKnown = complete.length > 0 && complete.every((hole) => hole.par != null)
  const summary: RoundSummary = {
    roundId,
    courseKey,
    courseName: course.name?.trim() || prettifyCourseKey(courseKey),
    playedAt,
    status,
    holes,
    holesPlayed: holes.length,
    completeHoles: complete.length,
    strokes: complete.reduce((sum, hole) => sum + hole.strokes, 0),
    par: parKnown ? complete.reduce((sum, hole) => sum + (hole.par ?? 0), 0) : null,
    putts: complete.reduce((sum, hole) => sum + hole.putts, 0),
    gir: {
      hit: complete.filter((hole) => hole.gir === true).length,
      of: complete.filter((hole) => hole.gir != null).length,
    },
    fir: {
      hit: complete.filter((hole) => hole.fir === true).length,
      of: complete.filter((hole) => hole.fir != null).length,
    },
    sg: { total: totalShots > 0 ? total : null, categories },
    autoPutt,
    countState: flags.countState ?? null,
    looksLikeTest: false,
    counts: false,
    unknownLieShots: holes.reduce(
      (sum, hole) => sum + hole.shots.filter((shot) => shot.provisional).length,
      0,
    ),
    brokenHoles,
    shotCount: records.length,
  }
  summary.looksLikeTest = roundLooksLikeTest(summary)
  summary.counts = roundCounts(summary, summary.countState)
  return summary
}

export const buildRounds = (
  records: RoundShotRecord[],
  courses: Readonly<Record<string, CourseInfo>> = {},
  flags: Readonly<Record<number, RoundFlags>> = {},
): RoundSummary[] => {
  const byRound = new Map<number, RoundShotRecord[]>()
  records.forEach((record) => {
    const list = byRound.get(record.roundId) ?? []
    list.push(record)
    byRound.set(record.roundId, list)
  })
  return [...byRound.entries()]
    .map(([roundId, list]) => {
      const courseKey = list.find((record) => record.courseKey)?.courseKey ?? ''
      return buildRound(roundId, list, courses[courseKey] ?? {}, flags[roundId] ?? {})
    })
    .sort((a, b) => (b.playedAt ?? '').localeCompare(a.playedAt ?? ''))
}

/** Shots on complete holes, the only ones whose strokes gained can be trusted. */
export const scoredShots = (round: RoundSummary) =>
  round.holes.filter((hole) => hole.complete).flatMap((hole) => hole.shots)

/** Largest per-shot gains and the largest loss: "the round in three shots". */
export const keyShots = (round: RoundSummary, gains = 2, losses = 1) => {
  const shots = scoredShots(round).filter((shot) => shot.sg != null)
  const sorted = [...shots].sort((a, b) => (b.sg ?? 0) - (a.sg ?? 0))
  const best = sorted.filter((shot) => (shot.sg ?? 0) > 0).slice(0, gains)
  const worst = sorted.reverse().filter((shot) => (shot.sg ?? 0) < 0).slice(0, losses)
  return { best, worst }
}

export type ShotMapPoint = Readonly<{ right: number; forward: number }>

/**
 * Hole shots in yards with the first shot's start at the origin and the pin
 * straight up the page (+forward). Works on any course: it only needs GSPro's
 * own positions.
 */
export const holeShotMap = (hole: RoundHole) => {
  const first = hole.shots[0]?.start
  const pin = hole.pin ?? hole.shots[hole.shots.length - 1]?.end ?? null
  if (!first || !pin) return null
  const angle = Math.atan2(pin.x - first.x, pin.z - first.z)
  const toLocal = (point: WorldPoint): ShotMapPoint => {
    const dx = point.x - first.x
    const dz = point.z - first.z
    return {
      right: (dx * Math.cos(angle) - dz * Math.sin(angle)) * METERS_TO_YARDS,
      forward: (dx * Math.sin(angle) + dz * Math.cos(angle)) * METERS_TO_YARDS,
    }
  }
  return {
    tee: toLocal(first),
    pin: toLocal(pin),
    segments: hole.shots
      .filter((shot) => shot.start && shot.end)
      .map((shot) => ({ shot, from: toLocal(shot.start!), to: toLocal(shot.end!) })),
  }
}

/** Full-swing carries from a clean lie, grouped by club, for "out here vs the range". */
export const onCourseCarriesByClub = (rounds: readonly RoundSummary[]) => {
  const byClub = new Map<string, { carries: number[]; confidences: number[]; armed: number }>()
  rounds
    .filter((round) => round.status === 'full' || round.status === 'partial')
    .flatMap(scoredShots)
    .forEach((shot) => {
      if (shot.isPutt || !shot.club || shot.club === 'Putter') return
      if (shot.startLie !== 'tee' && shot.startLie !== 'fairway') return
      if (shot.carryYards == null || shot.carryYards < 40) return
      const entry = byClub.get(shot.club) ?? { carries: [], confidences: [], armed: 0 }
      entry.carries.push(shot.carryYards)
      if (shot.clubSource === 'armed') entry.armed += 1
      else if (shot.clubConfidence != null) entry.confidences.push(shot.clubConfidence)
      byClub.set(shot.club, entry)
    })
  return byClub
}

export const median = (values: readonly number[]) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// ---- record adapters -------------------------------------------------------

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const num = (value: unknown): number | null => {
  if (finite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}
const point = (value: unknown): WorldPoint | null => {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const x = num(v.x)
  const y = num(v.y)
  const z = num(v.z)
  return x != null && y != null && z != null ? { x, y, z } : null
}
const bool = (value: unknown) => value === true || value === 'true'

/** A `live_course_shots` row from Supabase. */
export type LiveCourseShotRow = {
  gspro_round_id: number
  course_key: string | null
  hole_number: number
  hole_shot: number | null
  observed_at: string | null
  starting_surface_raw: number | null
  ending_surface_raw: number | null
  distance_to_pin_yards: number | null
  carry_yards: number | null
  total_yards: number | null
  spin_axis_degrees: number | null
  gspro_club_index: number | null
  raw_metrics: Record<string, unknown> | null
  actual_club: string | null
  club_source: string | null
  inferred_club: string | null
  inference_confidence: number | null
  recommended_club: string | null
  paper_cost_strokes?: number | null
  model_basis?: string | null
}

export const recordFromCloudRow = (row: LiveCourseShotRow): RoundShotRecord => {
  const raw = row.raw_metrics ?? {}
  const armed = row.club_source === 'user' && row.actual_club != null
  return {
    roundId: row.gspro_round_id,
    courseKey: row.course_key,
    holeNumber: row.hole_number,
    holeShot: row.hole_shot ?? 0,
    observedAt: row.observed_at,
    startSurface: num(row.starting_surface_raw),
    endSurface: num(row.ending_surface_raw),
    distanceToPinYds: num(row.distance_to_pin_yards),
    carryYards: num(row.carry_yards),
    totalYards: num(row.total_yards),
    spinAxisDegrees: num(row.spin_axis_degrees),
    gsproClubIndex: num(row.gspro_club_index),
    isHoled: bool(raw.isHoled),
    isGimme: bool(raw.isGimme),
    start: point(raw.startingPositionMeters),
    end: point(raw.endingPositionMeters),
    club: armed ? row.actual_club : row.inferred_club ?? row.actual_club,
    clubSource: armed ? 'armed' : row.inferred_club ? 'inferred' : null,
    clubConfidence: armed ? 1 : num(row.inference_confidence),
    recommendedClub: row.recommended_club,
    paperCostStrokes: num(row.paper_cost_strokes),
    modelBasis: row.model_basis ?? null,
  }
}

/** A shot from the browser's local round archive (same data before cloud sync). */
export type ArchivedShotLike = {
  roundId: number
  courseKey: string | null
  holeNumber: number
  holeShot: number | null
  observedAt?: string | null
  startingSurfaceRaw: number | null
  endingSurfaceRaw: number | null
  distanceToPinYds: number | null
  carryYards: number | null
  totalYards: number | null
  spinAxisDegrees: number | null
  gsproClubIndex: number | null
  isHoled: boolean
  isGimme: boolean
  rawMetrics: Record<string, unknown>
  actualClub?: string | null
  clubSource?: 'user' | null
  recommendedClub?: string | null
  paperCostStrokes?: number | null
  modelBasis?: string | null
  clubInference?: { predictedClub?: string | null; confidence?: number | null } | null
}

export const recordFromArchivedShot = (shot: ArchivedShotLike): RoundShotRecord => {
  const armed = shot.clubSource === 'user' && shot.actualClub != null
  const inferred = shot.clubInference?.predictedClub ?? null
  return {
    roundId: shot.roundId,
    courseKey: shot.courseKey,
    holeNumber: shot.holeNumber,
    holeShot: shot.holeShot ?? 0,
    observedAt: shot.observedAt ?? null,
    startSurface: shot.startingSurfaceRaw,
    endSurface: shot.endingSurfaceRaw,
    distanceToPinYds: shot.distanceToPinYds,
    carryYards: shot.carryYards,
    totalYards: shot.totalYards,
    spinAxisDegrees: shot.spinAxisDegrees,
    gsproClubIndex: shot.gsproClubIndex,
    isHoled: shot.isHoled,
    isGimme: shot.isGimme,
    start: point(shot.rawMetrics?.startingPositionMeters),
    end: point(shot.rawMetrics?.endingPositionMeters),
    club: armed ? shot.actualClub ?? null : inferred ?? shot.actualClub ?? null,
    clubSource: armed ? 'armed' : inferred ? 'inferred' : null,
    clubConfidence: armed ? 1 : shot.clubInference?.confidence ?? null,
    recommendedClub: shot.recommendedClub ?? null,
    paperCostStrokes: shot.paperCostStrokes ?? null,
    modelBasis: shot.modelBasis ?? null,
  }
}
