import { useEffect, useState } from 'react'
import type { CourseId } from '../courseGeometry/courseCatalog'
import {
  chooseGsproCoursesFolder,
  getNativeCourseStatus,
  isNativePositionsEnabled,
  isNativePositionsSupported,
  loadNativeCourseContext,
  NATIVE_POSITIONS_CHANGED_EVENT,
  regrantGsproCoursesFolder,
  setNativePositionsEnabled,
  type NativeCourseStatus,
} from '../courseGeometry/nativeCourseRuntime'
import './NativePositionsBetaPanel.css'

type Props = {
  courseId: CourseId | null
  courseKey: string | null
}

const describe = (status: NativeCourseStatus): { text: string; tone: 'ok' | 'warn' } => {
  switch (status.state) {
    case 'ready':
      return {
        text: `Active · ${status.courseName} · registration grade ${status.grade}`
          + (status.via === 'companion' ? ' · course files via Looper Companion' : '')
          + (status.fittedHere ? ' · matched to the map on this PC' : '')
          + (status.layoutNames.length > 1 ? ` · layouts: ${status.layoutNames.join(', ')}` : ''),
        tone: 'ok',
      }
    case 'no-registration':
      return { text: `${status.courseName}: start the round in GSPro so Looper can match your course files to the map.`, tone: 'warn' }
    case 'other-course':
      return { text: `GSPro is on ${status.courseKey}, not ${status.expectedKey}; using current positioning.`, tone: 'warn' }
    case 'no-folder':
      return { text: 'Start the Looper Companion (reads the course files for you), or choose your GSPro folder (e.g. C:\\GSProV1). Read-only; files stay on this PC.', tone: 'warn' }
    case 'needs-permission':
      return { text: 'Allow read access to your GSPro course folder again.', tone: 'warn' }
    case 'gkd-not-found':
      return { text: `${status.courseKey}.GKD was not found in your GSPro course library. Choose the folder that holds it.`, tone: 'warn' }
    case 'layout-mismatch':
      return { text: 'Your installed course has different greens or pins from the registered version; using current positioning.', tone: 'warn' }
    case 'registering':
      return { text: 'Matching your GSPro course to the map (a few seconds)…', tone: 'warn' }
    case 'registration-failed':
      return { text: `Could not match your GSPro course to the map: ${status.reason}. Using current positioning.`, tone: 'warn' }
    case 'error':
      return { text: `Native positions unavailable: ${status.message}`, tone: 'warn' }
    case 'no-course':
      return { text: 'Checking…', tone: 'warn' }
    case 'off':
    default:
      return { text: 'Off · using current positioning.', tone: 'warn' }
  }
}

/** Beta switch for GKD + LiDAR-registered positions. Off by default; when off
 * or not ready, Live Caddie behaves exactly as before. */
export default function NativePositionsBetaPanel({ courseId, courseKey }: Props) {
  const [enabled, setEnabled] = useState(isNativePositionsEnabled)
  const [status, setStatus] = useState<NativeCourseStatus>(getNativeCourseStatus)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onChange = (event: Event) => setStatus((event as CustomEvent<NativeCourseStatus>).detail)
    window.addEventListener(NATIVE_POSITIONS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(NATIVE_POSITIONS_CHANGED_EVENT, onChange)
  }, [])

  useEffect(() => {
    if (!enabled) return
    let active = true
    void loadNativeCourseContext(courseId, courseKey).then((result) => {
      if (active) setStatus(result.status)
    })
    return () => { active = false }
  }, [enabled, courseId, courseKey, status.state])

  // The companion serves course files in any browser; the folder picker
  // fallback needs Chrome or Edge.
  const canPickFolder = isNativePositionsSupported()

  const toggle = (next: boolean) => {
    setNativePositionsEnabled(next)
    setEnabled(next)
  }

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

  const { text, tone } = describe(enabled ? status : { state: 'off' })
  const needsFolder = canPickFolder && enabled && (status.state === 'no-folder' || status.state === 'gkd-not-found')
  const needsPermission = canPickFolder && enabled && status.state === 'needs-permission'

  return (
    <section className="native-positions-beta" aria-label="Native positions beta">
      <label className="native-positions-toggle">
        <input type="checkbox" checked={enabled} onChange={(event) => toggle(event.target.checked)} />
        <span>Native positions (beta)</span>
      </label>
      <span className={`native-positions-status native-positions-${tone}`}>{text}</span>
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
