import { useCallback, useEffect, useMemo, useState } from 'react'
import { isCurrentLooperAdmin } from '../cloud/adminUsers'
import { resolveCourseIdFromGsproName } from '../courseGeometry/courseCatalog'
import { listCourseLoads, refreshLoadedCourses, requestCourseLoad, type CourseLoadRow } from '../courseLoading/courseLoads'
import {
  classifyCourseInstalls,
  listCourseInstallsForAdmin,
  sortCourseInstalls,
  type CourseInstall,
  type CourseInstallRow,
  type CourseInstallStatus,
} from '../courseLoading/courseInstalls'
import './AdminUsersPage.css'
import './AdminCoursesPage.css'

const STATUS_TEXT: Record<CourseInstallStatus, string> = {
  loaded: 'In Looper',
  loading: 'Loading',
  ready: 'Ready to load',
  pick: 'Check the outline',
  fictional: 'Fictional: plays from the GSPro file',
  'no-map': 'Not on the map yet',
  range: 'Practice range',
}

type Filter = 'todo' | 'all'

const isLoaded = (courseKey: string, courseName: string | null) =>
  resolveCourseIdFromGsproName(courseKey, { includeGsproOnly: false }) != null
  || (courseName != null && resolveCourseIdFromGsproName(courseName, { includeGsproOnly: false }) != null)

export default function AdminCoursesPage() {
  const [rows, setRows] = useState<CourseInstallRow[]>([])
  const [loads, setLoads] = useState<CourseLoadRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('todo')
  const [catalogTick, setCatalogTick] = useState(0)

  const reload = useCallback(async () => {
    setError(null)
    try {
      if (!(await isCurrentLooperAdmin())) throw new Error('This Looper account is not an admin.')
      const [installs, recent] = await Promise.all([listCourseInstallsForAdmin(), listCourseLoads(), refreshLoadedCourses().catch(() => 0)])
      setRows(installs)
      setLoads(recent)
      setCatalogTick((tick) => tick + 1)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const courses = useMemo(() => {
    const active = new Set(loads.filter((l) => l.status === 'queued' || l.status === 'running' || l.status === 'publishing')
      .map((l) => (l.gspro_course_key ?? '').toLowerCase()).filter(Boolean))
    return sortCourseInstalls(classifyCourseInstalls(rows, isLoaded, active))
    // catalogTick: the loaded-course registry changes outside React.
  }, [rows, loads, catalogTick]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = filter === 'all' ? courses : courses.filter((c) => c.status === 'ready' || c.status === 'pick' || c.status === 'loading')
  const counts = useMemo(() => {
    const by: Partial<Record<CourseInstallStatus, number>> = {}
    for (const c of courses) by[c.status] = (by[c.status] ?? 0) + 1
    return by
  }, [courses])

  const load = async (course: CourseInstall) => {
    if (course.lat == null || course.lon == null) return
    setBusyKey(course.course_key)
    setError(null)
    setNote(null)
    try {
      const { dispatched } = await requestCourseLoad({
        name: course.name,
        location: course.location ?? '',
        lat: course.lat,
        lon: course.lon,
        osmType: course.osm_type === 'way' || course.osm_type === 'relation' ? course.osm_type : null,
        osmId: course.osm_id,
        gsproCourseKey: course.course_key,
      })
      setNote(`${course.name} is queued${dispatched ? ' and the loader has started' : '; the loader picks it up within 6 hours'}.`)
      await reload()
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <main className="looper-admin-users">
      <section className="looper-admin-users__card">
        <div className="looper-admin-users__header">
          <div>
            <span className="looper-admin-users__eyebrow">Looper admin</span>
            <h1>Courses players have</h1>
            <p>
              Every course in players' GSPro libraries, most-installed first. Counts only: nobody's library is shown.
              {' '}Ready to load is one click; Check the outline goes through the <a href="/courses">Load page</a>.
            </p>
          </div>
          <a href="/looper">Back to Looper</a>
        </div>

        <div className="looper-admin-courses__filters" role="group" aria-label="Show">
          <button type="button" className={filter === 'todo' ? 'is-on' : ''} onClick={() => setFilter('todo')}>
            To load ({(counts.ready ?? 0) + (counts.pick ?? 0) + (counts.loading ?? 0)})
          </button>
          <button type="button" className={filter === 'all' ? 'is-on' : ''} onClick={() => setFilter('all')}>
            All ({courses.length})
          </button>
          <span>
            In Looper {counts.loaded ?? 0} · Fictional {counts.fictional ?? 0} · Not mapped {counts['no-map'] ?? 0}
          </span>
        </div>

        {error ? <div className="looper-admin-users__error">{error}</div> : null}
        {note ? <div className="looper-admin-courses__note">{note}</div> : null}

        {loading ? (
          <p>Loading courses…</p>
        ) : shown.length === 0 ? (
          <p>Nothing left to load from players' libraries.</p>
        ) : (
          <div className="looper-admin-users__list">
            {shown.map((course) => (
              <div className="looper-admin-users__row" key={course.course_key}>
                <div>
                  <strong>{course.name}</strong>
                  <span>{[course.location, course.course_key].filter(Boolean).join(' · ')}</span>
                  <small>{course.players} {course.players === 1 ? 'player' : 'players'}</small>
                </div>
                <div className="looper-admin-users__actions">
                  <span className={`looper-admin-courses__status is-${course.status}`}>{STATUS_TEXT[course.status]}</span>
                  {course.status === 'ready' ? (
                    <button type="button" disabled={busyKey != null} onClick={() => void load(course)}>
                      {busyKey === course.course_key ? 'Queuing…' : 'Load'}
                    </button>
                  ) : course.status === 'pick' ? (
                    <a className="looper-admin-courses__link" href="/courses">Load page</a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
