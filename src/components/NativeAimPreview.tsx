import { useEffect, useState } from 'react'
import { readLooperCompanionAimPreview, type LooperCompanionAimPreview } from '../adapters/looperCompanion'
import type { CourseId } from '../courseGeometry/courseCatalog'
import { nativeCourseContextForLive, type NativeCourseContext } from '../courseGeometry/nativeCourseRuntime'
import { nativeHoleLocalYdsToWorld } from '../courseGeometry/nativeRegistration'
import type { CoursePointYds } from '../courseGeometry/types'
import './NativeAimPreview.css'

type Props = {
  courseId: CourseId | null
  courseKey: string | null
  holeNumber: number
  ball: CoursePointYds | null
  pin: CoursePointYds | null
  target: CoursePointYds | null
  companionReady: boolean
}

const MESSAGES: Record<string, string> = {
  'target-off-map': "Looper's aim is outside GSPro's minimap view.",
  'gspro-not-connected': 'GSPro is not running or not found by the companion.',
  'invalid-request': 'Positions were not available for this shot.',
}

/**
 * Auto Aim step 1 (beta, read-only): show where Looper WOULD click on GSPro's
 * minimap for its aim. Uses native positions (ball, pin, target in GSPro world
 * metres) and the companion's read of the minimap's ball and pin dots. The
 * companion never moves the mouse or presses keys.
 */
export default function NativeAimPreview({ courseId, courseKey, holeNumber, ball, pin, target, companionReady }: Props) {
  const [context, setContext] = useState<NativeCourseContext | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LooperCompanionAimPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setContext(null)
    if (!courseId) return () => { active = false }
    void nativeCourseContextForLive(courseId, courseKey).then((value) => { if (active) setContext(value) })
    return () => { active = false }
  }, [courseId, courseKey])

  // A new shot or aim invalidates the last preview.
  const shotKey = `${holeNumber}|${ball?.map((v) => v.toFixed(1)).join(',')}|${target?.map((v) => v.toFixed(1)).join(',')}`
  useEffect(() => {
    setResult(null)
    setError(null)
  }, [shotKey])

  if (!context || !companionReady) return null

  const toWorld = (local: CoursePointYds | null) => nativeHoleLocalYdsToWorld(context.registration, holeNumber, local)
  const points = { ball: toWorld(ball), pin: toWorld(pin), target: toWorld(target) }
  const ready = Boolean(points.ball && points.pin && points.target)

  const run = async () => {
    if (!points.ball || !points.pin || !points.target) return
    setBusy(true)
    setError(null)
    try {
      setResult(await readLooperCompanionAimPreview({ ball: points.ball, pin: points.pin, target: points.target }))
    } catch (cause) {
      setResult(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const note = result
    ? result.status === 'ready'
      ? 'Yellow ring = where Looper would click. Does it match where you would aim in GSPro?'
      : result.status === 'unavailable'
        ? `Companion could not read the minimap: ${result.reason ?? 'unknown reason'}.`
        : MESSAGES[result.status] ?? result.status
    : error

  return (
    <section className="native-aim-preview" aria-label="GSPro aim preview">
      <div className="native-aim-preview-row">
        <span className="native-aim-preview-title">GSPro aim preview <em>beta · no clicking</em></span>
        <span className="native-aim-preview-actions">
          <button type="button" disabled={!ready || busy} onClick={() => void run()}
            title={ready ? undefined : 'Waiting for the ball, pin and aim positions for this shot.'}>
            {busy ? 'Reading GSPro…' : result ? 'Check again' : 'Show where Looper would click'}
          </button>
          {result || error ? (
            <button type="button" onClick={() => { setResult(null); setError(null) }}>Hide</button>
          ) : null}
        </span>
      </div>
      {result?.previewPng ? (
        <img
          className="native-aim-preview-image"
          alt="GSPro minimap with Looper's planned aim click marked"
          src={`data:image/png;base64,${result.previewPng}`}
        />
      ) : null}
      {note ? <p className="native-aim-preview-note">{note}</p> : null}
    </section>
  )
}
