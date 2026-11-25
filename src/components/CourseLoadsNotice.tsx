import { useEffect, useState } from 'react'
import { getCurrentLooperUser } from '../cloud/supabaseClient'
import {
  acknowledgeCourseLoads,
  listMyUnseenCourseLoads,
  myLoadLine,
  type MyCourseLoad,
} from '../courseLoading/courseLoads'
import './CourseLoadsNotice.css'

/**
 * "Your courses": what happened to the course loads you asked for, the next time you open the site
 * (24 Nov: a player asked for three loads and walked away before any finished). One line per course.
 * "Got it" marks the finished ones as seen for good; a load still running comes back until it ends.
 */

const HIDDEN_KEY = 'looper.course-loads-notice-hidden'

const hiddenThisVisit = () => {
  try {
    return window.sessionStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

export function CourseLoadsNotice() {
  const [rows, setRows] = useState<MyCourseLoad[]>([])
  const [hidden, setHidden] = useState(hiddenThisVisit)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (hidden) return undefined
    let alive = true
    void (async () => {
      const user = await getCurrentLooperUser()
      if (!user) return
      const mine = await listMyUnseenCourseLoads(user.id)
      if (alive) setRows(mine)
    })().catch((error: unknown) => console.warn('[Looper] Your course loads could not be read.', error))
    return () => { alive = false }
  }, [hidden])

  if (hidden || !rows.length) return null

  const gotIt = async () => {
    setSaving(true)
    try {
      await acknowledgeCourseLoads(rows.filter((row) => row.finished_at != null).map((row) => row.id))
    } catch (error) {
      console.warn('[Looper] Could not mark your course loads as seen.', error)
    } finally {
      setSaving(false)
      setHidden(true)
      try {
        window.sessionStorage.setItem(HIDDEN_KEY, '1')
      } catch {
        // stays hidden until the page reloads
      }
    }
  }

  return (
    <aside className="course-loads-notice" aria-label="Your course loads">
      <div className="course-loads-notice__text">
        <strong className="course-loads-notice__title">Your courses</strong>
        <ul>
          {rows.map((row) => {
            const line = myLoadLine(row)
            return (
              <li key={row.id} className={`course-loads-notice__line is-${line.tone}`}>
                <span aria-hidden="true">{line.icon}</span>
                <span>{line.text}</span>
              </li>
            )
          })}
        </ul>
      </div>
      <div className="course-loads-notice__actions">
        <a className="course-loads-notice__open" href="/courses">Load a course</a>
        <button type="button" className="course-loads-notice__ok" disabled={saving} onClick={() => { void gotIt() }}>
          {saving ? 'Saving…' : 'Got it'}
        </button>
      </div>
    </aside>
  )
}
