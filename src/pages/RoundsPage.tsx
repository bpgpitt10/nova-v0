import { useCallback, useEffect, useMemo, useState } from 'react'
import { BagTopBar } from '../components/BagNav'
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
import type { RoundFlags, RoundShotRecord } from '../lib/roundHistory'
import './RoundsPage.css'

const FULL_ROUNDS_FOR_TRENDS = 5

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

const keyShotDetail = (shot: RoundShot) => {
  if (shot.isPutt && shot.holed) return 'One putt where the baseline expects more.'
  return `Finished ${shotTo(shot).replace(' · ', ', ').toLowerCase()}.`
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
          <h1>Rounds</h1>
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
  const worstHole = [...scoredHoles].sort((a, b) => (a.sg ?? 0) - (b.sg ?? 0))[0]
  const holeNumber = selectedHole ?? worstHole?.holeNumber ?? round.holes[0]?.holeNumber ?? null
  const hole = round.holes.find((entry) => entry.holeNumber === holeNumber) ?? null
  const { best, worst } = keyShots(round)
  const highlights = [...best, ...worst]
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
    ? 'Par from the GSPro course file'
    : course?.parSource === 'course-package'
      ? 'Par from the loaded course'
      : 'Par unknown until the companion reads the course file on your sim PC'
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

  return (
    <main className="rounds-main">
      <section className="rounds-detail-head">
        <a className="rounds-back" href="/rounds">← All rounds</a>
        <div className="rounds-detail-title">
          <div>
            <h1>{round.courseName}</h1>
            <p className="rounds-muted">
              {formatDate(round.playedAt)} · {round.completeHoles === round.holesPlayed ? `${round.completeHoles} holes` : `${round.completeHoles} of ${round.holesPlayed} holes finished`} · every putt and lie captured by the companion
            </p>
            <div className="rounds-chips">
              <span className="rounds-pill">{STATUS_LABEL[round.status]}</span>
              <span className="rounds-pill">{isLiveCaddieRound(round) ? 'Live Caddie round' : 'Played without Live Caddie'}</span>
              <span className="rounds-pill">{parNote}</span>
              <label className="rounds-toggle">
                <input checked={round.autoPutt} onChange={(event) => onAutoPutt(event.target.checked)} type="checkbox" />
                Auto putt was on
              </label>
            </div>
          </div>
          <div className="rounds-scoreblock">
            <div>
              <span className="rounds-label">Score</span>
              <strong className="rounds-big">{round.strokes}</strong>
              <span className="rounds-muted">{parKnown ? `${vsPar(round.strokes, round.par ?? 0)}, par ${round.par}` : `${round.completeHoles} holes`}</span>
            </div>
            <div>
              <span className="rounds-label">Strokes gained</span>
              <strong className={`rounds-big ${tone(round.sg.total)}`}>{round.sg.total != null ? signed(round.sg.total) : '–'}</strong>
              <span className="rounds-muted">vs PGA Tour baseline</span>
            </div>
          </div>
        </div>
        {round.status === 'test' ? (
          <p className="rounds-note">This looks like a test session: {round.brokenHoles} hole{round.brokenHoles === 1 ? '' : 's'} had shots that don’t follow on from each other, so nothing here is scored.</p>
        ) : null}
      </section>

      <section className="rounds-cats">
        {(Object.keys(CATEGORY_LABEL) as ShotCategory[]).map((category) => {
          const value = cats[category].shots > 0 ? cats[category].sg : null
          const width = value == null ? 0 : Math.min(Math.abs(value), 3) / 3 * 50
          return (
            <div className="rounds-card rounds-cat" key={category}>
              <div className="rounds-cat-top">
                <span>{CATEGORY_LABEL[category]}</span>
                <strong className={tone(value)}>{value == null ? '–' : signed(value)}</strong>
              </div>
              <div className="rounds-diverge" aria-hidden="true">
                <div className="rounds-diverge-half is-left">
                  {value != null && value < 0 ? <div className="is-loss-bar" style={{ width: `${width * 2}%` }} /> : null}
                </div>
                <div className="rounds-diverge-axis" />
                <div className="rounds-diverge-half">
                  {value != null && value > 0 ? <div className="is-gain-bar" style={{ width: `${width * 2}%` }} /> : null}
                </div>
              </div>
              <p className="rounds-muted">{captions[category]}</p>
            </div>
          )
        })}
      </section>

      {highlights.length > 0 ? (
        <section className="rounds-section">
          <h2>The round in {highlights.length === 3 ? 'three' : highlights.length} shots</h2>
          <div className="rounds-highlights">
            {highlights.map((shot) => (
              <button
                className="rounds-card rounds-highlight"
                key={`${shot.holeNumber}-${shot.number}`}
                onClick={() => {
                  setSelectedHole(shot.holeNumber)
                  document.getElementById('rounds-hole-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
                type="button"
              >
                <strong className={`rounds-big-ish ${tone(shot.sg)}`}>{shot.sg != null ? signed(shot.sg) : '–'}</strong>
                <span className="rounds-highlight-title">{keyShotHeadline(shot)}</span>
                <span className="rounds-muted">{keyShotDetail(shot)}</span>
                <span className="rounds-open">Open hole {shot.holeNumber} →</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounds-card rounds-section">
        <div className="rounds-section-head">
          <h2>Hole by hole</h2>
          <span className="rounds-muted">Bar = strokes gained on the hole. {[half(front, 'Out'), half(back, 'In')].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="rounds-scorecard-wrap">
          <div className="rounds-scorecard">
            {round.holes.map((entry) => {
              const diff = entry.par != null ? entry.strokes - entry.par : null
              const mark = diff == null ? '' : diff <= -2 ? 'is-eagle' : diff === -1 ? 'is-birdie' : diff === 1 ? 'is-bogey' : diff >= 2 ? 'is-double' : ''
              const sgHeight = entry.sg == null ? 0 : Math.max(2, Math.min(Math.abs(entry.sg), 1.1) / 1.1 * 26)
              return (
                <button
                  aria-label={`Hole ${entry.holeNumber}`}
                  aria-pressed={entry.holeNumber === holeNumber}
                  className={`rounds-cell${entry.holeNumber === holeNumber ? ' is-on' : ''}${entry.complete ? '' : ' is-incomplete'}`}
                  key={entry.holeNumber}
                  onClick={() => setSelectedHole(entry.holeNumber)}
                  type="button"
                >
                  <span className="rounds-cell-num">{entry.holeNumber}</span>
                  <span className="rounds-cell-par">{entry.par != null ? `P${entry.par}` : ' '}</span>
                  <span className={`rounds-mark ${mark}`}>{entry.complete ? entry.strokes : '–'}</span>
                  <span className="rounds-cell-bar is-up">
                    {entry.sg != null && entry.sg > 0 ? <span className="is-gain-bar" style={{ height: sgHeight }} /> : null}
                  </span>
                  <span className="rounds-cell-axis" />
                  <span className="rounds-cell-bar is-down">
                    {entry.sg != null && entry.sg < 0 ? <span className="is-loss-bar" style={{ height: sgHeight }} /> : null}
                  </span>
                  <span className={`rounds-cell-sg ${tone(entry.sg)}`}>{entry.sg != null ? signed(entry.sg) : ''}</span>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {hole ? (
        <section className="rounds-hole" id="rounds-hole-panel">
          <div className="rounds-card rounds-map-card">
            <div className="rounds-section-head">
              <strong>Shot map · hole {hole.holeNumber}</strong>
              <span className="rounds-muted">Tee at bottom, pin at top</span>
            </div>
            <ShotMap hole={hole} />
            <p className="rounds-muted rounds-small">
              Drawn from GSPro’s own shot positions, so it works on any course. Dashed lines are putts.
            </p>
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
                        <tr key={shot.number}>
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
          Strokes gained uses the PGA Tour baseline (Broadie tables, tour putting). {round.unknownLieShots > 0 ? `${round.unknownLieShots} shot${round.unknownLieShots === 1 ? '' : 's'} (*) started or finished on a GSPro surface we haven’t identified yet; they’re valued as rough. ` : ''}Chips from just off the green may show as fairway until GSPro’s fringe code is confirmed. Penalty strokes are not verified yet.
        </span>
      </section>
    </main>
  )
}

function ShotMap({ hole }: { hole: RoundHole }) {
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
