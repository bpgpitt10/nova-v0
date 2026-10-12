import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  GREYWOLF_COURSE_ID,
  courseRegistry,
  getCourseCatalogEntry,
  type CourseId,
} from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import { estimateProvisionalTee } from '../courseGeometry/provisionalTeeEstimate'
import { courseGeometryFingerprint } from '../courseGeometry/shotOneTeeResolver'
import { loadTeeCalibration } from '../courseGeometry/teeCalibrationStore'
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

const candidateTeeValues = (candidate: CourseTeeCandidate) => [
  candidate.teeSet,
  ...(candidate.teeAliases ?? []),
  candidate.color,
  candidate.label,
  candidate.name,
  candidate.ref,
].filter((value): value is string => Boolean(value?.trim()))

const canonicalTeeOption = (candidate: CourseTeeCandidate) =>
  candidate.teeSet?.trim() || null

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
const OTHER_TEE = '__looper-unmapped-tee__'

export default function RoundSetupPage() {
  const initialCourse = loadLastSelectedCourseId()
  const initialCourseId = initialCourse === '__no-course-selected__'
    ? GREYWOLF_COURSE_ID
    : initialCourse
  const savedTee = loadRoundTeeSelection(initialCourseId)

  const [courseId, setCourseId] = useState<CourseId>(initialCourseId)
  const [teeSet, setTeeSet] = useState(savedTee?.teeSet ?? '')
  const [unmappedTeeName, setUnmappedTeeName] = useState('')
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
        // teeSet is the product contract. Names/colors/refs remain candidate
        // evidence and matching aliases, but must not create duplicate choices
        // in the Round Setup dropdown.
        const labels = [...new Set(candidates.map(canonicalTeeOption).filter((value): value is string => Boolean(value)))]
          .sort((left, right) => {
            const preferred = ['Grey', 'Black', 'Blue', 'Gold', 'White', 'Green']
            const leftIndex = preferred.findIndex((value) => normalize(value) === normalize(left))
            const rightIndex = preferred.findIndex((value) => normalize(value) === normalize(right))
            if (leftIndex >= 0 || rightIndex >= 0) {
              if (leftIndex < 0) return 1
              if (rightIndex < 0) return -1
              return leftIndex - rightIndex
            }
            return left.localeCompare(right, undefined, { numeric: true })
          })
        setTeeOptions(labels)
        const saved = loadRoundTeeSelection(courseId)?.teeSet
        if (saved && !labels.some(label => normalize(label) === normalize(saved))) {
          // Honor the user's actual GSPro tee selection even when OSM has no
          // matching named tee. The fallback will explicitly stay provisional.
          setTeeSet(OTHER_TEE)
          setUnmappedTeeName(saved)
        } else {
          setTeeSet(saved ?? labels.find(label => normalize(label) === 'blue') ?? labels[0] ?? OTHER_TEE)
          setUnmappedTeeName('')
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

  const actualTeeSet = teeSet === OTHER_TEE ? unmappedTeeName.trim() : teeSet.trim()
  const startRound = async () => {
    if (!actualTeeSet || actualTeeSet.length > 60) return
    setStarting(true)
    setError(null)
    try {
      saveLastSelectedCourseId(courseId)
      const selection = saveRoundTeeSelection(courseId, actualTeeSet)
      if (!selection) throw new Error('Choose a tee set before starting the round.')

      const geometry = await loadCourseHoleGeometry(courseId, 1)
      const exactMatches = (geometry.teeCandidates ?? []).filter((candidate) =>
        candidateTeeValues(candidate)
          .some((value) => normalize(value) === selection.normalizedTeeSet),
      )
      const calibration = loadTeeCalibration(
        courseGeometryFingerprint(geometry), 1, selection.normalizedTeeSet,
      )
      const hasLockedTee = calibration?.status === 'locked'
      const provisional = !hasLockedTee && exactMatches.length !== 1
        ? estimateProvisionalTee(geometry) : null
      if (provisional?.status === 'blocked') {
        throw new Error(
          'Selected tee is not mapped, and a provisional Hole 1 tee cannot be estimated safely: ' +
          provisional.reason,
        )
      }

      // The selected tee label is supplied by the golfer, not silently
      // inferred from whichever OSM tee happens to be nearest. The route
      // marker is a provisional playing assumption, NEVER a verified tee.
      const round = startLiveCaddieRound({
        courseId,
        teeSet: selection.teeSet,
        assumedTeeLocalYds: provisional?.status === 'provisional'
          ? provisional.point : geometry.markers.tee,
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

  const shell: CSSProperties = {
    minHeight: '100vh',
    background: '#0b120d',
    color: '#f5f7f4',
    padding: '48px 24px',
    boxSizing: 'border-box',
  }
  const card: CSSProperties = {
    width: 'min(620px, 100%)',
    margin: '0 auto',
    background: '#111c14',
    border: '1px solid #2b3a2f',
    borderRadius: 16,
    padding: 28,
    boxShadow: '0 18px 54px rgba(0,0,0,0.28)',
  }
  const input: CSSProperties = {
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
  const primary: CSSProperties = {
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
            {activeRound.phase === 'armed' ? 'ROUND ARMED' : 'ROUND ACTIVE'}
          </div>
          <h1 style={{ margin: '8px 0 6px', fontSize: 30 }}>{activeCourse.name}</h1>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{activeRound.teeSet} tees</div>
          <p style={{ color: '#aeb9b0', lineHeight: 1.55, marginTop: 18 }}>
            Looper is using a map-based {activeRound.teeSet} tee assumption for this round; it may be provisional if OSM has no matching named tee. Set the same course and tee in GSPro. Looper will keep that tee identity authoritative and use completed-shot GSPro data as validation evidence later.
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
          Choose the exact course and tee you intend to use in GSPro. If the tee is not mapped, Looper can start with a clearly provisional estimate.
        </p>

        <label style={{ display: 'block', marginBottom: 18, color: '#cbd4cd', fontWeight: 700 }}>
          Course
          <select
            value={courseId}
            onChange={(event) => {
              setCourseId(event.target.value as CourseId)
              setTeeSet('')
              setUnmappedTeeName('')
            }}
            style={input}
          >
            {courseRegistry.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={entry.packageStatus !== 'ready'}>
                {entry.name}{entry.packageStatus === 'ready' ? '' : ' — live validation pending'}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'block', marginBottom: 22, color: '#cbd4cd', fontWeight: 700 }}>
          Tees
          <select
            value={teeSet}
            onChange={(event) => setTeeSet(event.target.value)}
            disabled={loadingTees}
            style={input}
          >
            {teeOptions.length === 0 ? <option value="">{loadingTees ? 'Loading mapped tees…' : 'No mapped tee names'}</option> : null}
            {teeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            <option value={OTHER_TEE}>My GSPro tee is not listed…</option>
          </select>
          {teeSet === OTHER_TEE ? (
            <input type="text" value={unmappedTeeName} maxLength={60}
              onChange={event => setUnmappedTeeName(event.target.value)}
              placeholder="Type the actual GSPro tee color/name (e.g. Blue)"
              aria-label="Actual tee selected in GSPro"
              style={input} />
          ) : null}
        </label>

        <div style={{ margin: '-10px 0 20px', color: '#7f8d82', fontSize: 12, lineHeight: 1.45 }}>
          Use the tee name you actually selected in GSPro. An unmatched tee starts as a provisional estimate, not a confirmed tee. Physical shots can validate it later.
        </div>

        {error ? (
          <div style={{ marginBottom: 18, padding: 12, borderRadius: 9, border: '1px solid rgba(248, 113, 113, 0.45)', background: 'rgba(127, 29, 29, 0.18)', color: '#fecaca' }}>
            {error}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => void startRound()}
          disabled={starting || loadingTees || !actualTeeSet || actualTeeSet.length > 60 || course.packageStatus !== 'ready'}
          style={{ ...primary, width: '100%', opacity: starting || loadingTees || !teeSet.trim() || course.packageStatus !== 'ready' ? 0.55 : 1 }}
        >
          {starting ? 'STARTING…' : 'START ROUND'}
        </button>
      </section>
    </main>
  )
}