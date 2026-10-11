import { useEffect, useMemo, useState, type CSSProperties } from 'react'
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
import { getAllowedUserRecord, getCurrentLooperUser, getSupabaseClient } from '../cloud/supabaseClient'

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
  const [requestEnabled, setRequestEnabled] = useState(false)
  const [requestName, setRequestName] = useState('')
  const [requestBusy, setRequestBusy] = useState(false)
  const [requestResult, setRequestResult] = useState<string | null>(null)
  const [activeRound, setActiveRound] = useState<ActiveLiveCaddieRound | null>(() =>
    loadActiveLiveCaddieRound(),
  )

  const course = useMemo(() => getCourseCatalogEntry(courseId), [courseId])

  useEffect(() => {
    let alive = true
    void getCurrentLooperUser()
      .then(async (user) => user ? getAllowedUserRecord(user) : null)
      .then((record) => { if (alive) setRequestEnabled(record?.is_admin === true && record.enabled === true) })
      .catch(() => { if (alive) setRequestEnabled(false) })
    return () => { alive = false }
  }, [])

  const submitCourseRequest = async () => {
    setRequestBusy(true)
    setRequestResult(null)
    try {
      const client = await getSupabaseClient()
      const auth = await client.auth.getSession()
      const token = auth.data.session?.access_token
      if (!token) throw new Error('Sign in to request a course.')
      const response = await fetch('/api/course-request', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: requestName.trim() }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`)
      setRequestResult('Request queued for the staging importer. It is not playable until compilation, validation and publication finish.')
    } catch (requestError) {
      setRequestResult(requestError instanceof Error ? requestError.message : String(requestError))
    } finally { setRequestBusy(false) }
  }

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
        if (labels.length > 0 && !labels.some((label) => normalize(label) === normalize(teeSet))) {
          const saved = loadRoundTeeSelection(courseId)
          const next = saved?.teeSet && labels.some((label) => normalize(label) === normalize(saved.teeSet))
            ? saved.teeSet
            : labels.find((label) => normalize(label) === 'blue') ?? labels[0]
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
        candidateTeeValues(candidate)
          .some((value) => normalize(value) === selection.normalizedTeeSet),
      )
      if (exactMatches.length !== 1) {
        throw new Error(
          exactMatches.length === 0
            ? `${selection.teeSet} does not have a usable Hole 1 tee assumption yet.`
            : `${selection.teeSet} maps to multiple Hole 1 tee candidates; Looper will not guess.`,
        )
      }

      // loadCourseHoleGeometry has already resolved the persisted tee selection
      // through the same generic package contract used for every later hole.
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
            Looper is using the mapped {activeRound.teeSet} tee assumption for this round. Set the same course and tee in GSPro. Looper will keep that tee identity authoritative and use completed-shot GSPro data as validation evidence later.
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
            disabled={loadingTees || teeOptions.length === 0}
            style={input}
          >
            {teeOptions.length === 0 ? <option value="">{loadingTees ? 'Loading tee assumptions…' : 'No mapped tee assumptions'}</option> : null}
            {teeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>

        <div style={{ margin: '-10px 0 20px', color: '#7f8d82', fontSize: 12, lineHeight: 1.45 }}>
          Your explicit tee selection is authoritative for the round. GSPro completed shots can be used to validate the mapped tee assumptions over time.
        </div>

        {error ? (
          <div style={{ marginBottom: 18, padding: 12, borderRadius: 9, border: '1px solid rgba(248, 113, 113, 0.45)', background: 'rgba(127, 29, 29, 0.18)', color: '#fecaca' }}>
            {error}
          </div>
        ) : null}

        {requestEnabled ? (
          <div style={{ marginBottom: 18, padding: 14, border: '1px solid #314233', borderRadius: 9 }}>
            <div style={{ fontWeight: 750, marginBottom: 6 }}>Add a Course · admin staging</div>
            <p style={{ fontSize: 12, color: '#aeb9b0', margin: '0 0 10px' }}>Enter only the course name. Looper will resolve its identity and attempt a cold import. Ambiguous or incomplete OSM mapping will fail rather than guess.</p>
            <input value={requestName} onChange={(event) => setRequestName(event.target.value)} placeholder="Course name" maxLength={120} style={input} />
            <button type="button" disabled={requestBusy || requestName.trim().length < 3} onClick={() => void submitCourseRequest()} style={{ ...primary, marginTop: 10, opacity: requestBusy ? 0.5 : 1 }}>
              {requestBusy ? 'REQUESTING…' : 'Request Course'}
            </button>
            {requestResult ? <p role="status" style={{ color: '#cfd8cd', fontSize: 12 }}>{requestResult}</p> : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => void startRound()}
          disabled={starting || loadingTees || !teeSet.trim() || course.packageStatus !== 'ready'}
          style={{ ...primary, width: '100%', opacity: starting || loadingTees || !teeSet.trim() || course.packageStatus !== 'ready' ? 0.55 : 1 }}
        >
          {starting ? 'STARTING…' : 'START ROUND'}
        </button>
      </section>
    </main>
  )
}