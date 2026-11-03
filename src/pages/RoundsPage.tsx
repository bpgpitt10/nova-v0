import { useCallback, useEffect, useMemo, useState } from 'react'
import { BagTopBar } from '../components/BagNav'
import type { CourseHoleGeometry, CoursePointYds, CourseSurfaceKind } from '../courseGeometry/types'
import { getClubLabel, type Club } from '../lib/bagConfig'
import {
  buildRounds,
  holeShotMap,
  keyShots,
  median,
  onCourseCarriesByClub,
  scoredShots,
  type RoundHole,
  type RoundShot,
  type RoundStatus,
  type RoundSummary,
  type ShotCategory,
  type ShotLie,
} from '../lib/roundHistory'
import {
  loadCourseInfo,
  loadRangeCarries,
  loadRoundFlags,
  loadRoundRecords,
  saveRoundFlags,
  toCourseInfoMap,
  unresolvedCourseKeys,
  type RangeClubNumbers,
  type StoredCourseInfo,
} from '../lib/roundHistoryData'
import { loadHoleMap } from '../lib/roundHoleMap'
import type { RoundFlags, RoundShotRecord } from '../lib/roundHistory'
import './RoundsPage.css'

const FULL_ROUNDS_FOR_TRENDS = 5
/** A shot that lost at least half a stroke is carnage; anything milder just got away. */
const CARNAGE_SG = -0.5

const navigate = (path: string) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const MINUS = '−'
const signed = (value: number, digits = 2) => {
  const rounded = Number(value.toFixed(digits))
  if (rounded === 0) return (0).toFixed(digits)
  return `${rounded > 0 ? '+' : MINUS}${Math.abs(rounded).toFixed(digits)}`
}
const tone = (value: number | null) =>
  value == null ? 'is-even' : value >= 0.05 ? 'is-gain' : value <= -0.05 ? 'is-loss' : 'is-even'
const vsPar = (strokes: number, par: number) => {
  const diff = strokes - par
  return diff === 0 ? 'E' : diff > 0 ? `+${diff}` : `${MINUS}${Math.abs(diff)}`
}

const LIE_LABEL: Record<ShotLie | 'holed', string> = {
  tee: 'Tee',
  fairway: 'Fairway',
  fringe: 'Fringe',
  rough: 'Rough',
  'deep-rough': 'Deep rough',
  sand: 'Sand',
  green: 'Green',
  unknown: 'Unknown lie',
  holed: 'Holed',
}

const CATEGORY_LABEL: Record<ShotCategory, string> = {
  'off-the-tee': 'Off the tee',
  approach: 'Approach',
  'around-green': 'Around the green',
  putting: 'Putting',
}

const distance = (yards: number, lie: ShotLie | 'holed') =>
  lie === 'green' ? `${Math.round(yards * 3)} ft` : `${Math.round(yards)} yd`

const clubName = (club: string | null) => {
  if (!club) return '—'
  if (club === 'Putter') return 'Putter'
  try {
    return getClubLabel(club as Club)
  } catch {
    return club
  }
}

const shotFrom = (shot: RoundShot) =>
  shot.startYds == null ? LIE_LABEL[shot.startLie] : `${distance(shot.startYds, shot.startLie)} · ${LIE_LABEL[shot.startLie]}`

const shotTo = (shot: RoundShot) => {
  if (shot.endLie === 'holed') return shot.conceded ? 'Holed (gimme)' : 'Holed'
  return `${distance(shot.endYds, shot.endLie)} · ${LIE_LABEL[shot.endLie]}`
}

const keyShotHeadline = (shot: RoundShot) => {
  if (shot.isPutt && shot.holed && !shot.conceded && shot.startYds != null) {
    return `Hole ${shot.holeNumber} · ${Math.round(shot.startYds * 3)}-ft putt, holed`
  }
  if (shot.startYds == null) return `Hole ${shot.holeNumber} · ${clubName(shot.club)}`
  const lie = shot.startLie === 'tee' || shot.startLie === 'fairway' ? '' : ` in ${LIE_LABEL[shot.startLie].toLowerCase()}`
  return `Hole ${shot.holeNumber} · ${clubName(shot.club)} from ${distance(shot.startYds, shot.startLie)}${lie}`
}

const isLiveCaddieRound = (round: RoundSummary) =>
  round.holes.some((hole) => hole.shots.some((shot) => shot.recommendedClub || shot.clubSource === 'armed'))

const holesLabel = (round: RoundSummary) => {
  if (round.completeHoles >= 18) return `${round.completeHoles} holes`
  const numbers = round.holes.map((hole) => hole.holeNumber)
  if (numbers.length === 0) return '—'
  const first = Math.min(...numbers)
  const last = Math.max(...numbers)
  if (round.completeHoles === round.holesPlayed && first === 1) return `Thru ${last}`
  return first === last ? `Hole ${first}` : `Holes ${first}–${last}`
}

const STATUS_LABEL: Record<RoundStatus, string> = {
  full: 'Full round',
  partial: 'Partial',
  test: 'Test session',
  fragment: 'Fragment',
  range: 'Range',
}

const formatDate = (iso: string | null, withWeekday = true) => {
  if (!iso) return '—'
  const date = new Date(iso)
  return date.toLocaleDateString(undefined, {
    weekday: withWeekday ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
  })
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      records: RoundShotRecord[]
      source: string
      cloudError: string | null
      courses: Record<string, StoredCourseInfo>
      coursesLoaded: boolean
    }

function useRoundData() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await loadRoundRecords()
        if (cancelled) return
        const keys = [...new Set(result.records.map((record) => record.courseKey ?? '').filter(Boolean))]
        // Show rounds right away; names and pars fill in when the course files answer.
        setState({ status: 'ready', ...result, courses: {}, coursesLoaded: false })
        const courses = await loadCourseInfo(keys)
        if (!cancelled) setState({ status: 'ready', ...result, courses, coursesLoaded: true })
      } catch (error) {
        if (!cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : 'Could not load rounds.' })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

export default function RoundsPage({ pathname }: { pathname: string }) {
  const data = useRoundData()
  const [flags, setFlags] = useState<Record<number, RoundFlags>>(() => loadRoundFlags())
  const rounds = useMemo(
    () => (data.status === 'ready' ? buildRounds(data.records, toCourseInfoMap(data.courses), flags) : []),
    [data, flags],
  )
  const roundIdParam = pathname.startsWith('/rounds/') ? Number(pathname.slice('/rounds/'.length)) : null
  const selected = roundIdParam != null ? rounds.find((round) => round.roundId === roundIdParam) ?? null : null

  const setAutoPutt = useCallback((roundId: number, autoPutt: boolean) => {
    setFlags((current) => {
      const next = { ...current, [roundId]: { ...current[roundId], autoPutt } }
      saveRoundFlags(next)
      return next
    })
  }, [])

  return (
    <div className="rounds-page">
      <div className="rounds-shell">
        <BagTopBar
          active="rounds"
          editBagHref={`/bag-setup?returnTo=${encodeURIComponent('/rounds')}`}
          onBag={() => navigate('/dashboard')}
        />
        {data.status === 'loading' ? <p className="rounds-empty">Loading your rounds…</p> : null}
        {data.status === 'error' ? <p className="rounds-empty">{data.message}</p> : null}
        {data.status === 'ready' && roundIdParam != null && !selected ? (
          <div className="rounds-empty">
            <p>That round isn’t in your history.</p>
            <a href="/rounds">← All rounds</a>
          </div>
        ) : null}
        {data.status === 'ready' && selected ? (
          <RoundDetail
            course={selected.courseKey ? data.courses[selected.courseKey] ?? null : null}
            onAutoPutt={(value) => setAutoPutt(selected.roundId, value)}
            round={selected}
          />
        ) : null}
        {data.status === 'ready' && roundIdParam == null ? (
          <RoundsList
            cloudError={data.cloudError}
            coursesLoaded={data.coursesLoaded}
            rounds={rounds}
            unnamedCourses={unresolvedCourseKeys(
              rounds.filter((round) => round.status === 'full' || round.status === 'partial').map((round) => round.courseKey ?? ''),
              data.courses,
            ).length}
          />
        ) : null}
      </div>
    </div>
  )
}

// ---- list ---------------------------------------------------------------------

type ListFilter = 'full' | 'all' | 'live-caddie'

function RoundsList({
  rounds,
  cloudError,
  unnamedCourses,
  coursesLoaded,
}: {
  rounds: RoundSummary[]
  cloudError: string | null
  unnamedCourses: number
  coursesLoaded: boolean
}) {
  const [filter, setFilter] = useState<ListFilter>('full')
  const onCourse = rounds.filter((round) => round.status !== 'range')
  const fullRounds = onCourse.filter((round) => round.status === 'full')
  const visible = onCourse.filter((round) => {
    if (filter === 'live-caddie') return isLiveCaddieRound(round) && round.status !== 'fragment'
    if (filter === 'all') return true
    return round.status === 'full' || round.status === 'partial'
  })
  const hiddenFragments = filter === 'all' ? 0 : onCourse.filter((round) => round.status === 'fragment').length
  const hiddenTests = filter === 'all' ? 0 : onCourse.filter((round) => round.status === 'test').length
  const rangeSessions = rounds.length - onCourse.length
  const scoredRounds = onCourse.filter((round) => round.status === 'full' || round.status === 'partial')
  const holesFinished = scoredRounds.reduce((sum, round) => sum + round.completeHoles, 0)
  const shotsOnCourse = scoredRounds.reduce(
    (sum, round) => sum + round.holes.filter((hole) => hole.complete).reduce((inner, hole) => inner + hole.strokes, 0),
    0,
  )

  return (
    <main className="rounds-main">
      <header className="rounds-header">
        <div>
          <h1 className="rounds-display-title">Rounds</h1>
          <p className="rounds-muted">Every round the companion saw, with each shot, lie and putt.</p>
        </div>
        <div className="rounds-segment" role="group" aria-label="Filter rounds">
          {(['full', 'all', 'live-caddie'] as const).map((value) => (
            <button
              aria-pressed={filter === value}
              className={filter === value ? 'is-active' : undefined}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {value === 'full' ? 'Full rounds' : value === 'all' ? 'All' : 'Live Caddie rounds'}
            </button>
          ))}
        </div>
      </header>

      {cloudError ? (
        <p className="rounds-note">Couldn’t reach your cloud history ({cloudError}); showing rounds saved in this browser.</p>
      ) : null}

      {coursesLoaded && unnamedCourses > 0 ? (
        <p className="rounds-note">
          Course names and pars come from GSPro’s course files, which the companion reads on your sim PC. Open Rounds there once with the companion running and they’ll show on every device.
        </p>
      ) : null}

      <section className="rounds-tiles">
        <div className="rounds-tile"><span>Full rounds</span><strong>{fullRounds.length}</strong></div>
        <div className="rounds-tile"><span>Holes finished</span><strong>{holesFinished}</strong></div>
        <div className="rounds-tile"><span>Shots on course</span><strong>{shotsOnCourse}</strong></div>
        <div className="rounds-tile is-progress">
          <span>Trends unlock at {FULL_ROUNDS_FOR_TRENDS} full rounds</span>
          <div className="rounds-progress" aria-hidden="true">
            <div style={{ width: `${Math.min(100, (fullRounds.length / FULL_ROUNDS_FOR_TRENDS) * 100)}%` }} />
          </div>
          <span className="rounds-muted">{Math.min(fullRounds.length, FULL_ROUNDS_FOR_TRENDS)} of {FULL_ROUNDS_FOR_TRENDS}</span>
        </div>
      </section>

      {visible.length === 0 ? (
        <div className="rounds-card rounds-empty">
          <p>No {filter === 'full' ? 'full or partial ' : ''}rounds yet.</p>
          <p className="rounds-muted">Play a round in GSPro with the companion running; it saves every shot, even with Looper closed.</p>
        </div>
      ) : (
        <div className="rounds-card rounds-table-wrap">
          <table className="rounds-table">
            <thead>
              <tr>
                <th scope="col">Course</th>
                <th scope="col">Date</th>
                <th scope="col">Holes</th>
                <th className="is-num" scope="col">Score</th>
                <th className="is-num" scope="col">Putts</th>
                <th className="is-num" scope="col">Greens</th>
                <th className="is-num" scope="col">SG vs Tour</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((round) => {
                const scored = round.status === 'full' || round.status === 'partial'
                const best = scored ? keyShots(round, 1, 0).best[0] : undefined
                return (
                  <tr className={round.status === 'full' ? undefined : 'is-dim'} key={round.roundId}>
                    <td>
                      <a className="rounds-row-link" href={`/rounds/${round.roundId}`}>
                        <strong>{round.courseName}</strong>
                        <span className="rounds-muted">
                          {round.status === 'full'
                            ? best ? `Best shot: ${keyShotHeadline(best).replace(/^Hole \d+ · /, '').toLowerCase()} on ${best.holeNumber}` : STATUS_LABEL.full
                            : round.status === 'test'
                              ? 'Test session, not scored'
                              : `${STATUS_LABEL[round.status]} · ${round.completeHoles} of ${round.holesPlayed} holes finished`}
                          {isLiveCaddieRound(round) ? ' · Live Caddie' : ''}
                        </span>
                      </a>
                    </td>
                    <td>{formatDate(round.playedAt)}</td>
                    <td><span className="rounds-pill">{holesLabel(round)}</span></td>
                    <td className="is-num">
                      {scored && round.completeHoles > 0 ? (
                        <>
                          <strong>{round.strokes}</strong>
                          {round.par != null ? <span className="rounds-muted"> {vsPar(round.strokes, round.par)}</span> : null}
                        </>
                      ) : '–'}
                    </td>
                    <td className="is-num">{scored && round.completeHoles > 0 ? round.putts : '–'}</td>
                    <td className="is-num">{round.gir.of > 0 ? `${round.gir.hit}/${round.gir.of}` : '–'}</td>
                    <td className={`is-num ${tone(round.sg.total)}`}>
                      {round.status === 'full' && round.sg.total != null ? signed(round.sg.total) : scored ? 'Partial' : '–'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {hiddenFragments + hiddenTests + rangeSessions > 0 ? (
            <div className="rounds-table-foot rounds-muted">
              {hiddenTests > 0 ? <span>{hiddenTests} test session{hiddenTests === 1 ? '' : 's'} hidden</span> : null}
              {hiddenFragments > 0 ? <span>{hiddenFragments} short fragment{hiddenFragments === 1 ? '' : 's'} hidden</span> : null}
              {rangeSessions > 0 ? <span>{rangeSessions} range session{rangeSessions === 1 ? '' : 's'} not shown</span> : null}
              {filter !== 'all' && hiddenFragments + hiddenTests > 0 ? (
                <button className="rounds-link-button" onClick={() => setFilter('all')} type="button">Show everything</button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <p className="rounds-muted rounds-small">
        Partial rounds stay out of averages and trends but still open shot by shot. Test sessions (shots that don’t follow on from each other) are never scored.
      </p>
    </main>
  )
}

// ---- detail -------------------------------------------------------------------

function RoundDetail({
  round,
  course,
  onAutoPutt,
}: {
  round: RoundSummary
  course: StoredCourseInfo | null
  onAutoPutt: (value: boolean) => void
}) {
  const scoredHoles = round.holes.filter((hole) => hole.complete)
  const [selectedHole, setSelectedHole] = useState<number | null>(null)
  const [focus, setFocus] = useState<ShotCategory | null>(null)
  const worstHole = [...scoredHoles].sort((a, b) => (a.sg ?? 0) - (b.sg ?? 0))[0]
  const holeNumber = selectedHole ?? worstHole?.holeNumber ?? round.holes[0]?.holeNumber ?? null
  const hole = round.holes.find((entry) => entry.holeNumber === holeNumber) ?? null
  const { best, worst: worstTwo } = keyShots(round, 2, 2)
  // A second bad shot only earns a place if it really hurt.
  const worst = worstTwo.filter((shot, index) => index === 0 || (shot.sg ?? 0) <= CARNAGE_SG)
  const shots = scoredShots(round)
  const conceded = shots.filter((shot) => shot.conceded).length
  const longMakes = shots
    .filter((shot) => shot.isPutt && shot.holed && !shot.conceded && (shot.startYds ?? 0) * 3 >= 10)
    .map((shot) => `${Math.round((shot.startYds ?? 0) * 3)} ft`)
  const threePutts = scoredHoles.filter((entry) => entry.putts >= 3).length
  const aroundGreen = shots.filter((shot) => shot.category === 'around-green')
  const upAndDowns = aroundGreen.filter((shot) => {
    const holeShots = round.holes.find((entry) => entry.holeNumber === shot.holeNumber)?.shots ?? []
    const after = holeShots.filter((other) => other.number > shot.number).length
    return after <= 1
  }).length
  const cats = round.sg.categories
  const parKnown = round.par != null
  const parNote = course?.parSource === 'course-file'
    ? 'par from GSPro'
    : course?.parSource === 'course-package'
      ? 'par from the loaded course'
      : 'par unknown until Rounds is opened on your sim PC'
  const front = scoredHoles.filter((entry) => entry.holeNumber <= 9)
  const back = scoredHoles.filter((entry) => entry.holeNumber >= 10)
  const half = (holes: RoundHole[], label: string) => {
    if (holes.length === 0) return null
    const strokes = holes.reduce((sum, entry) => sum + entry.strokes, 0)
    const par = holes.every((entry) => entry.par != null) ? holes.reduce((sum, entry) => sum + (entry.par ?? 0), 0) : null
    return `${label} ${strokes}${par != null ? ` (par ${par})` : ''}`
  }

  const captions: Record<ShotCategory, string> = {
    'off-the-tee': `${cats['off-the-tee'].shots} tee shots${round.fir.of > 0 ? `, ${round.fir.hit}/${round.fir.of} fairways` : ''}.`,
    approach: `${cats.approach.shots} shots${round.gir.of > 0 ? `, ${round.gir.hit}/${round.gir.of} greens in regulation` : ''}.`,
    'around-green': aroundGreen.length > 0
      ? `${aroundGreen.length} shots inside 30 yd; up and down ${upAndDowns} of ${aroundGreen.length}.`
      : 'No shots from just off the green.',
    putting: round.autoPutt
      ? 'Auto putt was on, so putting is left out.'
      : `${round.putts} putts.${longMakes.length > 0 ? ` Holed ${longMakes.join(' and ')}.` : ''}${threePutts > 0 ? ` ${threePutts} three-putt${threePutts === 1 ? '' : 's'}.` : ''}${conceded > 0 ? ` ${conceded} gimmes count as made, which flatters this.` : ''}`,
  }

  const liveCaddieShots = shots.filter((shot) => shot.recommendedClub)
  const keyHoles = new Map<number, 'gain' | 'loss'>()
  best.forEach((shot) => keyHoles.set(shot.holeNumber, 'gain'))
  worst.forEach((shot) => { if (!keyHoles.has(shot.holeNumber)) keyHoles.set(shot.holeNumber, 'loss') })
  const holeValue = (entry: RoundHole) => {
    if (!focus) return entry.sg
    if (!entry.complete) return null
    const inCategory = entry.shots.filter((shot) => shot.category === focus && shot.sg != null)
    return inCategory.length > 0 ? inCategory.reduce((sum, shot) => sum + (shot.sg ?? 0), 0) : null
  }
  const facts = [
    `${round.putts} putts`,
    round.fir.of > 0 ? `${round.fir.hit}/${round.fir.of} fairways` : null,
    round.gir.of > 0 ? `${round.gir.hit}/${round.gir.of} greens` : null,
  ].filter(Boolean).join(' · ')

  return (
    <main className="rounds-main">
      <section className="rounds-detail-head">
        <div className="rounds-titlebar">
          <div className="rounds-titlebar-left">
            <a className="rounds-back" href="/rounds">← All rounds</a>
            <span className="rounds-eyebrow">Round · {formatDate(round.playedAt)}</span>
            <h1 className="rounds-course-title">{round.courseName}</h1>
            <p className="rounds-muted rounds-meta">
              {round.completeHoles === round.holesPlayed ? `${round.completeHoles} holes` : `${round.completeHoles} of ${round.holesPlayed} holes finished`} · {STATUS_LABEL[round.status].toLowerCase()} · {isLiveCaddieRound(round) ? 'Live Caddie' : 'no Live Caddie'} · {parNote} ·{' '}
              <button
                aria-pressed={round.autoPutt}
                className="rounds-meta-toggle"
                onClick={() => onAutoPutt(!round.autoPutt)}
                title="Turn on if GSPro putted for you this round; putting then stays out of strokes gained."
                type="button"
              >
                auto putt {round.autoPutt ? 'on' : 'off'}
              </button>
            </p>
          </div>
          <div className="rounds-score-inline">
            <div className="rounds-score-main">
              <span className="rounds-label">Score</span>
              <strong>{round.strokes}</strong>
              <span className="rounds-muted">{parKnown ? `${vsPar(round.strokes, round.par ?? 0)} · par ${round.par}` : `${round.completeHoles} holes`}</span>
            </div>
            <div className="rounds-score-side">
              <span className="rounds-label">SG vs tour</span>
              <strong className={tone(round.sg.total)}>{round.sg.total != null ? signed(round.sg.total) : '–'}</strong>
            </div>
          </div>
        </div>
        {round.status === 'test' ? (
          <p className="rounds-note">This looks like a test session: {round.brokenHoles} hole{round.brokenHoles === 1 ? '' : 's'} had shots that don’t follow on from each other, so nothing here is scored.</p>
        ) : null}
      </section>

      <section className="rounds-catstrip">
        <div className="rounds-catstrip-row" role="group" aria-label="Strokes gained by category">
          {(Object.keys(CATEGORY_LABEL) as ShotCategory[]).map((category) => {
            const value = cats[category].shots > 0 ? cats[category].sg : null
            const width = value == null ? 0 : Math.min(Math.abs(value), 3) / 3 * 100
            const on = focus === category
            return (
              <button
                aria-pressed={on}
                className={`rounds-catcell${on ? ' is-on' : ''}`}
                key={category}
                onClick={() => setFocus(on ? null : category)}
                type="button"
              >
                <span className="rounds-catcell-top">
                  <span>{CATEGORY_LABEL[category]}</span>
                  <strong className={tone(value)}>{value == null ? '–' : signed(value)}</strong>
                </span>
                <span className="rounds-diverge" aria-hidden="true">
                  <span className="rounds-diverge-half is-left">
                    {value != null && value < 0 ? <span className="is-loss-bar" style={{ width: `${width}%` }} /> : null}
                  </span>
                  <span className="rounds-diverge-axis" />
                  <span className="rounds-diverge-half">
                    {value != null && value > 0 ? <span className="is-gain-bar" style={{ width: `${width}%` }} /> : null}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <p className="rounds-catstrip-foot rounds-muted">
          {focus ? captions[focus] : `${facts}. Pick a category to see it hole by hole.`}
        </p>
      </section>

      {best.length + worst.length > 0 ? (
        <section className="rounds-keyshots" aria-label="Key shots">
          {[
            { label: 'Hero shots', shots: best },
            // Voice guide: light ragging is fine, hype isn't. "Carnage" only for a real blow-up.
            { label: (worst[0]?.sg ?? 0) <= CARNAGE_SG ? 'Carnage' : 'Got away', shots: worst },
          ].filter((line) => line.shots.length > 0).map((line) => (
            <div className="rounds-keyline" key={line.label}>
              <span className={`rounds-keyline-label ${line.label === 'Hero shots' ? 'is-hero' : 'is-carnage'}`}>{line.label}</span>
              <div className="rounds-keyline-shots">
                {line.shots.map((shot) => (
                  <button
                    className="rounds-keyshot"
                    key={`${shot.holeNumber}-${shot.number}`}
                    onClick={() => {
                      setSelectedHole(shot.holeNumber)
                      document.getElementById('rounds-hole-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }}
                    type="button"
                  >
                    <strong className={tone(shot.sg)}>{shot.sg != null ? signed(shot.sg) : '–'}</strong>
                    <span>{keyShotHeadline(shot)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="rounds-card rounds-section">
        <div className="rounds-section-head">
          <h2>Hole by hole</h2>
          <span className="rounds-muted">
            {focus ? `Bar = ${CATEGORY_LABEL[focus].toLowerCase()} strokes gained on each hole.` : 'Bar = strokes gained on the hole.'} {[half(front, 'Out'), half(back, 'In')].filter(Boolean).join(' · ')}
          </span>
        </div>
        <div className="rounds-scorecard-wrap">
          <div className="rounds-scorecard">
            {round.holes.map((entry) => {
              const diff = entry.par != null ? entry.strokes - entry.par : null
              const mark = diff == null ? '' : diff <= -2 ? 'is-eagle' : diff === -1 ? 'is-birdie' : diff === 1 ? 'is-bogey' : diff >= 2 ? 'is-double' : ''
              const value = holeValue(entry)
              const sgHeight = value == null ? 0 : Math.max(2, Math.min(Math.abs(value), 1.1) / 1.1 * 26)
              const key = keyHoles.get(entry.holeNumber)
              return (
                <button
                  aria-label={`Hole ${entry.holeNumber}`}
                  aria-pressed={entry.holeNumber === holeNumber}
                  className={`rounds-cell${entry.holeNumber === holeNumber ? ' is-on' : ''}${entry.complete ? '' : ' is-incomplete'}`}
                  key={entry.holeNumber}
                  onClick={() => setSelectedHole(entry.holeNumber)}
                  type="button"
                >
                  <span className="rounds-cell-num">
                    {entry.holeNumber}
                    {key ? <span aria-label="key shot" className={`rounds-cell-key is-${key}`} /> : null}
                  </span>
                  <span className="rounds-cell-par">{entry.par != null ? `P${entry.par}` : '\u00a0'}</span>
                  <span className={`rounds-mark ${mark}`}>{entry.complete ? entry.strokes : '–'}</span>
                  <span className="rounds-cell-bar is-up">
                    {value != null && value > 0 ? <span className="is-gain-bar" style={{ height: sgHeight }} /> : null}
                  </span>
                  <span className="rounds-cell-axis" />
                  <span className="rounds-cell-bar is-down">
                    {value != null && value < 0 ? <span className="is-loss-bar" style={{ height: sgHeight }} /> : null}
                  </span>
                  <span className={`rounds-cell-sg ${tone(value)}`}>{value != null ? signed(value) : ''}</span>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {hole ? (
        <section className="rounds-hole" id="rounds-hole-panel">
          <div className="rounds-card rounds-map-card">
            <ShotMap courseKey={round.courseKey} courseName={round.courseName} hole={hole} />
          </div>
          <div className="rounds-hole-side">
            <div className="rounds-card rounds-shots">
              <div className="rounds-hole-title">
                <span className="rounds-mark is-large">{hole.complete ? hole.strokes : '–'}</span>
                <div>
                  <strong>Hole {hole.holeNumber}{hole.par != null ? ` · Par ${hole.par}` : ''}{hole.shots[0]?.startYds != null ? ` · ${Math.round(hole.shots[0].startYds)} yd` : ''}</strong>
                  <span className="rounds-muted">
                    {hole.complete ? (hole.sg != null ? <>SG <span className={tone(hole.sg)}>{signed(hole.sg)}</span></> : 'Strokes gained not available') : hole.broken ? 'Shots don’t follow on from each other; not scored' : 'Hole not finished'}
                  </span>
                </div>
              </div>
              <div className="rounds-shots-table-wrap">
                <table className="rounds-shots-table">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Club</th>
                      <th scope="col">Type</th>
                      <th scope="col">From → to</th>
                      <th className="is-num" scope="col">Strokes gained</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hole.shots.map((shot) => {
                      const width = shot.sg == null ? 0 : Math.round(Math.min(Math.abs(shot.sg), 1.2) / 1.2 * 56)
                      return (
                        <tr className={focus && shot.category !== focus ? 'is-dim' : undefined} key={shot.number}>
                          <td className="rounds-muted">{shot.number}</td>
                          <td>
                            <strong>{clubName(shot.club)}</strong>
                            {shot.clubSource === 'inferred' && shot.clubConfidence != null && shot.clubConfidence < 0.6 ? (
                              <span className="rounds-muted rounds-small"> guess</span>
                            ) : null}
                          </td>
                          <td className="rounds-muted">{shot.category ? CATEGORY_LABEL[shot.category] : '—'}</td>
                          <td>{shotFrom(shot)} → {shotTo(shot)}{shot.provisional ? <span className="rounds-muted"> *</span> : null}</td>
                          <td className="is-num">
                            <span className="rounds-sgcell">
                              <span className="rounds-sgbar is-left">{shot.sg != null && shot.sg < 0 ? <span className="is-loss-bar" style={{ width }} /> : null}</span>
                              <span className="rounds-sgaxis" />
                              <span className="rounds-sgbar">{shot.sg != null && shot.sg > 0 ? <span className="is-gain-bar" style={{ width }} /> : null}</span>
                              <span className={`rounds-sgnum ${tone(shot.sg)}`}>{shot.sg != null ? signed(shot.sg) : '–'}</span>
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="rounds-card is-dashed">
              <strong>Caddie vs you</strong>
              {liveCaddieShots.length > 0 ? (
                <>
                  <ul className="rounds-caddie-list">
                    {liveCaddieShots.slice(0, 6).map((shot) => (
                      <li key={`${shot.holeNumber}-${shot.number}`}>
                        Hole {shot.holeNumber}, shot {shot.number}: Looper said {clubName(shot.recommendedClub)}, you hit {clubName(shot.club)}
                      </li>
                    ))}
                  </ul>
                  <p className="rounds-muted">What each choice cost or saved fills in once Live Caddie saves its expected strokes when you arm a club.</p>
                </>
              ) : (
                <p className="rounds-muted">On Live Caddie rounds each shot shows Looper’s pick, whether you took it, and what the difference cost or saved. This round was played without Live Caddie.</p>
              )}
            </div>
          </div>
        </section>
      ) : null}

      <ClubsVsRange round={round} />

      <section className="rounds-small rounds-muted rounds-footnote">
        <strong>What this page knows and doesn’t</strong>
        <span>
          Strokes gained uses the PGA Tour baseline (Broadie tables, tour putting). {round.unknownLieShots > 0 ? `${round.unknownLieShots} shot${round.unknownLieShots === 1 ? '' : 's'} (*) started or finished on a GSPro surface we haven’t identified yet; they’re valued as rough. ` : ''}Fringe is valued like the fairway. Penalty strokes are not verified yet.
        </span>
      </section>
    </main>
  )
}

type MapState =
  | { status: 'loading' }
  | { status: 'plain'; reason: string }
  | { status: 'real'; geometry: CourseHoleGeometry; toLocal: (world: { x: number; z: number }) => CoursePointYds | null; source: string }

function ShotMap({ hole, courseKey, courseName }: { hole: RoundHole; courseKey: string | null; courseName: string }) {
  const [state, setState] = useState<MapState>({ status: 'loading' })
  const worldPoints = useMemo(
    () => hole.shots.flatMap((shot) => [shot.start, shot.end]).filter((point): point is NonNullable<typeof point> => point != null),
    [hole],
  )
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void loadHoleMap(courseKey, courseName, hole.holeNumber, worldPoints)
      .then((result) => {
        if (cancelled) return
        setState(result.status === 'ready'
          ? { status: 'real', geometry: result.geometry, toLocal: result.toLocal, source: result.source }
          : { status: 'plain', reason: result.reason })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'plain', reason: 'could not load the course' })
      })
    return () => {
      cancelled = true
    }
  }, [courseKey, courseName, hole, worldPoints])

  return (
    <>
      <div className="rounds-section-head">
        <strong>Shot map · hole {hole.holeNumber}</strong>
        <span className="rounds-muted">Tee at bottom</span>
      </div>
      {state.status === 'real'
        ? <RealHoleMap geometry={state.geometry} hole={hole} toLocal={state.toLocal} />
        : <PlainShotMap hole={hole} />}
      <p className="rounds-muted rounds-small">
        {state.status === 'real'
          ? 'Your shots on the course Looper loaded, placed with the same alignment Live Caddie uses. Dashed lines are putts.'
          : state.status === 'loading'
            ? 'Looking for this hole’s map…'
            : 'Drawn from GSPro’s own shot positions. Courses Looper has loaded show the real hole once your sim PC has opened Rounds. Dashed lines are putts.'}
      </p>
    </>
  )
}

const SURFACE_ORDER: readonly CourseSurfaceKind[] = ['rough', 'deep-rough', 'fairway', 'tee', 'penalty', 'water', 'bunker', 'green']

function RealHoleMap({
  hole,
  geometry,
  toLocal,
}: {
  hole: RoundHole
  geometry: CourseHoleGeometry
  toLocal: (world: { x: number; z: number }) => CoursePointYds | null
}) {
  const segments = hole.shots
    .map((shot) => ({ shot, from: shot.start ? toLocal(shot.start) : null, to: shot.end ? toLocal(shot.end) : null }))
    .filter((segment): segment is { shot: RoundShot; from: CoursePointYds; to: CoursePointYds } => segment.from != null && segment.to != null)
  if (segments.length === 0) return <PlainShotMap hole={hole} />
  const pin = hole.pin ? toLocal(hole.pin) : segments[segments.length - 1].to
  const base = geometry.viewBounds ?? geometry.bounds
  const points = [...segments.flatMap((segment) => [segment.from, segment.to]), ...(pin ? [pin] : [])]
  const pad = 12
  const minX = Math.min(base.minX, ...points.map((p) => p[0])) - pad
  const maxX = Math.max(base.maxX, ...points.map((p) => p[0])) + pad
  const minY = Math.min(base.minY, ...points.map((p) => p[1])) - pad
  const maxY = Math.max(base.maxY, ...points.map((p) => p[1])) + pad
  const width = 320
  const scale = width / (maxX - minX)
  const height = Math.max(260, Math.min(560, (maxY - minY) * scale))
  // Keep yards square: if the hole is taller than the frame allows, fit by height.
  const s = Math.min(scale, height / (maxY - minY))
  const offsetX = (width - (maxX - minX) * s) / 2
  const offsetY = (height - (maxY - minY) * s) / 2
  const x = (p: CoursePointYds) => offsetX + (p[0] - minX) * s
  const y = (p: CoursePointYds) => offsetY + (maxY - p[1]) * s
  const path = (polygon: readonly CoursePointYds[]) =>
    polygon.length < 3 ? '' : `M${polygon.map((p) => `${x(p).toFixed(1)},${y(p).toFixed(1)}`).join('L')}Z`
  const surfaces = [...geometry.surfaces].sort((a, b) => SURFACE_ORDER.indexOf(a.kind) - SURFACE_ORDER.indexOf(b.kind))
  const fifty = 50 * s
  return (
    <svg className="rounds-map is-real" role="img" aria-label={`Shots on hole ${hole.holeNumber}, drawn on the course`} viewBox={`0 0 ${width} ${height.toFixed(0)}`}>
      <rect className="rounds-map-ground" height={height} width={width} x={0} y={0} />
      {surfaces.map((surface) => (
        <path className={`rounds-surf is-${surface.kind}`} d={surface.polygons.map(path).join(' ')} key={surface.id} />
      ))}
      {segments.map(({ shot, from, to }) => (
        <line className={shot.isPutt ? 'rounds-map-putt' : 'rounds-map-shot'} key={`l-${shot.number}`} x1={x(from)} x2={x(to)} y1={y(from)} y2={y(to)} />
      ))}
      {segments.slice(0, -1).map(({ shot, to }) => (
        <circle className="rounds-map-dot" cx={x(to)} cy={y(to)} key={`d-${shot.number}`} r={4} />
      ))}
      <rect className="rounds-map-tee" height={10} width={10} x={x(segments[0].from) - 5} y={y(segments[0].from) - 5} />
      {pin ? <circle className="rounds-map-pin" cx={x(pin)} cy={y(pin)} r={6} /> : null}
      {fifty > 12 ? (
        <g className="rounds-map-scale">
          <line x1={12} x2={12 + fifty} y1={height - 12} y2={height - 12} />
          <text x={12} y={height - 18}>50 yd</text>
        </g>
      ) : null}
    </svg>
  )
}

function PlainShotMap({ hole }: { hole: RoundHole }) {
  const map = holeShotMap(hole)
  if (!map) return <p className="rounds-muted">No positions recorded for this hole.</p>
  const width = 320
  const height = 440
  const pad = 26
  const points = [map.tee, map.pin, ...map.segments.flatMap((segment) => [segment.from, segment.to])]
  const minForward = Math.min(...points.map((p) => p.forward))
  const maxForward = Math.max(...points.map((p) => p.forward))
  const maxRight = Math.max(25, ...points.map((p) => Math.abs(p.right))) + 10
  const scale = Math.min((height - 2 * pad) / Math.max(40, maxForward - minForward), (width / 2 - pad) / maxRight)
  const x = (p: { right: number }) => width / 2 + p.right * scale
  const y = (p: { forward: number }) => height - pad - (p.forward - minForward) * scale
  const fifty = 50 * scale
  return (
    <svg className="rounds-map" role="img" aria-label={`Shots on hole ${hole.holeNumber}`} viewBox={`0 0 ${width} ${height}`}>
      <line className="rounds-map-axis" x1={width / 2} x2={width / 2} y1={pad / 2} y2={height - pad / 2} />
      {map.segments.map(({ shot, from, to }) => (
        <line
          className={shot.isPutt ? 'rounds-map-putt' : 'rounds-map-shot'}
          key={`l-${shot.number}`}
          x1={x(from)}
          x2={x(to)}
          y1={y(from)}
          y2={y(to)}
        />
      ))}
      {map.segments.slice(0, -1).map(({ shot, to }) => (
        <circle className="rounds-map-dot" cx={x(to)} cy={y(to)} key={`d-${shot.number}`} r={4.5} />
      ))}
      <rect className="rounds-map-tee" height={11} width={11} x={x(map.tee) - 5.5} y={y(map.tee) - 5.5} />
      <circle className="rounds-map-pin" cx={x(map.pin)} cy={y(map.pin)} r={6.5} />
      {fifty > 12 ? (
        <g className="rounds-map-scale">
          <line x1={14} x2={14 + fifty} y1={height - 14} y2={height - 14} />
          <text x={14} y={height - 20}>50 yd</text>
        </g>
      ) : null}
    </svg>
  )
}

function ClubsVsRange({ round }: { round: RoundSummary }) {
  const range = useMemo(() => {
    try {
      return loadRangeCarries()
    } catch {
      return new Map<string, RangeClubNumbers>()
    }
  }, [])
  const carries = onCourseCarriesByClub([round])
  const rows = [...carries.entries()]
    .map(([club, entry]) => {
      const numbers = range.get(club) ?? null
      // Leave out partial swings and duffs: only shots near a full carry compare.
      const full = numbers ? entry.carries.filter((carry) => carry >= numbers.carry * 0.75) : entry.carries
      return { club, numbers, carries: full, entry }
    })
    .filter((row) => row.carries.length > 0)
    .sort((a, b) => (b.numbers?.carry ?? median(b.carries) ?? 0) - (a.numbers?.carry ?? median(a.carries) ?? 0))
  if (rows.length === 0) return null
  const anyGuessed = rows.some((row) => row.entry.armed < row.carries.length)

  return (
    <section className="rounds-card rounds-section">
      <div className="rounds-section-head">
        <h2>Your clubs out here vs on the range</h2>
        <span className="rounds-muted">Dots = this round’s carries. Band = your range middle 50%. Line = range stock.</span>
      </div>
      <div className="rounds-shots-table-wrap">
        <table className="rounds-clubs-table">
          <thead>
            <tr>
              <th scope="col">Club</th>
              <th scope="col">Carry, ±35 yd around range stock</th>
              <th className="is-num" scope="col">Course</th>
              <th className="is-num" scope="col">Range</th>
              <th className="is-num" scope="col">Gap</th>
              <th scope="col">Club source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ club, numbers, carries: clubCarries, entry }) => {
              const courseMedian = median(clubCarries) ?? 0
              const center = numbers?.carry ?? courseMedian
              const pos = (value: number) => Math.max(0, Math.min(100, ((value - (center - 35)) / 70) * 100))
              const gap = numbers ? courseMedian - numbers.carry : null
              const meanConfidence = entry.confidences.length > 0
                ? entry.confidences.reduce((sum, value) => sum + value, 0) / entry.confidences.length
                : null
              const source = entry.armed >= clubCarries.length
                ? 'Armed'
                : meanConfidence != null
                  ? `${meanConfidence < 0.5 ? 'Low' : meanConfidence < 0.7 ? 'Medium' : 'High'} (${Math.round(meanConfidence * 100)}%)${gap != null && Math.abs(gap) >= 12 ? ' · check' : ''}`
                  : 'Guessed'
              return (
                <tr key={club}>
                  <td><strong>{clubName(club)}</strong> <span className="rounds-muted rounds-small">×{clubCarries.length}</span></td>
                  <td>
                    <div className="rounds-strip">
                      {numbers?.low != null && numbers.high != null ? (
                        <div className="rounds-strip-band" style={{ left: `${pos(numbers.low)}%`, width: `${pos(numbers.high) - pos(numbers.low)}%` }} />
                      ) : null}
                      {numbers ? <div className="rounds-strip-line" style={{ left: '50%' }} /> : null}
                      {clubCarries.map((carry, i) => (
                        <div className="rounds-strip-dot" key={i} style={{ left: `${pos(carry)}%` }} />
                      ))}
                    </div>
                  </td>
                  <td className="is-num">{Math.round(courseMedian)}</td>
                  <td className="is-num rounds-muted">{numbers ? Math.round(numbers.carry) : '–'}</td>
                  <td className="is-num"><strong>{gap != null ? signed(gap, 0) : '–'}</strong></td>
                  <td className="rounds-small">{source}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {anyGuessed ? (
        <p className="rounds-muted rounds-small">
          Clubs not armed in Live Caddie are Looper’s guess from the ball data. A gap of 12+ yards on a low-confidence guess most likely means the wrong club, not a longer swing. Carry is not adjusted for elevation yet.
        </p>
      ) : null}
    </section>
  )
}
