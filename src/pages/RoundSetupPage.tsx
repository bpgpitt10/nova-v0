import { useEffect, useMemo, useState } from 'react'
import {
  GREYWOLF_COURSE_ID,
  courseRegistry,
  getCourseCatalogEntry,
  type CourseId,
} from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import { loadLastSelectedCourseId, saveLastSelectedCourseId } from '../courseGeometry/courseSelection'
import { loadCourseTeeCandidates } from '../courseGeometry/teeCandidateProvider'
import {
  loadRoundTeeSelection,
  saveRoundTeeSelection,
} from '../courseGeometry/roundTeeSelection'
import {
  clearActiveLiveCaddieRound,
  loadActiveLiveCaddieRound,
  startLiveCaddieRound,
  type ActiveLiveCaddieRound,
} from '../liveCaddie/roundRuntime'
import type { CourseTeeCandidate } from '../courseGeometry/types'

const teeLabel = (candidate: CourseTeeCandidate) =>
  candidate.teeSet
  ?? candidate.color
  ?? candidate.label
  ?? candidate.name
  ?? candidate.ref
  ?? null

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()

export default function RoundSetupPage() {
  const initialCourse = loadLastSelectedCourseId()
  const initialCourseId = initialCourse === '__no-course-selected__'
    ? GREYWOLF_COURSE_ID
    : initialCourse
  const savedTee = loadRoundTeeSelection(initialCourseId)

  const [courseId, setCourseId] = useState<CourseId>(initialCourseId)
  const [teeSet, setTeeSet] = useState(savedTee?.teeSet ?? '')
  const [teeOptions, setTeeOptions] = useState<string[]>([])
  const [loadingTees, setLoadingTees] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeRound, setActiveRound] = useState<ActiveLiveCaddieRound | null>(() =>
    loadActiveLiveCaddieRound(),
  )

  const course = useMemo(() => getCourseCatalogEntry(courseId), [courseId])

  useEffect(() => {
    let cancelled = false
    setLoadingTees(true)
    setError(null)
    void loadCourseTeeCandidates(courseId, 1)
      .then((candidates) => {
        if (cancelled) return
        const labels = [...new Set(candidates.map(teeLabel).filter((value): value is string => Boolean(value)))]
          .sort((left, right) => left.localeCompare(right))
        setTeeOptions(labels)
        if (labels.length > 0 && !labels.some((label) => normalize(label) === normalize(teeSet))) {
          const saved = loadRoundTeeSelection(courseId)
          const next = saved?.teeSet && labels.some((label) => normalize(label) === normalize(saved.teeSet))
            ? saved.teeSet
            : labels[0]
          setTeeSet(next)
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setTeeOptions([])
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingTees(false)
      })
    return () => {
      cancelled = true
    }
  }, [courseId])

  const startRound = async () => {
    if (!teeSet.trim()) return
    setStarting(true)
    setError(null)
    try {
      saveLastSelectedCourseId(courseId)
      const selection = saveRoundTeeSelection(courseId, teeSet)
      if (!selection) throw new Error('Choose a tee set before starting the round.')

      const geometry = await loadCourseHoleGeometry(courseId, 1)
      const exactMatches = (geometry.teeCandidates ?? []).filter((candidate) =>
        [candidate.teeSet, candidate.color, candidate.label, candidate.name, candidate.ref]
          .some((value) => value && normalize(value) === selection.normalizedTeeSet),
      )
      if (exactMatches.length !== 1) {
        throw new Error(
          exactMatches.length === 0
            ? `${selection.teeSet} is not mapped to a unique Hole 1 tee yet.`
            : `${selection.teeSet} maps to multiple Hole 1 tee candidates; Looper will not guess.`,
        )
      }

      const round = startLiveCaddieRound({
        courseId,
        teeSet: selection.teeSet,
        assumedTeeLocalYds: geometry.markers.tee,
      })
      if (!round) throw new Error('Looper could not arm the round.')
      setActiveRound(round)
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError))
    } finally {
      setStarting(false)
    }
  }

  const resetRound = () => {
    clearActiveLiveCaddieRound()
    setActiveRound(null)
  }

  const shell: React.CSSProperties = {
    minHeight: '100vh',
    background: '#0b120d',
    color: '#f5f7f4',
    padding: '48px 24px',
    boxSizing: 'border-box',
  }
  const card: React.CSSProperties = {
    width: 'min(620px, 100%)',
    margin: '0 auto',
    background: '#111c14',
    border: '1px solid #2b3a2f',
    borderRadius: 16,
    padding: 28,
    boxShadow: '0 18px 54px rgba(0,0,0,0.28)',
  }
  const input: React.CSSProperties = {
    width: '100%',
    minHeight: 46,
    marginTop: 8,
    borderRadius: 9,
    border: '1px solid #405046',
    background: '#0d1710',
    color: '#fff',
    padding: '0 12px',
    boxSizing: 'border-box',
    fontSize: 15,
  }
  const primary: React.CSSProperties = {
    minHeight: 46,
    border: '1px solid #74d49a',
    borderRadius: 9,
    background: '#1d6a3d',
    color: '#fff',
    padding: '0 18px',
    fontWeight: 800,
    cursor: 'pointer',
  }

  if (activeRound) {
    const activeCourse = getCourseCatalogEntry(activeRound.courseId)
    return (
      <main style={shell}>
        <section style={card}>
          <div style={{ color: '#8ed3a8', fontSize: 12, fontWeight: 800, letterSpacing: '0.08em' }}>
            ROUND ARMED
          </div>
          <h1 style={{ margin: '8px 0 6px', fontSize: 30 }}>{activeCourse.name}</h1>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{activeRound.teeSet} tees</div>
          <p style={{ color: '#aeb9b0', lineHeight: 1.55, marginTop: 18 }}>
            Looper is starting on Hole 1, Shot 1 using the mapped {activeRound.teeSet} tee. Set the same course and tee in GSPro. Looper will trust this selection now and use completed-shot GSPro data as validation evidence later.
          </p>
          <div style={{ display: 'grid', gap: 8, margin: '22px 0', padding: 16, borderRadius: 10, background: '#0d1710', border: '1px solid #26372b' }}>
            <div><strong>Course:</strong> {activeCourse.name}</div>
            <div><strong>Tees:</strong> {activeRound.teeSet}</div>
            <div><strong>Looper state:</strong> H1 · Shot 1 · tee assumed from round setup</div>
            <div><strong>GSPro:</strong> set the same course + tee, then play normally</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a href="/live-caddie" style={{ ...primary, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
              OPEN LIVE CADDIE
            </a>
            <button type="button" onClick={resetRound} style={{ minHeight: 46, borderRadius: 9, border: '1px solid #526057', background: 'transparent', color: '#d8dfda', padding: '0 16px', fontWeight: 700 }}>
              CHANGE ROUND
            </button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main style={shell}>
      <section style={card}>
        <div style={{ color: '#8ed3a8', fontSize: 12, fontWeight: 800, letterSpacing: '0.08em' }}>
          LIVE CADDIE
        </div>
        <h1 style={{ margin: '8px 0 6px', fontSize: 30 }}>Start a Round</h1>
        <p style={{ margin: '0 0 24px', color: '#9da99f', lineHeight: 1.5 }}>
          Choose the course and tee you intend to use in GSPro. Looper will use that tee as the starting assumption for the whole round.
        </p>

        <label style={{ display: 'block', marginBottom: 18, color: '#cbd4cd', fontWeight: 700 }}>
          Course
          <select
            value={courseId}
            onChange={(event) => {
              setCourseId(event.target.value as CourseId)
              setTeeSet('')
            }}
            style={input}
          >
            {courseRegistry.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={entry.id !== GREYWOLF_COURSE_ID}>
                {entry.name}{entry.id === GREYWOLF_COURSE_ID ? '' : ' — live validation pending'}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'block', marginBottom: 22, color: '#cbd4cd', fontWeight: 700 }}>
          Tees
          <select
            value={teeSet}
            onChange={(event) => setTeeSet(event.target.value)}
            disabled={loadingTees || teeOptions.length === 0}
            style={input}
          >
            {teeOptions.length === 0 ? <option value="">{loadingTees ? 'Loading tees…' : 'No mapped tees'}</option> : null}
            {teeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>

        {error ? (
          <div style={{ marginBottom: 18, padding: 12, borderRadius: 9, border: '1px solid rgba(248, 113, 113, 0.45)', background: 'rgba(127, 29, 29, 0.18)', color: '#fecaca' }}>
            {error}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => void startRound()}
          disabled={starting || loadingTees || !teeSet.trim() || course.id !== GREYWOLF_COURSE_ID}
          style={{ ...primary, width: '100%', opacity: starting || !teeSet.trim() ? 0.55 : 1 }}
        >
          {starting ? 'STARTING…' : 'START ROUND'}
        </button>
      </section>
    </main>
  )
}
