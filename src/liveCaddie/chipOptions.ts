/**
 * Around the green: the four chip shots, each sized to finish at the hole.
 *
 * Flight comes from GSPro itself: the same four shots fired at Briarwood West on 20 Nov (bump 12°, chip 20°,
 * pitch 28°, flop 40° launch; TrackMan-typical spin rising with ball speed), carry 5 to 43 yd. Release comes
 * from the chip fit in greenReleaseModel (landing on the green; a chip landing in the fairway is read as a
 * green of the fairway's grass and firmness, 1.2 yd mean on shots not in the fit).
 *
 * Every option is shown. A verdict only when there's a reason (Brian, 21 Nov): the flop is for tight windows
 * (short-sided, downhill, must stop), otherwise it's the hardest distance to judge; a shot that would land in
 * rough, sand or water is flagged. The rest are "pick what you're comfortable with".
 */
import {
  greenReleaseFromLanding,
  greenReleaseOnSlope,
  greenReleaseShape,
  type GreenConditions,
} from './greenReleaseModel'
import { sidehillLieShare, upDownLieShare } from './lieResponse'
import { puttSpeedFor, rollOnGreen, type SlopeField } from './puttRead'
import { sandSpeedFactor, sandSpinFactor } from './surfaceResponse'

export type ChipType = 'bump' | 'chip' | 'pitch' | 'flop'
export const CHIP_TYPES: readonly ChipType[] = ['bump', 'chip', 'pitch', 'flop']
export const CHIP_LAUNCH_DEG: Readonly<Record<ChipType, number>> = { bump: 12, chip: 20, pitch: 28, flop: 40 }
export const CHIP_LABEL: Readonly<Record<ChipType, string>> = { bump: 'Bump and run', chip: 'Chip', pitch: 'Pitch', flop: 'Flop' }
/** Chip cards take over from the club recommendation inside this distance, off the green. */
export const CHIP_ZONE_YDS = 40
/** Looper's green ending closer than this to the pin, on the ball's side, is probably a short outline. */
export const GREEN_EDGE_DOUBT_YDS = 5

/** GSPro, 20 Nov: [ball speed mph, launch spin rpm, carry yd, landing speed mph, descent deg, landing spin rpm]. */
const FLIGHT: Readonly<Record<ChipType, readonly (readonly number[])[]>> = {
  bump: [[23.6, 903, 4.99, 22.94, 10.54, 888], [26.0, 994, 5.77, 24.86, 8.84, 977], [28.2, 1078, 7.26, 27.06, 10.72, 1056],
    [31.6, 1207, 9.31, 30.06, 10.99, 1179], [34.0, 1301, 10.98, 31.93, 11.27, 1270], [36.5, 1396, 12.27, 33.89, 9.87, 1358],
    [41.5, 1585, 16.82, 37.83, 11.37, 1537], [60.6, 2318, 34.15, 50.15, 9.57, 2210], [65.9, 2518, 42.93, 52.31, 10.52, 2384]],
  chip: [[18.9, 1389, 4.98, 18.14, 18.87, 1361], [20.8, 1529, 5.53, 19.98, 15.54, 1493], [22.6, 1662, 6.91, 21.92, 17.86, 1617],
    [26.0, 1910, 9.56, 24.62, 19.41, 1852], [27.3, 2006, 10.59, 25.38, 19.58, 1945], [29.9, 2196, 12.41, 27.31, 18.45, 2122],
    [33.9, 2494, 16.5, 30.64, 20.05, 2394], [48.5, 3566, 32.85, 39.28, 19.74, 3365], [53.8, 3956, 41.19, 41.54, 20.93, 3696]],
  pitch: [[16.7, 2083, 4.8, 16.78, 25.86, 2027], [18.4, 2293, 5.83, 17.4, 25.68, 2231], [20.4, 2535, 7.39, 19.3, 27.53, 2458],
    [22.6, 2817, 9.09, 21.11, 27.87, 2723], [24.6, 3059, 10.79, 22.76, 28.19, 2947], [25.7, 3199, 11.52, 23.04, 27.16, 3081],
    [30.3, 3768, 16.36, 27.14, 28.93, 3593], [43.0, 5349, 31.71, 34.46, 29.69, 4997], [48.6, 6049, 40.45, 37.31, 31.46, 5574]],
  flop: [[15.4, 1805, 4.96, 14.8, 39.58, 1751], [17.0, 1987, 5.88, 16.24, 38.44, 1920], [18.5, 2162, 7.11, 17.76, 39.9, 2083],
    [20.9, 2453, 8.93, 20.56, 39.94, 2347], [22.3, 2609, 10.27, 20.57, 40.65, 2496], [23.6, 2768, 11.22, 21.8, 39.76, 2639],
    [28.2, 3298, 16.13, 25.56, 41.57, 3112], [39.6, 4635, 30.08, 32.76, 43.06, 4271], [46.0, 5388, 39.22, 36.78, 45.08, 4881]],
}

export type ChipFlight = Readonly<{
  carryYds: number
  ballSpeedMph: number
  spinRpm: number
  landing: Readonly<{ speedMph: number; descentDeg: number; spinRpm: number }>
}>

/**
 * The flight that carries `carryYds`. `launchDeltaDeg` is what the slope under the ball adds to the
 * launch (+ off an upslope): the same carry then comes in steeper and slower, like the next shot up,
 * so it runs less; off a downslope it comes in like the next shot down and runs more. The spin stays
 * this shot's own (per mph), since the swing hasn't changed.
 */
export const chipFlight = (type: ChipType, carryYds: number, launchDeltaDeg = 0): ChipFlight => {
  const base = measuredChipFlight(type, carryYds)
  if (Math.abs(launchDeltaDeg) < 0.25) return base
  const launch = Math.max(CHIP_LAUNCH_DEG.bump, Math.min(CHIP_LAUNCH_DEG.flop, CHIP_LAUNCH_DEG[type] + launchDeltaDeg))
  const upper = CHIP_TYPES.find((t) => CHIP_LAUNCH_DEG[t] >= launch) ?? 'flop'
  const lower = CHIP_TYPES[Math.max(0, CHIP_TYPES.indexOf(upper) - 1)]
  if (upper === lower) return base
  const a = measuredChipFlight(lower, base.carryYds)
  const b = measuredChipFlight(upper, base.carryYds)
  const t = (launch - CHIP_LAUNCH_DEG[lower]) / (CHIP_LAUNCH_DEG[upper] - CHIP_LAUNCH_DEG[lower])
  const mix = (x: number, y: number) => x + (y - x) * t
  const ballSpeedMph = mix(a.ballSpeedMph, b.ballSpeedMph)
  const spinPerMph = base.spinRpm / base.ballSpeedMph
  return {
    carryYds: base.carryYds,
    ballSpeedMph,
    spinRpm: spinPerMph * ballSpeedMph,
    landing: {
      speedMph: mix(a.landing.speedMph, b.landing.speedMph),
      descentDeg: mix(a.landing.descentDeg, b.landing.descentDeg),
      spinRpm: (base.landing.spinRpm / base.ballSpeedMph) * ballSpeedMph,
    },
  }
}

/** The flight as GSPro measured it from a level lie, interpolated between the measured shots. */
const measuredChipFlight = (type: ChipType, carryYds: number): ChipFlight => {
  const rows = FLIGHT[type]
  const c = Math.max(rows[0][2] * 0.5, Math.min(rows[rows.length - 1][2], carryYds))
  let i = rows.findIndex((row) => row[2] >= c)
  if (i <= 0) i = 1
  const [a, b] = [rows[i - 1], rows[i]]
  // Below the shortest shot, scale down from it (speed and spin roughly as carry^0.53).
  const t = c < a[2] ? 0 : (c - a[2]) / (b[2] - a[2])
  const lerp = (k: number) => a[k] + (b[k] - a[k]) * t
  const shrink = c < a[2] ? (c / a[2]) ** 0.53 : 1
  return {
    carryYds: c,
    ballSpeedMph: lerp(0) * shrink,
    spinRpm: lerp(1) * shrink,
    landing: { speedMph: lerp(3) * shrink, descentDeg: lerp(4), spinRpm: lerp(5) * shrink },
  }
}

export type LandingSurface = 'green' | 'fairway' | 'fringe' | 'rough' | 'deep-rough' | 'bunker' | 'water' | 'other'

/** What the ball lands on `carryYds` along the line to the hole, and the slope it then rolls over. */
export type LandingProbe = (carryYds: number) => Readonly<{
  surface: LandingSurface
  /** Rise over run from the landing spot to the hole (+ uphill), when the green map has it. */
  gradeToHole: number | null
  /** Sand or water within a few yards either side of the landing spot, when there is any. */
  sideTrouble?: LandingSurface | null
  /** Height of the landing spot above (+) or below (-) the ball, feet, when known. */
  riseFt?: number | null
}>

export type ChipSetting = Readonly<{
  green: GreenConditions
  fairway: Readonly<{ courseType: GreenConditions['courseType']; fairwayFirmness: GreenConditions['greenFirmness'] }>
  /** Hit from the rough: about a third less spin (GSPro's rough), so a little more run. */
  fromRough: boolean
  /**
   * Hit from sand: only the pitch and flop are offered. GSPro takes about a quarter of a short
   * shot's speed, so the card says how big a swing it takes; spin is scaled by GSPro's sand numbers.
   */
  fromSand?: boolean
  /** Slope under the ball along the shot, degrees (+ uphill): changes the launch, so the run. */
  lieUpDownDeg?: number | null
}>

const ROUGH = { speed: 0.97, spin: 0.68 }

export type ChipOption = Readonly<{
  type: ChipType
  launchDeg: number
  flight: ChipFlight
  /** Yards it runs after landing. */
  runYds: number
  landsOn: LandingSurface
  /** The trouble it flies over on the way, and how far past it the ball lands. */
  carries: Readonly<{ surface: LandingSurface; overYds: number; landsPastYds: number }> | null
  /**
   * good: Looper's pick (the lowest shot that lands on the green and stops at the hole);
   * fine: also lands on the green; short: lands short of the green and runs on (the bank and the
   * apron decide it); not-needed: the flop when a lower shot lands on the green; avoid: trouble.
   */
  verdict: 'good' | 'fine' | 'short' | 'not-needed' | 'avoid'
  reason: string | null
  /** From sand: the clean-lie carry of the swing this takes ("swing it like a 27 yd pitch"). */
  swingLikeYds: number | null
  /** Height of the landing spot above (+) or below (-) the ball, feet; null when not known. */
  landingRiseFt: number | null
  /** The carry this swing flies on level ground: more than `flight.carryYds` when landing uphill. */
  levelCarryYds: number
  /** The ball as it leaves the lie for that swing (ball data). */
  swingFlight: ChipFlight
}>

/**
 * The level-ground carry of a flight that lands `carryYds` out on ground `riseFt` above the ball.
 * The flight is taken as a parabola through the ball whose slope at its level landing is the shot's
 * measured descent: landing higher cuts it off sooner, so it needs a longer level carry (and lower,
 * a shorter one). 2.5 ft up on a 29 yd pitch: about 30.5. Capped where the flight can't climb that high.
 */
export const levelCarryFor = (carryYds: number, descentDeg: number, riseFt: number | null | undefined) => {
  if (riseFt == null || !Number.isFinite(riseFt) || Math.abs(riseFt) < 0.1 || !(carryYds > 0)) return carryYds
  const slope = Math.tan((descentDeg * Math.PI) / 180)
  const d = carryYds * 3
  const denom = slope * d - riseFt
  if (denom <= slope * d * 0.25) return carryYds * 1.6
  return Math.min(carryYds * 1.6, Math.max(carryYds * 0.6, (slope * d * d) / denom / 3))
}

/** The raw (before the sand) ball speed that leaves the sand at `afterMph`. */
const rawSpeedFromSand = (afterMph: number) => {
  let raw = afterMph / 0.8
  for (let i = 0; i < 8; i += 1) raw = afterMph / sandSpeedFactor(raw)
  return raw
}

/** The clean-lie carry of a chip hit at `ballSpeedMph`. */
const carryForSpeed = (type: ChipType, ballSpeedMph: number) => {
  const rows = FLIGHT[type]
  if (ballSpeedMph <= rows[0][0]) return rows[0][2] * (ballSpeedMph / rows[0][0]) ** (1 / 0.53)
  for (let i = 1; i < rows.length; i += 1) {
    if (ballSpeedMph <= rows[i][0]) {
      const t = (ballSpeedMph - rows[i - 1][0]) / (rows[i][0] - rows[i - 1][0])
      return rows[i - 1][2] + (rows[i][2] - rows[i - 1][2]) * t
    }
  }
  return rows[rows.length - 1][2]
}

/**
 * What the lie does to a chip. Side slope starts the ball off line (more for the low shots), so the
 * aim moves the other way; an up or down slope changes the launch.
 * `lieLeftRightDeg` is + when the ball will start left; `lieUpDownDeg` is + uphill.
 */
export const chipLieRead = (
  option: Pick<ChipOption, 'launchDeg'>,
  distanceYds: number,
  lieLeftRightDeg: number | null,
  lieUpDownDeg: number | null,
) => {
  const startLeftDeg = lieLeftRightDeg == null ? 0 : lieLeftRightDeg * sidehillLieShare(option.launchDeg)
  return {
    /** Feet to aim left (+) or right (-) of the pin to cancel the lie. */
    aimLeftFt: -distanceYds * 3 * Math.sin((startLeftDeg * Math.PI) / 180),
    /** Degrees the ball launches higher (+) or lower (-) than the card's launch. */
    launchDeltaDeg: lieUpDownDeg == null ? 0 : lieUpDownDeg * upDownLieShare(option.launchDeg),
  }
}

const SURFACE_NAME: Readonly<Record<LandingSurface, string>> = {
  green: 'green', fairway: 'fairway', fringe: 'fringe', rough: 'rough', 'deep-rough': 'deep rough', bunker: 'bunker', water: 'water', other: 'trouble',
}

const BAD_LANDING: Partial<Record<LandingSurface, string>> = {
  rough: 'Lands in the rough', 'deep-rough': 'Lands in deep rough', bunker: 'Lands in the bunker', water: 'Lands in the water', other: 'Lands off the short grass',
}

/**
 * A chip has to land at least this far past sand, water or rough it flies over (Brian, 21 Nov: the
 * first card landed on the bunker's lip). A yard or two short is an ordinary miss with a chip.
 */
export const CLEAR_TROUBLE_YDS = 2.5

/** The last stretch of trouble on the line before `carry`: where it ends, or null if the line is clean. */
const troubleBefore = (carry: number, probe: LandingProbe) => {
  let end: number | null = null
  let surface: LandingSurface | null = null
  for (let at = 0.5; at < carry; at += 0.5) {
    const kind = probe(at).surface
    if (BAD_LANDING[kind] && kind !== 'other') {
      end = at
      surface = kind
    }
  }
  return end == null || surface == null ? null : { end, surface }
}

const releaseFor = (type: ChipType, carry: number, probe: LandingProbe, setting: ChipSetting) => {
  const flight = chipFlight(type, carry, (setting.lieUpDownDeg ?? 0) * upDownLieShare(CHIP_LAUNCH_DEG[type]))
  // From sand the flight is the ball as it leaves the sand; its spin is GSPro's sand share of the bigger swing's.
  const sandSpin = setting.fromSand
    ? (() => { const raw = rawSpeedFromSand(flight.ballSpeedMph); return sandSpinFactor(raw) / sandSpeedFactor(raw) })()
    : 1
  const landing = setting.fromSand
    ? { ...flight.landing, spinRpm: flight.landing.spinRpm * sandSpin }
    : setting.fromRough
      ? { speedMph: flight.landing.speedMph * ROUGH.speed, descentDeg: flight.landing.descentDeg, spinRpm: flight.landing.spinRpm * ROUGH.spin }
      : flight.landing
  const at = probe(carry)
  // Rough, sand and water landings weren't measured; take them as stopping where they land, so sizing
  // carries the ball over them onto short grass where it can. Landing just past them counts as in them.
  if (BAD_LANDING[at.surface]) return { flight, run: 0, landsOn: at.surface, grade: at.gradeToHole }
  const trouble = troubleBefore(carry, probe)
  if (trouble && carry - trouble.end < CLEAR_TROUBLE_YDS) {
    return { flight, run: 0, landsOn: trouble.surface, grade: at.gradeToHole }
  }
  // A chip landing in the fairway runs about as it would on a green of the fairway's grass and firmness.
  const conditions: GreenConditions = at.surface === 'green'
    ? setting.green
    : { courseType: setting.fairway.courseType, greenFirmness: setting.fairway.fairwayFirmness, stimp: setting.green.stimp }
  const level = greenReleaseFromLanding(landing, conditions)
  const run = at.gradeToHole != null
    ? greenReleaseOnSlope(level, at.gradeToHole, setting.green.stimp ?? null, greenReleaseShape(landing, conditions))
    : level
  return { flight, run: Math.max(0, run), landsOn: at.surface, grade: at.gradeToHole }
}

/** Size a chip type to finish at the hole `distanceYds` away. */
export const sizeChip = (type: ChipType, distanceYds: number, probe: LandingProbe, setting: ChipSetting) => {
  let lo = FLIGHT[type][0][2] * 0.5
  let hi = Math.min(distanceYds, FLIGHT[type][FLIGHT[type].length - 1][2])
  if (releaseFor(type, hi, probe, setting).run + hi < distanceYds) return { ...releaseFor(type, hi, probe, setting), short: true, tooHot: false }
  // Even the softest one runs well past: the slope or the ground won't let this shot stop at the hole.
  const softest = releaseFor(type, lo, probe, setting)
  if (lo + softest.run > distanceYds + 1) return { ...softest, short: false, tooHot: true }
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2
    const { run } = releaseFor(type, mid, probe, setting)
    if (mid + run < distanceYds) lo = mid
    else hi = mid
  }
  const at = releaseFor(type, (lo + hi) / 2, probe, setting)
  // Stuck on the edge of trouble: the answer is the first carry onto short grass.
  if (BAD_LANDING[at.landsOn]) {
    for (let carry = hi + 0.05; carry <= hi + CLEAR_TROUBLE_YDS + 0.6; carry += 0.25) {
      const over = releaseFor(type, carry, probe, setting)
      if (!BAD_LANDING[over.landsOn]) return { ...over, short: false, tooHot: false }
    }
  }
  return { ...at, short: false, tooHot: false }
}

/** A chip that lands on the green lands at least this far onto it (Brian, 21 Nov: land on the green first). */
export const ONTO_GREEN_YDS = 2

/**
 * The four options for a chip of `distanceYds`, each sized to finish at the hole.
 *
 * Landing on the green comes first (Brian, 21 Nov): the apron, the bank and the bunkers beside it
 * are what make a chip hard to judge, and the green is the one surface measured for release. So
 * Looper's pick is the lowest shot that lands at least ONTO_GREEN_YDS onto the green and still stops
 * at the hole. A low shot that would have to land short to stop is offered as "short", never the pick.
 * The flop is the pick only when nothing lower lands on the green and stops.
 *
 * `greenToWorkWithYds` is green between where the line first reaches the green and the hole.
 */
export const chipOptions = (
  distanceYds: number,
  probe: LandingProbe,
  setting: ChipSetting,
  greenToWorkWithYds: number | null,
): ChipOption[] => {
  const sized = CHIP_TYPES.map((type) => ({ type, ...sizeChip(type, distanceYds, probe, setting) }))
  const greenStarts = greenToWorkWithYds == null ? null : distanceYds - greenToWorkWithYds
  const finish = (s: (typeof sized)[number]) => s.flight.carryYds + s.run

  const judged = sized.map((s) => {
    const bad = BAD_LANDING[s.landsOn]
    const side = probe(s.flight.carryYds).sideTrouble ?? null
    const onGreen = s.landsOn === 'green' && (greenStarts == null || s.flight.carryYds - greenStarts >= ONTO_GREEN_YDS - 0.25)
    let verdict: ChipOption['verdict']
    let reason: string | null = null
    if (setting.fromSand && (s.type === 'bump' || s.type === 'chip')) {
      verdict = 'avoid'
      reason = 'Not from sand: it takes loft to get out.'
    } else if (bad) {
      verdict = 'avoid'
      reason = `${bad} or too close to it to trust.`
    } else if (s.short) {
      verdict = 'avoid'
      reason = 'Can’t get there with this shot.'
    } else if (s.tooHot) {
      verdict = 'avoid'
      reason = `Runs past even landed as short as it can: about ${Math.round(finish(s) - distanceYds)} yd by.`
    } else if (finish(s) > distanceYds + 1) {
      verdict = 'avoid'
      reason = `Lands on the ${SURFACE_NAME[s.landsOn]} and runs about ${Math.round(finish(s) - distanceYds)} yd past.`
    } else if (onGreen) {
      verdict = 'fine'
    } else if (side && s.landsOn !== 'green') {
      verdict = 'avoid'
      reason = `Lands short of the green with the ${SURFACE_NAME[side]} right beside it.`
    } else {
      verdict = 'short'
      reason = s.landsOn === 'green'
        ? 'Lands on the front edge of the green: a yard short and the apron decides it.'
        : greenStarts != null
          ? `Lands ${Math.max(1, Math.round(greenStarts - s.flight.carryYds))} yd short of the green and runs on: the bank decides it.`
          : 'Lands short of the green and runs on: the bank decides it.'
    }
    return { s, verdict: verdict as ChipOption['verdict'], reason }
  })

  // Looper's pick: the lowest shot that lands on the green and stops.
  const pick = judged.find((j) => j.verdict === 'fine')
  if (pick) {
    pick.verdict = 'good'
    pick.reason = pick.s.type === 'flop'
      ? 'The only shot that lands on the green and stops.'
      : 'Lands on the green and stops: the lowest shot that does.'
  }
  const flop = judged.find((j) => j.s.type === 'flop')
  if (flop && pick && pick !== flop && flop.verdict === 'fine') {
    flop.verdict = 'not-needed'
    flop.reason = 'Not needed here: a lower shot lands on the green too.'
  }

  return judged.map(({ s, verdict, reason }) => {
    const trouble = verdict === 'avoid' && BAD_LANDING[s.landsOn] ? null : troubleBefore(s.flight.carryYds, probe)
    const carryNote = trouble
      ? setting.fromSand && trouble.surface === 'bunker'
        ? `Out of the bunker: lands ${Math.round(s.flight.carryYds - trouble.end)} yd past its edge.`
        : `Carries the ${SURFACE_NAME[trouble.surface]}: lands ${Math.round(s.flight.carryYds - trouble.end)} yd past it.`
      : null
    const landingRiseFt = probe(s.flight.carryYds).riseFt ?? null
    const levelCarryYds = levelCarryFor(s.flight.carryYds, s.flight.landing.descentDeg, landingRiseFt)
    const swingFlight = Math.abs(levelCarryYds - s.flight.carryYds) < 0.05 ? s.flight
      : chipFlight(s.type, levelCarryYds, (setting.lieUpDownDeg ?? 0) * upDownLieShare(CHIP_LAUNCH_DEG[s.type]))
    return {
      type: s.type,
      launchDeg: CHIP_LAUNCH_DEG[s.type],
      flight: s.flight,
      runYds: s.run,
      landsOn: s.landsOn,
      carries: trouble ? { surface: trouble.surface, overYds: trouble.end, landsPastYds: s.flight.carryYds - trouble.end } : null,
      verdict,
      reason: carryNote && verdict !== 'avoid' ? (reason ? `${reason} ${carryNote}` : carryNote) : reason,
      swingLikeYds: setting.fromSand && verdict !== 'avoid'
        ? carryForSpeed(s.type, rawSpeedFromSand(swingFlight.ballSpeedMph)) : null,
      landingRiseFt,
      levelCarryYds,
      swingFlight,
    }
  })
}

/**
 * How far left (+) or right (-) of the pin to aim a chip so its run breaks to the hole, in feet.
 *
 * The run is rolled across the green's slope like a putt (rollOnGreen: GSPro's putting friction and
 * 68% of gravity along the slope), starting where the chip lands at the pace that rolls its run on a
 * level green. An estimate: a chip's first bounces don't take break like a rolling ball, and the roll
 * maths hasn't been checked against GSPro's own putts yet. Null when the green map doesn't cover it.
 */
export const chipBreakAimFt = (
  slope: SlopeField,
  ball: readonly [number, number],
  pin: readonly [number, number],
  option: Pick<ChipOption, 'flight' | 'runYds'>,
  stimp: number | null | undefined,
): number | null => {
  const distance = Math.hypot(pin[0] - ball[0], pin[1] - ball[1])
  if (!(distance > 1) || !(option.runYds > 0.5)) return 0
  const speed = puttSpeedFor(option.runYds * 3, stimp)
  if (speed == null) return null
  const base = (Math.atan2(pin[0] - ball[0], pin[1] - ball[1]) * 180) / Math.PI
  const fx = (pin[0] - ball[0]) / distance
  const fy = (pin[1] - ball[1]) / distance
  /** Where the roll passes the hole, yards right (+) of the ball-to-pin line; null off the map. */
  const missRight = (offsetDeg: number): number | null => {
    const rad = ((base + offsetDeg) * Math.PI) / 180
    const landing: [number, number] = [ball[0] + Math.sin(rad) * option.flight.carryYds, ball[1] + Math.cos(rad) * option.flight.carryYds]
    if (!slope(landing)) return null
    const roll = rollOnGreen(slope, landing, base + offsetDeg, speed, stimp, pin)
    let best: readonly [number, number] = roll.end
    let bestD = Infinity
    for (const point of roll.path) {
      const d = Math.hypot(point[0] - pin[0], point[1] - pin[1])
      if (d < bestD) { bestD = d; best = point }
    }
    return (best[0] - pin[0]) * fy - (best[1] - pin[1]) * fx
  }
  let lo = -20
  let hi = 20
  const atLo = missRight(lo)
  const atHi = missRight(hi)
  if (atLo == null || atHi == null || atLo > 0 || atHi < 0) {
    const straight = missRight(0)
    // Can't bracket it: fall back to the straight shot's miss, mirrored.
    return straight == null ? null : straight * 3
  }
  for (let i = 0; i < 14; i += 1) {
    const mid = (lo + hi) / 2
    const miss = missRight(mid)
    if (miss == null) return null
    if (miss < 0) lo = mid
    else hi = mid
  }
  // A heading right of the pin is a negative "aim left".
  return -distance * 3 * Math.tan((((lo + hi) / 2) * Math.PI) / 180)
}
