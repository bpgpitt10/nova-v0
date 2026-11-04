import { useCallback, useEffect, useMemo, useState } from 'react'
import { readLooperCompanionCourseLibrary, type LooperCompanionInstalledCourse } from '../adapters/looperCompanion'
import { courseRegistry, resolveCourseIdFromGsproName, type CourseId } from '../courseGeometry/courseCatalog'
import { isNativePositionsEnabled, loadNativeCourseContext, type NativeCourseStatus } from '../courseGeometry/nativeCourseRuntime'
import {
  CourseSearchBusyError,
  courseNameMatchScore,
  courseSlugFromName,
  findGolfCourseFor,
  listCourseLoads,
  minutesLeft,
  requestCourseLoad,
  searchGolfCourses,
  STAGE_LABELS,
  typicalLoadMinutes,
  type CourseLoadRow,
  type GolfCourseSearchResult,
} from '../courseLoading/courseLoads'
import './LoadCoursePage.css'

const ACTIVE = new Set(['queued', 'running', 'publishing'])

// One GSPro check at a time: each may fit a registration (~1 s + package download).
let checkQueue: Promise<unknown> = Promise.resolve()
const queuedCheck = <T,>(run: () => Promise<T>): Promise<T> => {
  const next = checkQueue.then(run, run)
  checkQueue = next.catch(() => undefined)
  return next
}

const matchText = (status: NativeCourseStatus | null): { text: string; tone: 'ok' | 'bad' | 'note' } | null => {
  if (!status) return { text: 'Checking against your GSPro course…', tone: 'note' }
  switch (status.state) {
    case 'ready':
      return { text: `Matches your GSPro course (grade ${status.grade})`, tone: 'ok' }
    case 'other-course':
      return status.grade ? { text: `Matches your GSPro course (grade ${status.grade})`, tone: 'ok' } : null
    case 'registration-failed':
      // Greywolf (our first course) predates the package this check needs:
      // not a mismatch, just not set up.
      if (status.reason === 'no course package') {
        return { text: "Plays in Looper; the GSPro position match isn't set up for this course yet.", tone: 'note' }
      }
      return { text: `Loaded, but doesn't line up with your GSPro course: ${status.reason}`, tone: 'bad' }
    case 'layout-mismatch':
      return { text: 'Loaded, but your GSPro version has different greens or pins.', tone: 'bad' }
    case 'gkd-not-found':
      return { text: `Can't read ${status.courseKey} from your GSPro library to check it.`, tone: 'note' }
    case 'registering':
      return { text: 'Checking against your GSPro course…', tone: 'note' }
    case 'error':
      return { text: `Couldn't check against GSPro: ${status.message}`, tone: 'note' }
    default:
      return null
  }
}

/**
 * A course can load "ready" and still not line up with the player's GSPro
 * version (Kiawah, 11/2). For loaded courses that are installed here, run the
 * same check Live Caddie runs (do GSPro's greens and heights fit the map?) and
 * say so on this page.
 */
function GsproMatch({ courseId, courseKey }: Readonly<{ courseId: CourseId; courseKey: string }>) {
  const [status, setStatus] = useState<NativeCourseStatus | null>(null)
  useEffect(() => {
    if (!isNativePositionsEnabled()) return
    let alive = true
    void queuedCheck(() => loadNativeCourseContext(courseId, courseKey))
      .then((result) => { if (alive) setStatus(result.status) })
      .catch((error: unknown) => { if (alive) setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) }) })
    return () => { alive = false }
  }, [courseId, courseKey])
  if (!isNativePositionsEnabled()) return null
  const shown = matchText(status)
  if (!shown) return null
  return <span className={shown.tone === 'ok' ? 'load-course-ready' : shown.tone === 'bad' ? 'load-course-failed' : 'load-course-progress'}>{shown.text}</span>
}

/** A range, putting course or fictional course: nothing on OpenStreetMap to load. */
const notARealCourse = (course: Readonly<{ courseName?: string | null; courseKey?: string | null; location?: string | null }>) => {
  const name = `${course.courseName ?? ''} ${course.courseKey ?? ''}`
  return /\bfictional\b/i.test(course.location ?? '')
    || /\bputting (course|green)\b/i.test(name)
    || /\b(driving|practice|multi) range\b/i.test(name)
    || /^\s*gspro\b/i.test(course.courseName ?? '')
}

const loadedSlugs = () => new Set<string>(courseRegistry.map((entry) => entry.slug))

const statusText = (row: CourseLoadRow) => {
  if (row.status === 'queued') return 'Queued · starting shortly'
  if (row.status === 'publishing') return `${STAGE_LABELS.publish} · ~${minutesLeft(row)} min left`
  if (row.status === 'running') {
    const step = row.stage_index && row.stage_count ? `Step ${row.stage_index} of ${row.stage_count}: ` : ''
    return `${step}${STAGE_LABELS[row.stage ?? ''] ?? 'Loading'} · ~${minutesLeft(row)} min left`
  }
  if (row.status === 'ready') return 'Ready — reload the page to play it'
  return `Couldn't load: ${row.error ?? 'unknown error'}`
}

/**
 * Load a course: pick one of your GSPro courses or search by name, click Load,
 * and Looper builds it (map, hazards, trees, terrain) and publishes it to
 * thelooper.golf for everyone. Typical wait ~10 minutes.
 */
export default function LoadCoursePage() {
  const [loads, setLoads] = useState<CourseLoadRow[]>([])
  const [loadsError, setLoadsError] = useState<string | null>(null)
  const [library, setLibrary] = useState<LooperCompanionInstalledCourse[] | null>(null)
  const [libraryNote, setLibraryNote] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GolfCourseSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // When an installed GSPro course can't be matched automatically, loads picked
  // from the search results stay linked to it, so Live Caddie recognizes the round.
  const [linkedGspro, setLinkedGspro] = useState<{ courseKey: string; courseName: string } | null>(null)
  const slugs = useMemo(loadedSlugs, [])

  const refresh = useCallback(async () => {
    try {
      setLoads(await listCourseLoads())
      setLoadsError(null)
    } catch (error) {
      setLoadsError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  const anyActive = loads.some((row) => ACTIVE.has(row.status))
  useEffect(() => {
    if (!anyActive) return
    const timer = window.setInterval(() => { void refresh() }, 10000)
    return () => window.clearInterval(timer)
  }, [anyActive, refresh])

  useEffect(() => {
    void readLooperCompanionCourseLibrary()
      .then((data) => {
        setLibrary(data.courses)
        if (!data.courses.length) setLibraryNote('The Looper Companion found no GSPro courses on this PC.')
      })
      .catch(() => setLibraryNote('Start the Looper Companion on your GSPro PC to see your installed courses here.'))
  }, [])

  const latestFor = (slug: string) => loads.find((row) => row.slug === slug) ?? null
  const courseIdFor = (slug: string): CourseId | null =>
    (courseRegistry.find((entry) => entry.slug === slug)?.id as CourseId | undefined) ?? null

  const queue = async (key: string, course: Parameters<typeof requestCourseLoad>[0]) => {
    setBusyKey(key)
    setMessage(null)
    try {
      const { dispatched } = await requestCourseLoad(course)
      setMessage(dispatched
        ? `Loading ${course.name}. Usually ready in about ${typicalLoadMinutes()} minutes; you can leave this page.`
        : `${course.name} is queued. It will start when the loader next runs.`)
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyKey(null)
    }
  }

  const loadInstalled = async (course: LooperCompanionInstalledCourse) => {
    setBusyKey(course.courseKey)
    setMessage(`Finding ${course.courseName} on the map…`)
    let match: Awaited<ReturnType<typeof findGolfCourseFor>>
    try {
      match = await findGolfCourseFor(course.courseName, course.location)
    } catch (error) {
      setBusyKey(null)
      setMessage(error instanceof CourseSearchBusyError
        ? 'OpenStreetMap search is busy right now (too many searches in a row). Wait a minute and press Load again.'
        : `Couldn't search OpenStreetMap: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!match) {
      setBusyKey(null)
      const name = course.courseName || course.courseKey
      setLinkedGspro({ courseKey: course.courseKey, courseName: name })
      setQuery(name)
      setMessage(`Couldn't match ${name} on OpenStreetMap automatically. Pick it from the search results below, or search a different name.`)
      void runSearch(name)
      return
    }
    await queue(course.courseKey, {
      name: match.name || course.courseName, location: match.location || course.location,
      lat: match.lat, lon: match.lon, osmType: match.osmType, osmId: match.osmId, gsproCourseKey: course.courseKey,
    })
  }

  const runSearch = async (text = query) => {
    setSearching(true)
    try {
      setResults(await searchGolfCourses(text))
    } catch (error) {
      setMessage(error instanceof CourseSearchBusyError
        ? 'OpenStreetMap search is busy right now. Wait a minute and search again.'
        : error instanceof Error ? error.message : String(error))
      setResults(null)
    } finally {
      setSearching(false)
    }
  }

  const rowAction = (slug: string, key: string, onLoad: () => void) => {
    if (slugs.has(slug)) return <span className="load-course-ready">Ready to play</span>
    const row = latestFor(slug)
    if (row && ACTIVE.has(row.status)) return <span className="load-course-progress">{statusText(row)}</span>
    if (row?.status === 'ready') return <span className="load-course-ready">{statusText(row)}</span>
    return (
      <span className="load-course-actions">
        {row?.status === 'failed' ? <span className="load-course-failed">{statusText(row)}</span> : null}
        <button type="button" disabled={busyKey !== null} onClick={onLoad}>
          {busyKey === key ? 'Starting…' : row?.status === 'failed' ? 'Try again' : 'Load'}
        </button>
      </span>
    )
  }

  // Ranges, putting courses and fictional courses have no real-world map to load.
  const loadable = (library ?? []).filter((course) => !notARealCourse(course))
  const skipped = (library ?? []).length - loadable.length
  const installed = loadable.map((course) => {
    const known = resolveCourseIdFromGsproName(course.courseKey) ?? resolveCourseIdFromGsproName(course.courseName)
    const slug = known ? courseRegistry.find((e) => e.id === known)?.slug ?? courseSlugFromName(course.courseName)
      : courseSlugFromName(course.courseName)
    return { course, slug }
  })

  return (
    <main className="load-course-page">
      <header>
        <span className="load-course-kicker">COURSES</span>
        <h1>Load a course</h1>
        <p>
          Pick one of your GSPro courses or search by name, then click <strong>Load</strong>. Looper builds the
          course (holes, hazards, trees and terrain from public map and LiDAR data) and adds it to thelooper.golf
          for everyone. It usually takes about {typicalLoadMinutes()} minutes; you can close this page while it runs.
        </p>
        <a className="load-course-back" href="/round-setup">← Back to Start a Round</a>
      </header>

      {message ? <p className="load-course-message">{message}</p> : null}
      {loadsError ? <p className="load-course-message">Sign in to load courses ({loadsError}).</p> : null}

      <section>
        <h2>Your GSPro courses</h2>
        {libraryNote ? <p className="load-course-note">{libraryNote}</p> : null}
        {library === null && !libraryNote ? <p className="load-course-note">Looking for your GSPro courses…</p> : null}
        {skipped > 0 ? (
          <p className="load-course-note">
            {skipped} range, putting or fictional course{skipped === 1 ? '' : 's'} hidden: there's no real-world map to load for {skipped === 1 ? 'it' : 'them'}.
          </p>
        ) : null}
        <ul className="load-course-list">
          {installed.map(({ course, slug }) => (
            <li key={course.courseKey}>
              <div>
                <strong>{course.courseName || course.courseKey}</strong>
                <span>{[course.location, `${course.holes} holes`].filter(Boolean).join(' · ')}</span>
              </div>
              <span className="load-course-actions">
                {rowAction(slug, course.courseKey, () => { void loadInstalled(course) })}
                {slugs.has(slug) && courseIdFor(slug)
                  ? <GsproMatch courseId={courseIdFor(slug)!} courseKey={course.courseKey} /> : null}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Search for a course</h2>
        {linkedGspro ? (
          <p className="load-course-note">
            A course you load from these results will be linked to your GSPro course
            {' '}<strong>{linkedGspro.courseName}</strong>.{' '}
            <button type="button" className="load-course-unlink" onClick={() => setLinkedGspro(null)}>Don't link</button>
          </p>
        ) : null}
        <form className="load-course-search" onSubmit={(event) => {
          event.preventDefault()
          // A link to a GSPro course is for finding THAT course. A search for
          // something else drops it: on 11/3 a Mammoth Dunes link stuck and a
          // later Pebble Beach load was linked to Mammoth Dunes.
          if (linkedGspro && courseNameMatchScore(query, linkedGspro.courseName) < 0.3) setLinkedGspro(null)
          void runSearch()
        }}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. Erin Hills, Pinehurst No. 2" />
          <button type="submit" disabled={searching || query.trim().length < 3}>{searching ? 'Searching…' : 'Search'}</button>
        </form>
        {results && results.length === 0 ? <p className="load-course-note">No golf courses found on OpenStreetMap for that name.</p> : null}
        <ul className="load-course-list">
          {(results ?? []).map((result) => {
            const slug = courseSlugFromName(result.name)
            const key = `${result.osmType}/${result.osmId}`
            return (
              <li key={key}>
                <div>
                  <strong>{result.name}</strong>
                  <span>{result.location}</span>
                </div>
                {rowAction(slug, key, () => {
                  void queue(key, { name: result.name, location: result.location, lat: result.lat, lon: result.lon,
                    osmType: result.osmType, osmId: result.osmId, gsproCourseKey: linkedGspro?.courseKey ?? null })
                  // One link, one load.
                  setLinkedGspro(null)
                })}
              </li>
            )
          })}
        </ul>
      </section>

      {loads.length ? (
        <section>
          <h2>Recent loads</h2>
          <ul className="load-course-list">
            {loads.slice(0, 12).map((row) => (
              <li key={row.id}>
                <div>
                  <strong>{row.course_name}</strong>
                  <span>{row.location ?? ''}</span>
                </div>
                <span className={row.status === 'failed' ? 'load-course-failed' : row.status === 'ready' ? 'load-course-ready' : 'load-course-progress'}>
                  {statusText(row)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="load-course-note">
        Courses must be on OpenStreetMap. Trees and detailed terrain need USGS LiDAR (US courses). Map data © OpenStreetMap
        contributors; search by Nominatim.
      </p>
    </main>
  )
}
