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

export type ChipType = 'bump' | 'chip' | 'pitch' | 'flop'
export const CHIP_TYPES: readonly ChipType[] = ['bump', 'chip', 'pitch', 'flop']
export const CHIP_LAUNCH_DEG: Readonly<Record<ChipType, number>> = { bump: 12, chip: 20, pitch: 28, flop: 40 }
export const CHIP_LABEL: Readonly<Record<ChipType, string>> = { bump: 'Bump and run', chip: 'Chip', pitch: 'Pitch', flop: 'Flop' }
/** Chip cards take over from the club recommendation inside this distance, off the green. */
export const CHIP_ZONE_YDS = 40

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

/** The flight that carries `carryYds`, interpolated between the measured shots. */
export const chipFlight = (type: ChipType, carryYds: number): ChipFlight => {
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
}>

export type ChipSetting = Readonly<{
  green: GreenConditions
  fairway: Readonly<{ courseType: GreenConditions['courseType']; fairwayFirmness: GreenConditions['greenFirmness'] }>
  /** Hit from the rough: about a third less spin (GSPro's rough), so a little more run. */
  fromRough: boolean
}>

const ROUGH = { speed: 0.97, spin: 0.68 }

export type ChipOption = Readonly<{
  type: ChipType
  launchDeg: number
  flight: ChipFlight
  /** Yards it runs after landing. */
  runYds: number
  landsOn: LandingSurface
  verdict: 'good' | 'fine' | 'not-needed' | 'avoid'
  reason: string | null
}>

const BAD_LANDING: Partial<Record<LandingSurface, string>> = {
  rough: 'Lands in the rough', 'deep-rough': 'Lands in deep rough', bunker: 'Lands in the bunker', water: 'Lands in the water', other: 'Lands off the short grass',
}

const releaseFor = (type: ChipType, carry: number, probe: LandingProbe, setting: ChipSetting) => {
  const flight = chipFlight(type, carry)
  const landing = setting.fromRough
    ? { speedMph: flight.landing.speedMph * ROUGH.speed, descentDeg: flight.landing.descentDeg, spinRpm: flight.landing.spinRpm * ROUGH.spin }
    : flight.landing
  const at = probe(carry)
  // Rough, sand and water landings weren't measured; take them as stopping where they land, so sizing
  // carries the ball over them onto short grass where it can.
  if (BAD_LANDING[at.surface]) return { flight, run: 0, landsOn: at.surface, grade: at.gradeToHole }
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
    const over = releaseFor(type, hi + 0.05, probe, setting)
    if (!BAD_LANDING[over.landsOn]) return { ...over, short: false, tooHot: false }
  }
  return { ...at, short: false, tooHot: false }
}

/**
 * The four options for a chip of `distanceYds`. `greenToWorkWithYds` is green between where the ball first
 * reaches the green and the hole, along the line (short-sided when small).
 */
export const chipOptions = (
  distanceYds: number,
  probe: LandingProbe,
  setting: ChipSetting,
  greenToWorkWithYds: number | null,
): ChipOption[] => {
  const sized = CHIP_TYPES.map((type) => ({ type, ...sizeChip(type, distanceYds, probe, setting) }))
  const holeGrade = probe(distanceYds).gradeToHole
  const lastGrade = sized.map((s) => s.grade).find((g) => g != null) ?? holeGrade
  const downhill = lastGrade != null && lastGrade < -0.02
  const shortSided = greenToWorkWithYds != null && greenToWorkWithYds < 6
  const othersBlocked = sized.filter((s) => s.type !== 'flop').every((s) => BAD_LANDING[s.landsOn] || s.tooHot)
  const tight = downhill || shortSided || othersBlocked
  return sized.map((s) => {
    const bad = BAD_LANDING[s.landsOn]
    let verdict: ChipOption['verdict'] = 'fine'
    let reason: string | null = null
    if (bad) {
      verdict = 'avoid'
      reason = `${bad}: GSPro's chips weren't measured landing there.`
    } else if (s.short) {
      verdict = 'avoid'
      reason = 'Can’t get there with this shot.'
    } else if (s.flight.carryYds + s.run > distanceYds + 1) {
      verdict = 'avoid'
      reason = `Has to carry onto the green and runs about ${Math.round(s.flight.carryYds + s.run - distanceYds)} yd past.`
    } else if (s.tooHot) {
      verdict = 'avoid'
      reason = `Runs past even landed just over: about ${Math.round(s.flight.carryYds + s.run - distanceYds)} yd by.`
    } else if (s.type === 'flop') {
      if (tight) {
        verdict = 'good'
        reason = shortSided ? 'Short-sided: it stops quickest.' : downhill ? 'Downhill to the hole: it stops quickest.' : 'The only shot that lands on short grass.'
      } else {
        verdict = 'not-needed'
        reason = 'Not needed here: the hardest distance to judge.'
      }
    } else if (tight && downhill && s.run > 2 * s.flight.carryYds) {
      reason = 'Runs a long way downhill: a small miss in pace grows.'
    }
    return {
      type: s.type,
      launchDeg: CHIP_LAUNCH_DEG[s.type],
      flight: s.flight,
      runYds: s.run,
      landsOn: s.landsOn,
      verdict,
      reason,
    }
  })
}
