import { useEffect, useState } from 'react'
import type { CourseId } from '../courseGeometry/courseCatalog'
import {
  chooseGsproCoursesFolder,
  getNativeCourseStatus,
  isNativePositionsEnabled,
  isNativePositionsSupported,
  loadNativeCourseContext,
  NATIVE_POSITIONS_CHANGED_EVENT,
  nativeStatusEventIsFor,
  regrantGsproCoursesFolder,
  type NativeCourseStatus,
} from '../courseGeometry/nativeCourseRuntime'
import { isGsproOnlyCourseId } from '../courseGeometry/gsproOnlyCourse'
import './NativePositionsBetaPanel.css'

type Props = {
  courseId: CourseId | null
  courseKey: string | null
}

/** One plain line per state; the technical detail goes in `detail` (hover). */
const describe = (status: NativeCourseStatus): { text: string; tone: 'ok' | 'warn'; detail?: string } => {
  switch (status.state) {
    case 'ready':
      if (status.gsproOnly) {
        return {
          text: "Playing from GSPro's course file: no map yet, so no fairways, bunkers or trees.",
          tone: 'ok',
          detail: "Tees, pins, the green, GSPro's water and OB and GSPro's heights come from the course file."
            + (status.layoutNames.length > 1 ? ` Layouts: ${status.layoutNames.join(', ')}.` : ''),
        }
      }
      return {
        text: `Matched to your GSPro course · grade ${status.grade}`,
        tone: 'ok',
        detail: [
          status.via === 'companion' ? 'Course files via the Looper Companion.' : 'Course files from your GSPro folder.',
          status.fittedHere ? `Matched on this PC${status.fitDetail ? `: ${status.fitDetail}` : ''}.` : '',
          status.layoutNames.length > 1 ? `Layouts: ${status.layoutNames.join(', ')}.` : '',
        ].filter(Boolean).join(' '),
      }
    case 'no-registration':
      return { text: 'Start the Looper Companion on your GSPro PC to match this course.', tone: 'warn' }
    case 'other-course':
      return status.grade
        ? { text: `Matched to your GSPro course · grade ${status.grade}`, tone: 'ok',
            detail: `GSPro's last round was on ${status.courseKey}; positions switch on when you start this course in GSPro.` }
        : { text: `GSPro is on ${status.courseKey}. Positions are estimated until you start this course in GSPro.`, tone: 'warn' }
    case 'no-folder':
      return { text: 'Start the Looper Companion on your GSPro PC to match this course.', tone: 'warn',
        detail: 'Or choose your GSPro folder (e.g. C:\\GSProV1). Read-only; files stay on this PC.' }
    case 'needs-permission':
      return { text: 'Allow read access to your GSPro course folder again.', tone: 'warn' }
    case 'gkd-not-found':
      return { text: "This course isn't in your GSPro course library.", tone: 'warn', detail: `${status.courseKey}.GKD not found.` }
    case 'layout-mismatch':
      return { text: 'Your GSPro version of this course has different greens or pins. Positions are estimated.', tone: 'warn' }
    case 'registering':
      return { text: 'Matching to your GSPro course…', tone: 'warn' }
    case 'registration-failed':
      return { text: "Couldn't match this course to your GSPro version. Positions are estimated.", tone: 'warn', detail: status.reason }
    case 'error':
      return { text: 'Course match unavailable. Positions are estimated.', tone: 'warn', detail: status.message }
    case 'no-course':
      return { text: 'Checking…', tone: 'warn' }
    case 'off':
    default:
      return { text: 'Off (?native=0). Positions are estimated.', tone: 'warn', detail: '?native=1 turns it back on.' }
  }
}

/** "Course match": whether GSPro's course files are matched to the map, so
 * positions come straight from GSPro's coordinates. Always on (no toggle);
 * when it can't match, Live Caddie falls back to estimated positions and this
 * line says why. ?native=0 turns it off for troubleshooting. */
export default function NativePositionsBetaPanel({ courseId, courseKey }: Props) {
  const [enabled] = useState(isNativePositionsEnabled)
  const [status, setStatus] = useState<NativeCourseStatus>(getNativeCourseStatus)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onChange = (event: Event) => {
      if (nativeStatusEventIsFor(event, courseId)) setStatus((event as CustomEvent<NativeCourseStatus>).detail)
    }
    window.addEventListener(NATIVE_POSITIONS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(NATIVE_POSITIONS_CHANGED_EVENT, onChange)
  }, [courseId])

  // A GSPro-only course has no other positioning: always on.
  const gsproOnly = isGsproOnlyCourseId(courseId)
  const on = enabled || gsproOnly
  useEffect(() => {
    if (!on) return
    let active = true
    void loadNativeCourseContext(courseId, courseKey).then((result) => {
      if (active) setStatus(result.status)
    })
    return () => { active = false }
  }, [on, courseId, courseKey, status.state])

  // The companion serves course files in any browser; the folder picker
  // fallback needs Chrome or Edge.
  const canPickFolder = isNativePositionsSupported()

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await work()
    } catch (error) {
      // A cancelled folder picker is not an error worth showing.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      setBusy(false)
    }
  }

  const { text, tone, detail } = describe(on ? status : { state: 'off' })
  const needsFolder = canPickFolder && on && (status.state === 'no-folder' || status.state === 'gkd-not-found')
  const needsPermission = canPickFolder && on && status.state === 'needs-permission'

  return (
    <section className="native-positions-beta" aria-label="Course match">
      <span className="native-positions-toggle">Course match</span>
      <span className={`native-positions-status native-positions-${tone}`} title={detail}>{text}</span>
      {needsFolder ? (
        <button type="button" disabled={busy} onClick={() => void run(chooseGsproCoursesFolder)}>
          Choose GSPro course folder
        </button>
      ) : null}
      {needsPermission ? (
        <button type="button" disabled={busy} onClick={() => void run(regrantGsproCoursesFolder)}>
          Allow folder access
        </button>
      ) : null}
    </section>
  )
}
