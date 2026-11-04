import { useEffect, useMemo, useState } from 'react'
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
  loadNativeCourseContext,
  NATIVE_POSITIONS_CHANGED_EVENT,
  nativeStatusEventIsFor,
  nativeTeeSetValue,
  type NativeCourseStatus,
} from '../courseGeometry/nativeCourseRuntime'
import NativePositionsBetaPanel from '../components/NativePositionsBetaPanel'
import { nativeTeeSetOptions } from '../courseGeometry/nativeGkd'
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
import looperLogoWhite from '../assets/LooperLogoWhite.png'
import './RoundSetupPage.css'

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
const ACTIVE_ROUND_RECENT_MS = 12 * 60 * 60 * 1000

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
  // Display text per option (GSPro tee names are marked as such).
  const [teeOptionText, setTeeOptionText] = useState<Record<string, string>>({})
  const [loadingTees, setLoadingTees] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeRound, setActiveRound] = useState<ActiveLiveCaddieRound | null>(() =>
    loadActiveLiveCaddieRound(),
  )

  const course = useMemo(() => getCourseCatalogEntry(courseId), [courseId])

  // Native positions (beta): reload the tee list when the beta turns on/off or
  // the course files become available, so GSPro's tee names appear here.
  const [nativeState, setNativeState] = useState<NativeCourseStatus['state'] | null>(null)
  useEffect(() => {
    const onChange = (event: Event) => {
      if (!nativeStatusEventIsFor(event, courseId)) return
      const state = (event as CustomEvent<NativeCourseStatus>).detail?.state ?? null
      if (state === 'ready' || state === 'off') setNativeState(state)
    }
    window.addEventListener(NATIVE_POSITIONS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(NATIVE_POSITIONS_CHANGED_EVENT, onChange)
  }, [courseId])

  useEffect(() => {
    let cancelled = false
    setLoadingTees(true)
    setError(null)
    void loadCourseTeeCandidates(courseId, 1)
      .then(async (candidates) => {
        // Native positions (beta): when the player's GKD is verified for this
        // course, offer GSPro's own tee sets (what they pick in GSPro).
        const native = await loadNativeCourseContext(courseId, null).catch(() => null)
        // Alternate layouts (GKDalt, e.g. "Farmlinks Kids") move every tee, so
        // their tee sets are offered as "White (Farmlinks Kids)".
        const nativeOptions = native?.context
          ? native.context.layouts.flatMap((layout) => nativeTeeSetOptions(layout.layout).map((option) => ({
              value: nativeTeeSetValue(option.name, layout),
              label: layout.kind === 'alt' ? `${option.name} — ${layout.name} (GSPro tee)` : `${option.name} (GSPro tee)`,
            })))
          : []
        return { candidates, nativeOptions }
      })
      .then(({ candidates, nativeOptions }) => {
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
        const useNative = nativeOptions.length > 0
        const finalLabels = useNative ? nativeOptions.map((option) => option.value) : labels
        setTeeOptionText(useNative
          ? Object.fromEntries(nativeOptions.map((option) => [
              // Name only: GKD distances are route-to-green-centre metres and
              // would not match the yardage GSPro shows on its scorecard.
              option.value, option.label,
            ]))
          : {})
        setTeeOptions(finalLabels)
        const storedTee = loadRoundTeeSelection(courseId)?.teeSet
        // A saved OSM pick ("Tee 1 (Back)") is not a GSPro tee name; with the
        // GSPro list showing, start from that list instead of "not listed".
        const saved = useNative && storedTee && !finalLabels.some(label => normalize(label) === normalize(storedTee))
          ? undefined
          : storedTee
        if (saved && !finalLabels.some(label => normalize(label) === normalize(saved))) {
          // Honor the user's actual GSPro tee selection even when OSM has no
          // matching named tee. The fallback will explicitly stay provisional.
          setTeeSet(OTHER_TEE)
          setUnmappedTeeName(saved)
        } else {
          setTeeSet(saved ?? finalLabels.find(label => normalize(label) === (useNative ? 'white' : 'blue')) ?? finalLabels[0] ?? OTHER_TEE)
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
  }, [courseId, nativeState])

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
      // Straight into Live Caddie: the old "round armed" confirmation page only
      // repeated what was just chosen. A full load (as that page's link did) so a
      // Live Caddie kept mounted from earlier can't hold on to the previous round.
      window.location.assign('/live-caddie')
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

  // Only a round from today counts as "in progress"; an old armed round is just
  // replaced by the next Start Round.
  const activeIsRecent =
    activeRound != null && Date.now() - Date.parse(activeRound.startedAt) < ACTIVE_ROUND_RECENT_MS
  const activeCourse = activeRound && activeIsRecent ? getCourseCatalogEntry(activeRound.courseId) : null
  const startDisabled =
    starting || loadingTees || !actualTeeSet || actualTeeSet.length > 60 || course.packageStatus !== 'ready'

  return (
    <main className="round-setup-page">
      <div className="round-setup-shell">
        <a aria-label="Back to The Looper" className="round-setup-logo" href="/looper">
          <img alt="The Looper" src={looperLogoWhite} />
        </a>

        <section className="round-setup-panel" aria-labelledby="round-setup-title">
          <span className="round-setup-kicker">Live Caddie</span>
          <h1 id="round-setup-title">Start a Round</h1>
          <p className="round-setup-lead">
            Pick the course and tee you&apos;re playing in GSPro. Looper takes it from the first tee shot.
          </p>

          {activeRound && activeCourse ? (
            <div className="round-setup-active" role="status">
              <span className="round-setup-active-dot" aria-hidden="true" />
              <span>
                Round in progress: <strong>{activeCourse.name}</strong>, {activeRound.teeSet} tees.
              </span>
              <a href="/live-caddie">Resume →</a>
              <button onClick={resetRound} type="button">End it</button>
            </div>
          ) : null}

          <label className="round-setup-field">
            <span className="round-setup-label">Course</span>
            <select
              value={courseId}
              onChange={(event) => {
                setCourseId(event.target.value as CourseId)
                setTeeSet('')
                setUnmappedTeeName('')
              }}
            >
              {courseRegistry.map((entry) => (
                <option key={entry.id} value={entry.id} disabled={entry.packageStatus !== 'ready'}>
                  {entry.name}{entry.packageStatus === 'ready' ? '' : ' — live validation pending'}
                </option>
              ))}
            </select>
            <a className="round-setup-hint-link" href="/courses">Don&apos;t see your course? Load a course →</a>
          </label>

          <div className="round-setup-native">
            <NativePositionsBetaPanel courseId={courseId} courseKey={null} />
          </div>

          <label className="round-setup-field">
            <span className="round-setup-label">Tees</span>
            <select
              value={teeSet}
              onChange={(event) => setTeeSet(event.target.value)}
              disabled={loadingTees}
            >
              {teeOptions.length === 0 ? <option value="">{loadingTees ? 'Loading mapped tees…' : 'No mapped tee names'}</option> : null}
              {teeOptions.map((option) => <option key={option} value={option}>{teeOptionText[option] ?? option}</option>)}
              <option value={OTHER_TEE}>My GSPro tee is not listed…</option>
            </select>
            {teeSet === OTHER_TEE ? (
              <input
                aria-label="Actual tee selected in GSPro"
                maxLength={60}
                onChange={(event) => setUnmappedTeeName(event.target.value)}
                placeholder="Type the actual GSPro tee color/name (e.g. Blue)"
                type="text"
                value={unmappedTeeName}
              />
            ) : null}
            <span className="round-setup-hint">
              Use the tee name you picked in GSPro. A tee Looper hasn&apos;t mapped starts as an estimate, and your shots confirm it.
            </span>
          </label>

          {error ? <p className="round-setup-error" role="alert">{error}</p> : null}

          <button
            className="round-setup-start"
            disabled={startDisabled}
            onClick={() => void startRound()}
            type="button"
          >
            {starting ? 'Starting…' : 'Start Round'}
          </button>
        </section>
      </div>
    </main>
  )
}
