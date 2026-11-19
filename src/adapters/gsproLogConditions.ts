/**
 * GSPro's own course conditions and altitude, read from its log.
 *
 * GSPro 4 writes these for every shot (Player.log, sim PC, 18 Nov 2026):
 *
 *   LaunchExt Vars: sp 94.4, el 22.4, az 0, ts 8646, sa 0, cy 0, id 132
 *   Physics Settings: Green Firmness 1     Fairway Firmness 1    Course Type 0
 *   ...
 *   magnitude: 1.69 | yForce 1.20 | material TVGsand | SoundMultiplier 0.05 | SoundForceScale 0.10 | elevation 2851
 *
 * Firmness is 0 soft, 1 medium, 2 firm. Course Type is 0 Bentgrass, 1 Bermuda,
 * 2 Links, which Start a Round calls soft, medium and firm. "elevation" is the
 * altitude GSPro flew the ball at, in feet. Stimp is not logged.
 *
 * The lines are written when a shot is hit, and the log holds every round
 * played since GSPro was opened. So the caller only passes the part of the log
 * written while it was watching: see `advanceLogWatch`.
 */
import type { Firmness } from '../liveCaddie/roundConditions'

export type GsproLogConditions = Readonly<{
  courseType: Firmness
  greenFirmness: Firmness
  fairwayFirmness: Firmness
  /** GSPro's altitude for the latest shot that landed; null before one has. */
  altitudeFt: number | null
  /** How many shots in this stretch of log carried a settings line. */
  shotCount: number
}>

const SETTINGS = /Physics Settings:\s*Green Firmness\s*(\d)\s+Fairway Firmness\s*(\d)\s+Course Type\s*(\d)/gi
const ALTITUDE = /\|\s*material\s+\w+\s*\|[^\n]*\|\s*elevation\s+(-?\d+(?:\.\d+)?)/gi
const LEVELS: readonly Firmness[] = ['soft', 'medium', 'firm']

/** The latest settings line in a stretch of GSPro's log, or null when there is none. */
export const parseGsproLogConditions = (logText: string): GsproLogConditions | null => {
  let last: RegExpExecArray | null = null
  let shotCount = 0
  SETTINGS.lastIndex = 0
  for (let match = SETTINGS.exec(logText); match; match = SETTINGS.exec(logText)) {
    last = match
    shotCount += 1
  }
  if (!last) return null
  const [green, fairway, type] = [LEVELS[Number(last[1])], LEVELS[Number(last[2])], LEVELS[Number(last[3])]]
  if (!green || !fairway || !type) return null

  let altitudeFt: number | null = null
  ALTITUDE.lastIndex = 0
  for (let match = ALTITUDE.exec(logText); match; match = ALTITUDE.exec(logText)) {
    const feet = Number(match[1])
    if (Number.isFinite(feet) && feet > -1500 && feet < 20000) altitudeFt = feet
  }
  return { courseType: type, greenFirmness: green, fairwayFirmness: fairway, altitudeFt, shotCount }
}

export type LogWatch = Readonly<{
  /** Only log written past this byte is from shots hit while watching. */
  fromByte: number
  conditions: GsproLogConditions | null
}>

/**
 * Where to read GSPro's log from, given its size now.
 *
 * The first look only marks the end of the log: whatever is already there may
 * be an earlier round on other settings. A log that got shorter is a new one
 * (GSPro starts it again each time it opens), so it is read from the top.
 */
export const advanceLogWatch = (watch: LogWatch | null, sizeNow: number): LogWatch =>
  watch == null
    ? { fromByte: sizeNow, conditions: null }
    : sizeNow < watch.fromByte
      ? { fromByte: 0, conditions: null }
      : watch

// ---- What the page reads ---------------------------------------------------

export const GSPRO_LOG_CONDITIONS_EVENT = 'looper:gspro-log-conditions'
let latest: GsproLogConditions | null = null

const same = (a: GsproLogConditions | null, b: GsproLogConditions) =>
  a != null && a.courseType === b.courseType && a.greenFirmness === b.greenFirmness
    && a.fairwayFirmness === b.fairwayFirmness && a.altitudeFt === b.altitudeFt

/** GSPro's settings from a shot hit while Looper was watching, or null before one. */
export const latestGsproLogConditions = () => latest

export const publishGsproLogConditions = (conditions: GsproLogConditions) => {
  if (same(latest, conditions)) return
  latest = conditions
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(GSPRO_LOG_CONDITIONS_EVENT, { detail: conditions }))
    }
  } catch {
    // no listeners to tell
  }
}

/** Tests only. */
export const __resetGsproLogConditionsForTests = () => { latest = null }
