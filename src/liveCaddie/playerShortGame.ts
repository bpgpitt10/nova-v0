/**
 * The player's own chips and part wedges, read from their rounds (Brian, 24 Nov: the card said
 * Chip at 19° and 1,350 rpm; he hit 25° and 2,242 rpm, our Pitch, and it ran half as far).
 *
 * Each shot is sorted to the nearest of the card's flights by launch. A flight the player hits
 * often enough gets the player's own launch and spin (spin only from clean lies: GSPro saves it
 * after the lie penalty). A flight the player almost never hits keeps GSPro's stock numbers and is
 * never Looper's pick while one the player does hit works.
 *
 * Injected lab shots (test_shots.py, the wander and wedge labs) are left out: they are typed in to a
 * tenth of a mph and a tenth of a degree, and often repeat to the last digit. A launch monitor gives
 * launch to a thousandth and speed to many places, so a real swing almost never lands on both tenths.
 */
import { getCurrentLooperUser, getSupabaseClient, isSupabaseConfigured } from '../cloud/supabaseClient'
import { CHIP_LAUNCH_DEG, CHIP_TYPES, WEDGE_TYPES, type ChipType, type ShotFamily } from './chipOptions'

export type PlayerShortGameShot = Readonly<{
  /** The round it was hit in: the same numbers twice in one round is one shot saved twice. */
  roundKey: string
  shotKey: string
  startSurface: number | null
  ballSpeedMph: number
  launchDeg: number
  spinRpm: number
}>

export type PlayerFlightFit = Readonly<{
  /** Median launch of the player's shots of this flight. */
  launchDeg: number
  /** Median spin per mph of ball speed, clean lies only; null when too few. */
  spinPerMph: number | null
  shots: number
}>

export type PlayerFamilyFit = Readonly<{
  /** The player's shots of this family that were read. */
  total: number
  byType: Readonly<Partial<Record<ChipType, PlayerFlightFit>>>
  /** Flights the player almost never hits (only once there are enough shots to tell). */
  rarely: readonly ChipType[]
}>

export type PlayerShortGame = Readonly<Record<ShotFamily, PlayerFamilyFit>>

/** Chips leave the club under this; part wedges from here to the top of the band. */
export const CHIP_TOP_MPH = 40
export const WEDGE_TOP_MPH = 80
/** Shots of a flight before the player's launch replaces GSPro's. */
export const MIN_FLIGHT_SHOTS = 5
/** Clean-lie shots of a flight before the player's spin replaces GSPro's. */
export const MIN_SPIN_SHOTS = 5
/** Shots of a family before a flight can be called one the player rarely hits. */
export const MIN_FAMILY_SHOTS = 12
/** Under this share of the family, a flight is one the player rarely hits. */
export const RARE_SHARE = 0.1

/** Under this much spin per mph it was thinned or topped: not a flight anyone plays on purpose. */
export const MIN_SPIN_PER_MPH = 40

/** GSPro surface codes: fairway and first cut give spin as hit. */
const CLEAN_SURFACES = new Set([2, 12])
const GREEN = 5
const TEE = 18

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** The card flight nearest this launch, within the family. */
export const nearestFlight = (family: ShotFamily, launchDeg: number): ChipType => {
  const types = family === 'wedge' ? WEDGE_TYPES : CHIP_TYPES
  return types.reduce((best, type) =>
    Math.abs(CHIP_LAUNCH_DEG[type] - launchDeg) < Math.abs(CHIP_LAUNCH_DEG[best] - launchDeg) ? type : best)
}

const familyOfSpeed = (mph: number): ShotFamily | null =>
  mph >= 8 && mph < CHIP_TOP_MPH ? 'chip' : mph >= CHIP_TOP_MPH && mph <= WEDGE_TOP_MPH ? 'wedge' : null

const signature = (shot: PlayerShortGameShot) =>
  `${shot.ballSpeedMph.toFixed(1)}|${shot.launchDeg.toFixed(1)}|${Math.round(shot.spinRpm)}`

/** On a tenth, allowing for GSPro's single-precision floats (27.7 is saved as 27.7000007629). */
const onTenth = (value: number) => Math.abs(value * 10 - Math.round(value * 10)) < 0.005

/** A shot typed into a lab tool rather than swung: speed and launch both on exact tenths. */
export const looksInjected = (shot: Pick<PlayerShortGameShot, 'ballSpeedMph' | 'launchDeg'>) =>
  onTenth(shot.ballSpeedMph) && onTenth(shot.launchDeg)

export const fitPlayerShortGame = (shots: readonly PlayerShortGameShot[]): PlayerShortGame => {
  // One row per shot: the cloud can hold a shot twice (as itself and copied onto the next one).
  const unique = [...new Map(shots.map((shot) => [`${shot.roundKey}|${signature(shot)}`, shot])).values()]
  // The same numbers in two different rounds is a lab shot fired again, not a swing.
  const rounds = new Map<string, Set<string>>()
  unique.forEach((shot) => {
    const key = signature(shot)
    if (!rounds.has(key)) rounds.set(key, new Set())
    rounds.get(key)!.add(shot.roundKey)
  })
  const real = unique.filter((shot) => rounds.get(signature(shot))!.size === 1 && !looksInjected(shot)
    && shot.launchDeg > 3 && shot.launchDeg < 60 && shot.spinRpm / shot.ballSpeedMph >= MIN_SPIN_PER_MPH
    && shot.startSurface !== GREEN && shot.startSurface !== TEE)

  const fitFamily = (family: ShotFamily): PlayerFamilyFit => {
    const mine = real.filter((shot) => familyOfSpeed(shot.ballSpeedMph) === family)
    const types = family === 'wedge' ? WEDGE_TYPES : CHIP_TYPES
    const byType: Partial<Record<ChipType, PlayerFlightFit>> = {}
    const rarely: ChipType[] = []
    types.forEach((type) => {
      const these = mine.filter((shot) => nearestFlight(family, shot.launchDeg) === type)
      if (these.length >= MIN_FLIGHT_SHOTS) {
        const clean = these.filter((shot) => shot.startSurface != null && CLEAN_SURFACES.has(shot.startSurface) && shot.spinRpm > 0)
        byType[type] = {
          launchDeg: median(these.map((shot) => shot.launchDeg)),
          spinPerMph: clean.length >= MIN_SPIN_SHOTS ? median(clean.map((shot) => shot.spinRpm / shot.ballSpeedMph)) : null,
          shots: these.length,
        }
      }
      if (mine.length >= MIN_FAMILY_SHOTS && these.length / mine.length < RARE_SHARE && these.length < MIN_FLIGHT_SHOTS) {
        rarely.push(type)
      }
    })
    return { total: mine.length, byType, rarely }
  }
  return { chip: fitFamily('chip'), wedge: fitFamily('wedge') }
}

type ShotRow = {
  gspro_round_id: number
  hole_number: number | null
  hole_shot: number | null
  observed_at: string
  starting_surface_raw: number | null
  ball_speed_mph: number | null
  vertical_launch_angle_degrees: number | null
  total_spin_rpm: number | null
}

/** The latest shots this many back are read; enough for months of rounds. */
const SHOTS_READ = 1500
let cached: { userId: string; at: number; fit: Promise<PlayerShortGame | null> } | null = null
const CACHE_MS = 10 * 60 * 1000

/** The signed-in player's short game, from their captured rounds. Null when signed out or offline. */
export const loadPlayerShortGame = async (): Promise<PlayerShortGame | null> => {
  if (!isSupabaseConfigured()) return null
  const user = await getCurrentLooperUser()
  if (!user) return null
  if (cached && cached.userId === user.id && Date.now() - cached.at < CACHE_MS) return cached.fit
  const fit = (async () => {
    const client = await getSupabaseClient()
    const { data, error } = await client
      .from<ShotRow[]>('live_course_shots')
      .select('gspro_round_id, hole_number, hole_shot, observed_at, starting_surface_raw, ball_speed_mph, vertical_launch_angle_degrees, total_spin_rpm')
      .eq('user_id', user.id)
      .gt('ball_speed_mph', 8)
      .lt('ball_speed_mph', WEDGE_TOP_MPH + 0.01)
      .gt('vertical_launch_angle_degrees', 3)
      .order('observed_at', { ascending: false })
      .limit(SHOTS_READ)
    if (error) throw new Error(error.message)
    const shots: PlayerShortGameShot[] = (data ?? []).flatMap((row) =>
      row.ball_speed_mph == null || row.vertical_launch_angle_degrees == null || row.total_spin_rpm == null ? [] : [{
        roundKey: String(row.gspro_round_id),
        // Neither is unique alone: caught-up rounds share one time stamp, practice repeats shot 0.
        shotKey: `${row.gspro_round_id}|${row.hole_number ?? ''}|${row.hole_shot ?? ''}|${row.observed_at}`,
        startSurface: row.starting_surface_raw,
        ballSpeedMph: row.ball_speed_mph,
        launchDeg: row.vertical_launch_angle_degrees,
        spinRpm: row.total_spin_rpm,
      }])
    return fitPlayerShortGame(shots)
  })().catch((reason) => {
    console.warn('[Live Caddie] Your short game could not be read.', reason)
    cached = null
    return null
  })
  cached = { userId: user.id, at: Date.now(), fit }
  return fit
}
