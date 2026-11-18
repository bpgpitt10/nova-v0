/**
 * GSPro's course conditions for a round (Match screen, Course panel; GSPro
 * 4.1.9). GSPro doesn't write them anywhere Looper can read, so the player
 * picks them at Start a Round and they are saved with the round. Roll and
 * green speed depend on them.
 */
export type Firmness = 'soft' | 'medium' | 'firm'

export type RoundConditions = Readonly<{
  /** Course Type: Soft (Bentgrass), Medium (Bermuda), Firm (Links). */
  courseType: Firmness | null
  greenFirmness: Firmness | null
  fairwayFirmness: Firmness | null
  stimp: number | null
}>

/** Labels as GSPro shows them. */
export const COURSE_TYPE_OPTIONS: readonly (readonly [Firmness, string])[] = [
  ['soft', 'Soft (Bentgrass)'],
  ['medium', 'Medium (Bermuda)'],
  ['firm', 'Firm (Links)'],
]
export const FIRMNESS_OPTIONS: readonly (readonly [Firmness, string])[] = [
  ['soft', 'Soft'],
  ['medium', 'Medium'],
  ['firm', 'Firm'],
]
/** GSPro's change log adds 6 and 7 at the low end and defaults to 10; the top of its list isn't documented. */
export const STIMP_OPTIONS: readonly number[] = [6, 7, 8, 9, 10, 11, 12, 13, 14]

export const NO_ROUND_CONDITIONS: RoundConditions = { courseType: null, greenFirmness: null, fairwayFirmness: null, stimp: null }

const firmness = (value: unknown): Firmness | null =>
  value === 'soft' || value === 'medium' || value === 'firm' ? value : null

export const normalizeRoundConditions = (value: unknown): RoundConditions => {
  if (!value || typeof value !== 'object') return NO_ROUND_CONDITIONS
  const raw = value as Record<string, unknown>
  const stimp = typeof raw.stimp === 'number' ? raw.stimp : Number(raw.stimp)
  return {
    courseType: firmness(raw.courseType),
    greenFirmness: firmness(raw.greenFirmness),
    fairwayFirmness: firmness(raw.fairwayFirmness),
    stimp: raw.stimp != null && raw.stimp !== '' && Number.isFinite(stimp) && stimp >= 5 && stimp <= 16 ? stimp : null,
  }
}

export const hasRoundConditions = (conditions: RoundConditions | null | undefined) =>
  conditions != null && (conditions.courseType != null || conditions.greenFirmness != null
    || conditions.fairwayFirmness != null || conditions.stimp != null)

const REMEMBERED_KEY = 'looper.round-setup.conditions'

/** Most players leave GSPro on the same conditions, so the last pick is the next default. */
export const loadRememberedRoundConditions = (): RoundConditions => {
  try {
    return normalizeRoundConditions(JSON.parse(window.localStorage.getItem(REMEMBERED_KEY) ?? 'null'))
  } catch {
    return NO_ROUND_CONDITIONS
  }
}

export const rememberRoundConditions = (conditions: RoundConditions) => {
  try {
    window.localStorage.setItem(REMEMBERED_KEY, JSON.stringify(conditions))
  } catch {
    // remembering is a convenience only
  }
}
