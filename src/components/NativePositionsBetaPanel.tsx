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
import { courseUsesGsproHoles } from '../courseGeometry/courseCatalog'
import { courseStatusView, type CourseLoadability } from '../lib/supportCodes'
import { crosswalkDecision, crosswalkForGsproKey } from '../courseLoading/courseCrosswalk'
import './NativePositionsBetaPanel.css'

type Props = {
  courseId: CourseId | null
  courseKey: string | null
  /** Live Caddie: say nothing while all is well (the top bar already shows
   * GSPro and the companion); anything that needs the player still shows.
   * Details shows it always (Brian, 11/9). */
  quietWhenFull?: boolean
}

/** "Course": how much of this course Looper can see, in golf terms, with a
 * short code for support (lib/supportCodes.ts). How the course is matched is
 * never shown. ?native=0 turns it off for troubleshooting. */
export default function NativePositionsBetaPanel({ courseId, courseKey, quietWhenFull = false }: Props) {
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
  const gsproOnly = courseUsesGsproHoles(courseId)
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

  // A course Looper hasn't loaded: can it be? Only fictional / unmapped
  // courses get the basic-course fallback; everything else is told to load.
  const gsproKey = status.state === 'ready' && status.gsproOnly ? status.courseKey : null
  const [loadability, setLoadability] = useState<CourseLoadability>('loadable')
  useEffect(() => {
    setLoadability('loadable')
    if (!gsproKey) return
    let alive = true
    void crosswalkForGsproKey(gsproKey)
      .then((row) => { if (alive) setLoadability(crosswalkDecision(row).kind === 'not-on-map' ? 'not-loadable' : 'loadable') })
      .catch(() => {})
    return () => { alive = false }
  }, [gsproKey])
  const view = courseStatusView(on ? status : { state: 'off' }, loadability)
  const needsFolder = canPickFolder && on && (status.state === 'no-folder' || status.state === 'gkd-not-found')
  const needsPermission = canPickFolder && on && status.state === 'needs-permission'

  if (quietWhenFull && view.tone === 'full' && !needsFolder && !needsPermission) return null

  return (
    <section className="native-positions-beta" aria-label="Course" data-course-code={view.code}>
      <span className="native-positions-toggle">Course</span>
      <span className={`native-positions-dot native-positions-${view.tone}`} aria-hidden="true" />
      <span className={`native-positions-status native-positions-${view.tone}`}>{view.text}</span>
      {view.action === 'load-full-course' ? (
        <a className="native-positions-link" href={gsproKey ? `/courses?gspro=${encodeURIComponent(gsproKey)}` : '/courses'}>
          Load this course
        </a>
      ) : null}
      <span className="native-positions-code" title="Support code">{view.code}</span>
      {needsFolder ? (
        <button type="button" disabled={busy} onClick={() => void run(chooseGsproCoursesFolder)}>
          Connect your GSPro folder
        </button>
      ) : null}
      {needsPermission ? (
        <button type="button" disabled={busy} onClick={() => void run(regrantGsproCoursesFolder)}>
          Allow access
        </button>
      ) : null}
    </section>
  )
}
