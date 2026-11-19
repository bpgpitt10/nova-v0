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
/** The stimp choices on GSPro's Match screen (Brian, 18 Nov). */
export const STIMP_OPTIONS: readonly number[] = [6, 7, 8, 9, 10, 11, 12, 13]

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

/** Every round needs all four (Brian, 18 Nov): a round without them can't be adjusted or learned from. */
export const roundConditionsComplete = (conditions: RoundConditions | null | undefined) =>
  conditions != null && conditions.courseType != null && conditions.greenFirmness != null
    && conditions.fairwayFirmness != null && conditions.stimp != null

const REMEMBERED_KEY_PREFIX = 'looper.round-setup.conditions:'

/**
 * What was picked last time on this course. Remembered per course, because
 * GSPro defaults each course to conditions that suit its design: last night's
 * links settings would be a wrong guess on a parkland course.
 */
export const loadRememberedRoundConditions = (courseId: string): RoundConditions => {
  try {
    return normalizeRoundConditions(JSON.parse(window.localStorage.getItem(`${REMEMBERED_KEY_PREFIX}${courseId}`) ?? 'null'))
  } catch {
    return NO_ROUND_CONDITIONS
  }
}

export const rememberRoundConditions = (courseId: string, conditions: RoundConditions) => {
  try {
    window.localStorage.setItem(`${REMEMBERED_KEY_PREFIX}${courseId}`, JSON.stringify(conditions))
  } catch {
    // remembering is a convenience only
  }
}

const FAIRWAY_ROLL_KEY = 'looper.fairway-roll-model'

/**
 * Whether Live Caddie uses the fairway roll model for its outcomes. Off unless
 * switched on: `?fairwayRoll=on` (or `off`) in the address sets it for this
 * browser. Off, the model's roll is still shown in the conditions panel.
 */
export const fairwayRollModelOn = (): boolean => {
  try {
    const asked = new URLSearchParams(window.location.search).get('fairwayRoll')
    if (asked === 'on' || asked === 'off') window.localStorage.setItem(FAIRWAY_ROLL_KEY, asked)
    return window.localStorage.getItem(FAIRWAY_ROLL_KEY) === 'on'
  } catch {
    return false
  }
}
