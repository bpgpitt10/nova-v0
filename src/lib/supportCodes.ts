import type { NativeCourseStatus } from '../courseGeometry/nativeCourseRuntime'

/**
 * What players see about a course and about errors: plain golf terms, honest
 * about how much Looper can see, nothing about how (Brian, 11/8: no course
 * files, matching, grades or map sources on screen). Every message carries a
 * short code so a player can read it to us and we know exactly what happened.
 *
 * Course codes (README for us; never shown expanded to players):
 *   C1x  full course map, ball positions exact (x = match grade A/B/C)
 *   C2m  full course map, positions estimated: GSPro's greens/pins differ (layout mismatch)
 *   C2f  full course map, positions estimated: the GSPro-to-map fit failed
 *   C2e  full course map, positions estimated: course match errored
 *   C3L  basic course that CAN be loaded: prompt to load it (course file only until then)
 *   C3   basic course that can't be loaded (fictional / not mapped): the fallback
 *   C4   no course map at all: screen-only caddie
 *   C5   working: matching / checking
 *   C6   companion needed (no registration and no course files)
 *   C7   GSPro is on another course, never matched this one
 *   C8   course isn't in the player's GSPro library (GKD missing)
 *   C9   browser lost read access to the GSPro folder
 *   C0   course status off (?native=0)
 *
 * Error codes (always-visible alerts):
 *   E1  ball position can't be placed on this hole (imported course, no registration)
 *   E2  GSPro shot feed error (liveError)
 *   E3  screen reading error (visual capture)
 *   E4  hole data didn't load (loadError)
 *   E5  decision engine error
 */

export type CourseStatusTone = 'full' | 'partial' | 'basic' | 'none' | 'working' | 'action'

export type CourseStatusView = Readonly<{
  code: string
  tone: CourseStatusTone
  /** One line, golf terms. */
  text: string
  /** A follow-up the player can take. */
  action?: 'load-full-course' | 'choose-folder' | 'allow-folder'
}>

/**
 * Whether a course Looper hasn't loaded can be: 'not-loadable' only when it's
 * known to be fictional or not mapped. Unknown counts as loadable, so a new
 * player is always pointed at loading first (Brian, 11/8: the basic course is
 * a fallback, not a way to play).
 */
export type CourseLoadability = 'loadable' | 'not-loadable'

export const courseStatusView = (
  status: NativeCourseStatus,
  loadability: CourseLoadability = 'loadable',
): CourseStatusView => {
  switch (status.state) {
    case 'ready':
      if (status.gsproOnly) {
        return loadability === 'not-loadable'
          ? {
              code: 'C3',
              tone: 'basic',
              text: "Basic course: this one can't be loaded (fictional or not mapped yet), so Looper plays it with greens, pins, water and OB only. No fairways, bunkers or trees.",
            }
          : {
              code: 'C3L',
              tone: 'action',
              text: 'This course isn\'t loaded yet. Load it for fairways, bunkers and trees; until then Looper only knows its greens, pins, water and OB.',
              action: 'load-full-course',
            }
      }
      return { code: `C1${status.grade || ''}`, tone: 'full', text: 'Full course: fairways, bunkers, trees, water and greens.' }
    case 'other-course':
      return status.grade
        ? { code: `C1${status.grade}`, tone: 'full', text: 'Full course: fairways, bunkers, trees, water and greens.' }
        : { code: 'C7', tone: 'action', text: 'Start this course in GSPro.' }
    case 'layout-mismatch':
      return { code: 'C2m', tone: 'partial', text: 'Full course, but ball positions are estimated here, so yardages can be a few yards off.' }
    case 'registration-failed':
      return { code: 'C2f', tone: 'partial', text: 'Full course, but ball positions are estimated here, so yardages can be a few yards off.' }
    case 'error':
      return { code: 'C2e', tone: 'partial', text: 'Full course, but ball positions are estimated here, so yardages can be a few yards off.' }
    case 'registering':
    case 'no-course':
      return { code: 'C5', tone: 'working', text: 'Getting the course ready…' }
    case 'no-registration':
      return { code: 'C6', tone: 'action', text: 'Start the Looper Companion on your GSPro PC.' }
    case 'no-folder':
      return { code: 'C6', tone: 'action', text: 'Start the Looper Companion on your GSPro PC.', action: 'choose-folder' }
    case 'gkd-not-found':
      return { code: 'C8', tone: 'action', text: "This course isn't installed in your GSPro." }
    case 'needs-permission':
      return { code: 'C9', tone: 'action', text: 'Looper needs access to your GSPro folder again.', action: 'allow-folder' }
    case 'off':
    default:
      return { code: 'C0', tone: 'none', text: 'Course status is off.' }
  }
}

/** The screen-only caddie's line: no course map at all. */
export const SCREEN_ONLY_STATUS: CourseStatusView = {
  code: 'C4',
  tone: 'none',
  text: 'No course map: club and aim from the screen only. No hazards.',
}

export type ErrorCode = 'E1' | 'E2' | 'E3' | 'E4' | 'E5'

export const ERROR_TEXT: Record<ErrorCode, string> = {
  E1: "Looper can't place your ball on this hole yet. Club and aim advice is paused until it can.",
  E2: "Looper isn't getting GSPro's shots. Check the Looper Companion is running.",
  E3: "Looper can't read GSPro's screen right now, so wind and lie may be missing.",
  E4: "This hole didn't load. Try the next hole or reload the page.",
  E5: "Looper couldn't work out this shot. Try again after your next shot.",
}

/**
 * One line a player can read or send us: "C1B · G con · B gkd · P hud ·
 * O h-l-w · E ok · v1.0.1". Short tokens, ours to decode.
 */
export const supportLine = (parts: Readonly<Record<string, string | number | null | undefined>>): string =>
  Object.entries(parts)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => (key === '' ? String(value) : `${key} ${value}`))
    .join(' · ')

/** One letter per OCR status: R ready, U unknown, X unavailable, - not read. */
export const ocrLetter = (status: string | null | undefined): string =>
  status === 'READY' ? 'R' : status === 'UNKNOWN' ? 'U' : status === 'UNAVAILABLE' ? 'X' : '-'
