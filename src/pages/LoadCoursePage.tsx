import { useCallback, useEffect, useMemo, useState } from 'react'
import { readLooperCompanionCourseLibrary, type LooperCompanionInstalledCourse } from '../adapters/looperCompanion'
import { courseRegistry, resolveCourseIdFromGsproName } from '../courseGeometry/courseCatalog'
import {
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

const loadedSlugs = () => new Set(courseRegistry.map((entry) => entry.slug))

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
    const match = await findGolfCourseFor(course.courseName, course.location)
    if (!match) {
      setBusyKey(null)
      setMessage(`Couldn't find ${course.courseName} on OpenStreetMap. Try the search below with a different name.`)
      return
    }
    await queue(course.courseKey, {
      name: match.name || course.courseName, location: match.location || course.location,
      lat: match.lat, lon: match.lon, osmType: match.osmType, osmId: match.osmId, gsproCourseKey: course.courseKey,
    })
  }

  const runSearch = async () => {
    setSearching(true)
    setMessage(null)
    try {
      setResults(await searchGolfCourses(query))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setResults([])
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

  const installed = (library ?? []).map((course) => {
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
        <ul className="load-course-list">
          {installed.map(({ course, slug }) => (
            <li key={course.courseKey}>
              <div>
                <strong>{course.courseName || course.courseKey}</strong>
                <span>{[course.location, `${course.holes} holes`].filter(Boolean).join(' · ')}</span>
              </div>
              {rowAction(slug, course.courseKey, () => { void loadInstalled(course) })}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Search for a course</h2>
        <form className="load-course-search" onSubmit={(event) => { event.preventDefault(); void runSearch() }}>
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
                    osmType: result.osmType, osmId: result.osmId })
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
