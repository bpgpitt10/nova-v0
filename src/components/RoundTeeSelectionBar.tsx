import { useEffect, useMemo, useState } from 'react'
import {
  COURSE_SELECTION_UPDATED_EVENT,
  loadLastSelectedCourseId,
} from '../courseGeometry/courseSelection'
import {
  UNSELECTED_COURSE_ID,
  getCourseCatalogEntry,
  type CourseId,
} from '../courseGeometry/courseCatalog'
import {
  loadRoundTeeSelection,
  normalizeTeeSet,
  saveRoundTeeSelection,
  type RoundTeeSelection,
} from '../courseGeometry/roundTeeSelection'
import { startLiveCaddieRound } from '../liveCaddie/roundRuntime'

const commonTeeSets = ['Blue', 'White', 'Black', 'Gold', 'Red', 'Green', 'Silver', 'Yellow']

export default function RoundTeeSelectionBar() {
  const [courseId, setCourseId] = useState<CourseId>(() => loadLastSelectedCourseId())
  const [selection, setSelection] = useState<RoundTeeSelection | null>(() => {
    const initialCourse = loadLastSelectedCourseId()
    return initialCourse === UNSELECTED_COURSE_ID ? null : loadRoundTeeSelection(initialCourse)
  })
  const [draft, setDraft] = useState(() => selection?.teeSet ?? '')
  const [startFlash, setStartFlash] = useState(false)

  useEffect(() => {
    const refreshCourse = () => {
      const nextCourse = loadLastSelectedCourseId()
      setCourseId(nextCourse)
      const nextSelection = nextCourse === UNSELECTED_COURSE_ID
        ? null
        : loadRoundTeeSelection(nextCourse)
      setSelection(nextSelection)
      setDraft(nextSelection?.teeSet ?? '')
      setStartFlash(false)
    }
    window.addEventListener(COURSE_SELECTION_UPDATED_EVENT, refreshCourse)
    window.addEventListener('storage', refreshCourse)
    return () => {
      window.removeEventListener(COURSE_SELECTION_UPDATED_EVENT, refreshCourse)
      window.removeEventListener('storage', refreshCourse)
    }
  }, [])

  const courseName = useMemo(
    () => courseId === UNSELECTED_COURSE_ID ? 'Choose course first' : getCourseCatalogEntry(courseId).name,
    [courseId],
  )
  const draftMatchesSaved = Boolean(
    selection && normalizeTeeSet(draft) === selection.normalizedTeeSet,
  )

  const save = () => {
    if (courseId === UNSELECTED_COURSE_ID) return
    const previousNormalized = selection?.normalizedTeeSet ?? ''
    const next = saveRoundTeeSelection(courseId, draft)
    setSelection(next)
    setDraft(next?.teeSet ?? '')

    // The course geometry is intentionally immutable once loaded. A changed
    // round tee therefore gets one clean reload so Shot 1 is rebuilt from the
    // newly selected OSM tee without teaching Live Caddie a second geometry path.
    if (next && next.normalizedTeeSet !== previousNormalized) {
      window.location.reload()
    }
  }

  const startRound = () => {
    if (courseId === UNSELECTED_COURSE_ID) return
    startLiveCaddieRound()
    setStartFlash(true)
    window.setTimeout(() => setStartFlash(false), 1400)
  }

  return (
    <aside
      aria-label="Live Caddie round controls"
      style={{
        position: 'fixed',
        right: 18,
        top: 74,
        zIndex: 80,
        display: 'grid',
        gridTemplateColumns: 'auto auto 150px auto',
        alignItems: 'center',
        gap: 8,
        padding: '9px 10px',
        border: '1px solid rgba(49, 66, 51, 0.9)',
        borderRadius: 10,
        background: 'rgba(16, 27, 19, 0.96)',
        boxShadow: '0 12px 36px rgba(0,0,0,0.28)',
        color: '#cfd8cd',
        fontSize: 12,
      }}
    >
      <button
        type="button"
        disabled={courseId === UNSELECTED_COURSE_ID}
        onClick={startRound}
        title="Start a fresh Looper round on Hole 1, Shot 1 and ignore pre-existing currentRound.dat shots until GSPro writes a new shot."
        style={{
          minHeight: 30,
          border: '1px solid rgba(118, 211, 155, 0.55)',
          borderRadius: 7,
          padding: '0 12px',
          background: startFlash ? 'rgba(95, 191, 122, 0.28)' : 'rgba(95, 191, 122, 0.12)',
          color: '#d7ead9',
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: '0.04em',
        }}
      >
        {startFlash ? 'ROUND STARTED' : 'START ROUND'}
      </button>

      <div style={{ display: 'grid', lineHeight: 1.1 }}>
        <strong style={{ color: '#fff', fontSize: 11 }}>ROUND TEES</strong>
        <span style={{ color: '#829083', fontSize: 9 }}>{courseName}</span>
      </div>
      <input
        aria-label="Tee set"
        list="looper-common-tee-sets"
        value={draft}
        disabled={courseId === UNSELECTED_COURSE_ID}
        placeholder="e.g. Blue"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
        }}
        style={{
          minHeight: 30,
          boxSizing: 'border-box',
          width: '100%',
          border: '1px solid rgba(49, 66, 51, 0.86)',
          borderRadius: 7,
          padding: '0 8px',
          background: 'rgba(23, 36, 25, 0.95)',
          color: '#fff',
          fontSize: 12,
        }}
      />
      <datalist id="looper-common-tee-sets">
        {commonTeeSets.map((teeSet) => <option key={teeSet} value={teeSet} />)}
      </datalist>
      <button
        type="button"
        disabled={courseId === UNSELECTED_COURSE_ID || !draft.trim()}
        onClick={save}
        style={{
          minHeight: 30,
          border: '1px solid rgba(234, 179, 8, 0.45)',
          borderRadius: 7,
          padding: '0 9px',
          background: draftMatchesSaved ? 'rgba(67, 104, 74, 0.85)' : 'rgba(234, 179, 8, 0.12)',
          color: draftMatchesSaved ? '#d7ead9' : '#f4d15d',
          fontSize: 10,
          fontWeight: 700,
        }}
      >
        {draftMatchesSaved ? 'SET' : 'SAVE'}
      </button>
    </aside>
  )
}
