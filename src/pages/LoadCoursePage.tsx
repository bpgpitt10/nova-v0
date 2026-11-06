import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readLooperCompanionCourseLayouts, readLooperCompanionCourseLibrary, type LooperCompanionInstalledCourse } from '../adapters/looperCompanion'
import { parseGkdLayout } from '../courseGeometry/nativeGkd'
import { fetchCoursesAndGreens, gkdGreenPoints, matchCourseByGreens, MapServerBusyError, type GeometryMatchResult } from '../courseLoading/courseGeometryMatch'
import { COURSES_UPDATED_EVENT, courseRegistry, resolveCourseIdFromGsproName, type CourseId } from '../courseGeometry/courseCatalog'
import { GSPRO_LINKS_UPDATED_EVENT, gsproLinks } from '../courseGeometry/gsproLinks'
import { isNativePositionsEnabled, loadNativeCourseContext, type NativeCourseStatus } from '../courseGeometry/nativeCourseRuntime'
import {
  CourseSearchBusyError,
  courseNameMatchScore,
  courseSlugFromName,
  findGolfCourseFor,
  geocodePlace,
  linkGsproCourse,
  listCourseLoads,
  refreshGsproLinks,
  refreshLoadedCourses,
  loadSavedGsproLibrary,
  saveGsproLibrary,
  minutesLeft,
  requestCourseLoad,
  searchGolfCourses,
  STAGE_LABELS,
  typicalLoadMinutes,
  unlinkGsproCourse,
  type CourseLoadRow,
  type GolfCourseSearchResult,
} from '../courseLoading/courseLoads'
import { crosswalkDecision, crosswalkForGsproKey, crosswalkForGsproKeys, type CrosswalkDecision, type CrosswalkRow } from '../courseLoading/courseCrosswalk'
import './LoadCoursePage.css'
import { LooperTagline } from '../components/LooperTagline'

const ACTIVE = new Set(['queued', 'running', 'publishing'])

// One GSPro check at a time: each may fit a registration (~1 s + package download).
let checkQueue: Promise<unknown> = Promise.resolve()
const queuedCheck = <T,>(run: () => Promise<T>): Promise<T> => {
  const next = checkQueue.then(run, run)
  checkQueue = next.catch(() => undefined)
  return next
}

const matchText = (status: NativeCourseStatus | null): { text: string; tone: 'ok' | 'bad' | 'note' } | null => {
  if (!status) return { text: 'Checking against GSPro…', tone: 'note' }
  switch (status.state) {
    case 'ready':
      return { text: `Matches your GSPro course · grade ${status.grade}`, tone: 'ok' }
    case 'other-course':
      return status.grade ? { text: `Matches your GSPro course · grade ${status.grade}`, tone: 'ok' } : null
    case 'registration-failed':
      // Greywolf (our first course) predates the package this check needs:
      // not a mismatch, just not set up.
      if (status.reason === 'no course package') {
        return { text: "Plays in Looper; the GSPro position match isn't set up for this course yet.", tone: 'note' }
      }
      return { text: "Doesn't line up with your GSPro course", tone: 'bad' }
    case 'layout-mismatch':
      return { text: 'Your GSPro version has different greens or pins', tone: 'bad' }
    case 'gkd-not-found':
      return { text: "Couldn't read it from your GSPro library", tone: 'note' }
    case 'registering':
      return { text: 'Checking against GSPro…', tone: 'note' }
    case 'error':
      return { text: "Couldn't check against GSPro", tone: 'note' }
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

/**
 * GSPro names some courses differently from the map ("DPC Pebble" for Pebble
 * Beach). For a GSPro course with no loaded match, pick the loaded course it
 * is; the link is saved for everyone and the GSPro check runs right away, so
 * a wrong pick shows up as "doesn't line up".
 */
function LinkToLoaded({ course, onLinked }: Readonly<{
  course: LooperCompanionInstalledCourse
  onLinked: (message: string) => void
}>) {
  const options = useMemo(() => {
    const label = `${course.courseName} ${course.location}`
    return courseRegistry
      .map((entry) => ({ slug: entry.slug, name: entry.name, score: courseNameMatchScore(entry.name, label) }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  }, [course.courseName, course.location])
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState(() => (options[0]?.score ?? 0) >= 0.3 ? options[0].slug : '')
  const [saving, setSaving] = useState(false)
  if (!open) {
    return (
      <button type="button" className="load-course-link-toggle" onClick={() => setOpen(true)}>
        Already loaded under another name?
      </button>
    )
  }
  const save = async () => {
    if (!choice) return
    setSaving(true)
    try {
      await linkGsproCourse({ gsproCourseKey: course.courseKey, gsproCourseName: course.courseName, courseSlug: choice })
      const name = options.find((o) => o.slug === choice)?.name ?? choice
      onLinked(`Linked your GSPro course ${course.courseName || course.courseKey} to ${name}. Checking it lines up…`)
    } catch (error) {
      onLinked(`Couldn't save the link: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }
  return (
    <span className="load-course-link">
      <select value={choice} onChange={(event) => setChoice(event.target.value)} aria-label="Loaded course">
        <option value="">Same course as…</option>
        {options.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
      </select>
      <button type="button" disabled={!choice || saving} onClick={() => { void save() }}>
        {saving ? 'Linking…' : 'Link'}
      </button>
    </span>
  )
}

// Courses with a loaded map. A course that only plays from GSPro's own file
// (no map yet) is not loaded: it keeps its Load button (11/4, Brian: "it
// doesn't let me load anything").
const loadedSlugs = () => new Set<string>(courseRegistry.filter((entry) => entry.source !== 'gspro-only').map((entry) => entry.slug))

const statusText = (row: CourseLoadRow) => {
  if (row.status === 'queued') return 'Starting shortly'
  if (row.status === 'publishing') return `${STAGE_LABELS.publish} · ~${minutesLeft(row)} min left`
  if (row.status === 'running') {
    const step = row.stage_index && row.stage_count ? `Step ${row.stage_index} of ${row.stage_count}: ` : ''
    return `${step}${STAGE_LABELS[row.stage ?? ''] ?? 'Loading'} · ~${minutesLeft(row)} min left`
  }
  if (row.status === 'ready') return 'Ready to play'
  return "Didn't load" + (row.error ? `: ${row.error}` : '')
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
  // A GSPro course with more than one map course nearby: its choices show
  // right under its row (they used to fill the search results at the top of
  // the page, off screen, so the button looked dead; Brian, 11/5).
  const [picking, setPicking] = useState<{ courseKey: string; candidates: Extract<CrosswalkDecision, { kind: 'pick' }>['candidates'] } | null>(null)
  // Row actions that fall back to the search results bring the search into view.
  const searchRef = useRef<HTMLElement>(null)
  const showSearch = () => searchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // Re-render when GSPro links change (Link / Unlink, or the shared list
  // loads) or a loaded course arrives (published at run time).
  const [catalogVersion, setCatalogVersion] = useState(0)
  const slugs = useMemo(loadedSlugs, [catalogVersion])
  useEffect(() => {
    const bump = () => setCatalogVersion((v) => v + 1)
    window.addEventListener(GSPRO_LINKS_UPDATED_EVENT, bump)
    window.addEventListener(COURSES_UPDATED_EVENT, bump)
    void refreshGsproLinks().catch(() => undefined)
    void refreshLoadedCourses().catch(() => undefined)
    return () => {
      window.removeEventListener(GSPRO_LINKS_UPDATED_EVENT, bump)
      window.removeEventListener(COURSES_UPDATED_EVENT, bump)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const rows = await listCourseLoads()
      setLoads(rows)
      setLoadsError(null)
      // A load just finished: its course is published, add it now.
      if (rows.some((row) => row.status === 'ready' && row.slug && !loadedSlugs().has(row.slug))) {
        void refreshLoadedCourses().catch(() => undefined)
      }
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

  // On the sim PC the companion lists the installed courses (and they're saved
  // to the account); anywhere else, the list saved from the sim PC is shown.
  const [savedLibraryAt, setSavedLibraryAt] = useState<string | null>(null)
  useEffect(() => {
    void readLooperCompanionCourseLibrary()
      .then((data) => {
        setLibrary(data.courses)
        if (!data.courses.length) setLibraryNote('The Looper Companion found no GSPro courses on this PC.')
        void saveGsproLibrary(data.courses).catch(() => undefined)
      })
      .catch(async () => {
        const saved = await loadSavedGsproLibrary().catch(() => null)
        if (saved?.courses.length) {
          setLibrary(saved.courses.map((course) => ({ ...course, alternateLayouts: [] })))
          setSavedLibraryAt(saved.seenAt)
          return
        }
        setLibraryNote('Start the Looper Companion on your GSPro PC to see your installed courses here.')
      })
  }, [])

  // The course crosswalk for the installed courses: which ones are on the map at all.
  const [crosswalk, setCrosswalk] = useState<Map<string, CrosswalkRow>>(() => new Map())
  useEffect(() => {
    if (!library?.length) return
    void crosswalkForGsproKeys(library.map((course) => course.courseKey))
      .then(setCrosswalk)
      .catch(() => undefined)
  }, [library])

  const latestFor = (slug: string) => loads.find((row) => row.slug === slug) ?? null
  const courseIdFor = (slug: string): CourseId | null =>
    (courseRegistry.find((entry) => entry.slug === slug)?.id as CourseId | undefined) ?? null

  const queue = async (key: string, course: Parameters<typeof requestCourseLoad>[0], note = '') => {
    setBusyKey(key)
    setMessage(null)
    try {
      const { dispatched } = await requestCourseLoad(course)
      setMessage(note + (dispatched
        ? `Loading ${course.name}. Usually ready in about ${typicalLoadMinutes()} minutes; you can leave this page.`
        : `${course.name} is queued. It will start when the loader next runs.`))
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyKey(null)
    }
  }

  // GSPro file -> location -> nearby courses -> green fit. Null when any
  // step isn't available (companion too old, no location, Overpass down):
  // the name search then runs as before.
  const matchInstalledByGeometry = async (course: LooperCompanionInstalledCourse): Promise<GeometryMatchResult | 'busy' | 'no-course-file' | null> => {
    // GSPro's course file is on the sim PC: on another device (the saved
    // library) there is nothing to match by.
    if (savedLibraryAt) return 'no-course-file'
    try {
      const files = await readLooperCompanionCourseLayouts(course.courseKey)
      const main = files.layouts.find((f) => f.kind === 'main') ?? files.layouts[0]
      if (!main) return null
      const layout = parseGkdLayout(main.text)
      const greens = gkdGreenPoints(layout)
      if (greens.length < 6) return null
      const centre = layout.courseLatLon
        ?? await geocodePlace(course.location || layout.location || '').catch(() => null)
      if (!centre) return null
      setMessage(`Checking GSPro's green layout against the courses near ${course.location || 'its location'}…`)
      const { candidates, greens: mapGreens } = await fetchCoursesAndGreens(centre)
      return matchCourseByGreens(greens, candidates, mapGreens)
    } catch (error) {
      return error instanceof MapServerBusyError ? 'busy' : null
    }
  }

  const loadInstalled = async (course: LooperCompanionInstalledCourse) => {
    setBusyKey(course.courseKey)
    setMessage(`Finding ${course.courseName} on the map…`)
    const name = course.courseName || course.courseKey
    // The crosswalk first: GSPro's course key -> the map course matched near
    // the course's own coordinates (no name search, no place lookup).
    const decision = crosswalkDecision(await crosswalkForGsproKey(course.courseKey).catch(() => null))
    if (decision.kind === 'load') {
      await queue(course.courseKey, {
        name: course.courseName || decision.name, location: decision.location || course.location,
        lat: decision.lat, lon: decision.lon, osmType: decision.osmType, osmId: decision.osmId,
        gsproCourseKey: course.courseKey,
      })
      return
    }
    if (decision.kind === 'pick') {
      setBusyKey(null)
      setMessage(null)
      setPicking({ courseKey: course.courseKey, candidates: decision.candidates })
      return
    }
    if (decision.kind === 'not-on-map') {
      setBusyKey(null)
      setMessage(`${name} can't be loaded: ${decision.reason}. It still plays in Looper from GSPro's own course file.`)
      return
    }
    // 2. By geometry: GSPro's own greens against the golf courses near its
    //    location (spec: claude/spec-geometry-course-matching.md). Names fail
    //    ("DPC Pebble", resort-named courses); the green layout doesn't.
    const found0 = await matchInstalledByGeometry(course)
    if (found0 === 'busy') {
      // A name search can't find resort courses either (Mammoth Dunes): say why and stop.
      setBusyKey(null)
      setMessage(`The OpenStreetMap server Looper checks GSPro's green layout against is busy right now, so ${course.courseName || course.courseKey} couldn't be matched. Try Load again in a few minutes.`)
      return
    }
    const geo = found0 === 'no-course-file' ? null : found0
    const awayNote = found0 === 'no-course-file'
      ? 'Matching by green layout needs your sim PC (it reads GSPro\'s course file there); on this device only the name is searched. '
      : ''
    if (geo?.status === 'matched' && geo.best) {
      const fit = geo.best.fit
      const found = `Found ${course.courseName || course.courseKey} on the map by its green layout: ${geo.best.name} `
        + `(${fit.paired} of ${fit.gkdGreens} greens line up, ${fit.rmsM.toFixed(0)} m). `
      // Already loaded (e.g. DPC Pebble -> Pebble Beach): link, don't reload.
      const loaded = loads.find((row) => row.status === 'ready' && row.osm_id === geo.best!.osmId && row.slug && slugs.has(row.slug))
      if (loaded?.slug) {
        try {
          await linkGsproCourse({ gsproCourseKey: course.courseKey, gsproCourseName: course.courseName, courseSlug: loaded.slug })
          setMessage(`${found}It's already loaded, so your GSPro course is now linked to it.`)
        } catch (error) {
          setMessage(`${found}It's already loaded, but the link couldn't be saved: ${error instanceof Error ? error.message : String(error)}`)
        }
        setBusyKey(null)
        return
      }
      await queue(course.courseKey, {
        name: geo.best.name, location: course.location,
        lat: geo.best.centre[0], lon: geo.best.centre[1],
        osmType: geo.best.osmType, osmId: geo.best.osmId, gsproCourseKey: course.courseKey,
      }, found)
      return
    }
    const geoNote = geo?.status === 'no-fit'
      ? `GSPro's green layout doesn't match any mapped course near ${course.location || 'its location'}`
        + (geo.best ? ` (closest: ${geo.best.name}, ${geo.best.fit.paired} of ${geo.best.fit.gkdGreens} greens within 25 m)` : '')
        + '. It may be a fictional or re-imagined course, or not on OpenStreetMap yet. '
      : geo?.status === 'ambiguous' && geo.best && geo.runnerUp
        ? `GSPro's greens fit both ${geo.best.name} and ${geo.runnerUp.name}. `
        : ''
    if (geo?.status === 'ambiguous') {
      setBusyKey(null)
      setLinkedGspro({ courseKey: course.courseKey, courseName: name })
      setResults([geo.best!, geo.runnerUp!].map((c) => ({
        name: c.name, location: course.location, lat: c.centre[0], lon: c.centre[1], osmType: c.osmType, osmId: c.osmId,
      })))
      setMessage(`${geoNote}Pick the right one below.`)
      showSearch()
      return
    }
    // 3. By name (no GSPro file, no location, or the map has no fit).
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
    if (!match || geo?.status === 'no-fit') {
      setBusyKey(null)
      setLinkedGspro({ courseKey: course.courseKey, courseName: name })
      setQuery(name)
      setMessage(`${awayNote}${geoNote}${match
        ? `By name it looks like ${match.name}, but GSPro's version may not line up with it. Pick from the search results below only if you're sure.`
        : `Couldn't match ${name} on OpenStreetMap automatically. Pick it from the search results below, or search a different name.`}`)
      showSearch()
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

  const rowAction = (slug: string, key: string, onLoad: () => void, label = 'Load') => {
    if (slugs.has(slug)) return <span className="load-course-ready">Ready to play</span>
    const row = latestFor(slug)
    if (row && ACTIVE.has(row.status)) return <span className="load-course-progress">{statusText(row)}</span>
    if (row?.status === 'ready') return <span className="load-course-ready">{statusText(row)}</span>
    return (
      <span className="load-course-actions">
        {row?.status === 'failed' ? <span className="load-course-failed" title={row.error ?? undefined}>Didn't load</span> : null}
        <button type="button" disabled={busyKey !== null} onClick={onLoad}>
          {busyKey === key ? 'Starting…' : row?.status === 'failed' ? 'Try again' : label}
        </button>
      </span>
    )
  }

  // Ranges, putting courses and fictional courses have no real-world map to load.
  const loadable = (library ?? []).filter((course) => !notARealCourse(course))
  const skipped = (library ?? []).length - loadable.length
  const installed = loadable.map((course) => {
    const known = resolveCourseIdFromGsproName(course.courseKey, { includeGsproOnly: false })
      ?? resolveCourseIdFromGsproName(course.courseName, { includeGsproOnly: false })
    const slug = known ? courseRegistry.find((e) => e.id === known)?.slug ?? courseSlugFromName(course.courseName)
      : courseSlugFromName(course.courseName)
    const link = gsproLinks().find((l) => l.gsproCourseKey === course.courseKey) ?? null
    const decision = crosswalkDecision(crosswalk.get(course.courseKey) ?? null)
    const group: 'ready' | 'loading' | 'load' | 'off-map' = slugs.has(slug) ? 'ready'
      : ACTIVE.has(latestFor(slug)?.status ?? '') ? 'loading'
        : decision.kind === 'not-on-map' ? 'off-map' : 'load'
    return { course, slug, link, decision, group }
  })
  const groups = [
    { key: 'ready', title: 'Ready to play' },
    { key: 'loading', title: 'Loading' },
    { key: 'load', title: 'Not loaded yet' },
    { key: 'off-map', title: 'Not on the map' },
  ] as const

  const installedRow = ({ course, slug, link, decision, group }: (typeof installed)[number]) => (
    <li key={course.courseKey}>
      <div>
        <strong>{course.courseName || course.courseKey}</strong>
        <span>{course.location}</span>
        {link && group === 'ready' ? (
          <span className="load-course-linked">
            Linked to {courseRegistry.find((e) => e.slug === slug)?.name ?? slug}
            {' '}<button type="button" className="load-course-unlink" onClick={() => {
              void unlinkGsproCourse(course.courseKey)
                .catch((error: unknown) => setMessage(`Couldn't unlink: ${error instanceof Error ? error.message : String(error)}`))
            }}>Unlink</button>
          </span>
        ) : null}
      </div>
      <span className="load-course-actions">
        {group === 'off-map' && decision.kind === 'not-on-map' ? (
          <span className="load-course-note">{/fictional/.test(decision.reason) ? 'Fictional course' : 'Not on OpenStreetMap yet'}</span>
        ) : rowAction(slug, course.courseKey, () => { void loadInstalled(course) },
          decision.kind === 'pick' ? 'Choose the map course' : 'Load')}
        {group === 'ready' && courseIdFor(slug) && !savedLibraryAt
          ? <GsproMatch courseId={courseIdFor(slug)!} courseKey={course.courseKey} /> : null}
        {group === 'load' ? <LinkToLoaded course={course} onLinked={setMessage} /> : null}
      </span>
      {picking?.courseKey === course.courseKey ? (
        <div className="load-course-pick">
          <p>Which of these is {course.courseName || course.courseKey}? Looper loads the one you pick and links it to your GSPro course.</p>
          <ul>
            {picking.candidates.map((c) => (
              <li key={`${c.osmType}/${c.osmId}`}>
                <span>
                  <strong>{c.name}</strong>
                  {c.distanceM != null ? <span>{(c.distanceM / 1609.34).toFixed(1)} mi from the course's listed location</span> : null}
                </span>
                <button type="button" disabled={busyKey !== null} onClick={() => {
                  setPicking(null)
                  void queue(course.courseKey, {
                    name: course.courseName || c.name, location: course.location || c.location,
                    lat: c.lat, lon: c.lon, osmType: c.osmType, osmId: c.osmId,
                    gsproCourseKey: course.courseKey,
                  })
                }}>Load this one</button>
              </li>
            ))}
          </ul>
          <p className="load-course-pick-other">
            Not listed?{' '}
            <button type="button" className="load-course-unlink" onClick={() => {
              const name = course.courseName || course.courseKey
              setPicking(null)
              setLinkedGspro({ courseKey: course.courseKey, courseName: name })
              setQuery(name)
              showSearch()
            }}>Search the map by name</button>
            {' '}·{' '}
            <button type="button" className="load-course-unlink" onClick={() => setPicking(null)}>Cancel</button>
          </p>
        </div>
      ) : null}
    </li>
  )

  return (
    <main className="load-course-page">
      <header>
        <span className="load-course-kicker">COURSES</span>
        <h1>Load a course</h1>
        <p>
          Load a course once and it's in Start a Round for everyone. It takes about {typicalLoadMinutes()} minutes;
          you can leave this page while it runs.
        </p>
        <a className="load-course-back" href="/round-setup">← Back to Start a Round</a>
      </header>

      {message ? <p className="load-course-message">{message}</p> : null}
      {loadsError ? <p className="load-course-message">Sign in to load courses ({loadsError}).</p> : null}

      <section ref={searchRef}>
        <h2>Find a course</h2>
        {linkedGspro ? (
          <p className="load-course-note">
            Loading one of these links it to your GSPro course <strong>{linkedGspro.courseName}</strong>.{' '}
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
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Course name, e.g. Erin Hills" />
          <button type="submit" disabled={searching || query.trim().length < 3}>{searching ? 'Searching…' : 'Search'}</button>
        </form>
        {results && results.length === 0 ? <p className="load-course-note">No golf course on OpenStreetMap by that name.</p> : null}
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

      <section>
        <h2>Your GSPro courses</h2>
        {libraryNote ? <p className="load-course-note">{libraryNote}</p> : null}
        {savedLibraryAt ? (
          <p className="load-course-note">
            Saved from your sim PC on {new Date(savedLibraryAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.
            The check against your GSPro version runs on the sim PC.
          </p>
        ) : null}
        {library === null && !libraryNote ? <p className="load-course-note">Looking for your GSPro courses…</p> : null}
        {groups.map(({ key, title }) => {
          const rows = installed.filter((row) => row.group === key)
          return rows.length ? (
            <div key={key} className="load-course-group">
              <h3>{title} <span>{rows.length}</span></h3>
              <ul className="load-course-list">{rows.map(installedRow)}</ul>
            </div>
          ) : null
        })}
        {skipped > 0 ? (
          <p className="load-course-note">{skipped} range{skipped === 1 ? '' : 's'} and practice course{skipped === 1 ? '' : 's'} hidden.</p>
        ) : null}
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
        Courses come from OpenStreetMap (© OpenStreetMap contributors, ODbL), with elevation and trees from USGS, NRCan,
        LINZ or Copernicus. GSPro course list: Simulator Golf Tour.
      </p>
      <LooperTagline />
    </main>
  )
}
