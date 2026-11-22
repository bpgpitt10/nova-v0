import { useCallback, useEffect, useMemo, useState } from 'react'
import { BagTopBar } from '../components/BagNav'
import { getActiveBagClubIds, getClubLabel, type Club } from '../lib/bagConfig'
import { SHORT_RUN_SWINGS, sessionFromVisit, type RangeRun, type RangeVisit, type RunChoice } from '../lib/rangeSort'
import { dismissSwings, loadUnsortedRangeVisits, saveSortedVisit } from '../lib/rangeSortData'
import './RoundsPage.css'
import './RangeSortPage.css'

/**
 * /range-sort: range swings Looper saw in GSPro with no club tagged, grouped
 * into runs so the player names the club once per run and adds them to the bag.
 */

const navigate = (path: string) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const visitDate = (visit: RangeVisit) =>
  new Date(visit.startedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

const visitTime = (visit: RangeVisit) =>
  new Date(visit.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

const yd = (value: number) => Math.round(value)

type Choice = { club: Club | null; keep: boolean; keepIds: Set<string> }

const startingChoice = (run: RangeRun): Choice => ({
  club: run.guess,
  keep: run.swings.length > SHORT_RUN_SWINGS,
  keepIds: new Set(run.swings.filter((swing) => !run.outlierIds.has(swing.id)).map((swing) => swing.id)),
})

type Data =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; visits: RangeVisit[] }

type Saved = { swings: number; clubs: number }

const SAMPLE_BAG: Club[] = ['Driver', '3W', '4H', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW', 'SW', 'LW']

function RunRow({ run, choice, bag, onChange }: {
  run: RangeRun
  choice: Choice
  bag: readonly Club[]
  onChange: (next: Choice) => void
}) {
  const [open, setOpen] = useState(false)
  const kept = choice.keep ? choice.keepIds.size : 0
  const carry = run.carryLowYds === run.carryHighYds || run.swings.length === 1
    ? `${yd(run.carryYds)} yd`
    : `${yd(run.carryLowYds)} to ${yd(run.carryHighYds)} yd`
  const leftOut = run.swings.length - choice.keepIds.size
  return (
    <li className={`range-sort-run${choice.keep ? '' : ' is-skipped'}${choice.keep && !choice.club ? ' needs-club' : ''}`}>
      <div className="range-sort-run__main">
        <label className="range-sort-run__keep">
          <input
            checked={choice.keep}
            onChange={(event) => onChange({ ...choice, keep: event.target.checked })}
            type="checkbox"
          />
          <span className="range-sort-run__count">
            <strong>{run.swings.length}</strong> swing{run.swings.length === 1 ? '' : 's'}
          </span>
        </label>
        <div className="range-sort-run__numbers">
          <strong>{carry}</strong>
          <span>carry · {yd(run.ballSpeedMph)} mph{run.launchDeg != null ? ` · ${run.launchDeg.toFixed(0)}° launch` : ''}</span>
        </div>
        <label className="range-sort-run__club">
          <span>{run.guess ? `Looks like ${getClubLabel(run.guess)}` : 'Which club?'}</span>
          <select
            disabled={!choice.keep}
            onChange={(event) => onChange({ ...choice, club: (event.target.value || null) as Club | null })}
            value={choice.club ?? ''}
          >
            <option value="">Pick a club</option>
            {bag.map((club) => <option key={club} value={club}>{getClubLabel(club)}</option>)}
          </select>
        </label>
      </div>
      <div className="range-sort-run__foot">
        <span className="rounds-muted">
          {choice.keep
            ? leftOut > 0 ? `${kept} going in · ${leftOut} left out (off the pattern)` : `All ${kept} going in`
            : run.swings.length <= SHORT_RUN_SWINGS ? 'Left out: too few swings to tell a club. Tick to add.' : 'Left out'}
        </span>
        <button className="rounds-link-button" onClick={() => setOpen((v) => !v)} type="button">
          {open ? 'Hide swings' : 'Show swings'}
        </button>
      </div>
      {open ? (
        <div className="range-sort-scroll">
          <table className="range-sort-swings">
            <thead>
              <tr><th scope="col">In</th><th scope="col">Carry</th><th scope="col">Ball speed</th><th scope="col">Launch</th><th scope="col">Spin</th><th scope="col">Offline</th></tr>
            </thead>
            <tbody>
              {run.swings.map((swing) => (
                <tr className={choice.keepIds.has(swing.id) ? '' : 'is-out'} key={swing.id}>
                  <td>
                    <input
                      aria-label={`Include the ${yd(swing.carryYds)} yard swing`}
                      checked={choice.keepIds.has(swing.id)}
                      disabled={!choice.keep}
                      onChange={(event) => {
                        const keepIds = new Set(choice.keepIds)
                        if (event.target.checked) keepIds.add(swing.id)
                        else keepIds.delete(swing.id)
                        onChange({ ...choice, keepIds })
                      }}
                      type="checkbox"
                    />
                  </td>
                  <td>{yd(swing.carryYds)} yd</td>
                  <td>{swing.ballSpeedMph.toFixed(0)} mph</td>
                  <td>{swing.launchDeg != null ? `${swing.launchDeg.toFixed(1)}°` : '—'}</td>
                  <td>{swing.spinRpm != null ? `${Math.round(swing.spinRpm)} rpm` : '—'}</td>
                  <td>{swing.offlineYds != null
                    ? Math.abs(swing.offlineYds) < 0.5 ? 'Straight' : `${Math.abs(swing.offlineYds).toFixed(0)} yd ${swing.offlineYds > 0 ? 'right' : 'left'}`
                    : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </li>
  )
}

type Props = {
  /** /dev/range-sort: sample visits; nothing is loaded or saved. */
  sampleVisits?: RangeVisit[]
}

export default function RangeSortPage({ sampleVisits }: Props = {}) {
  const [data, setData] = useState<Data>({ status: 'loading' })
  const [visitKey, setVisitKey] = useState<string | null>(null)
  const [choices, setChoices] = useState<Map<string, Choice>>(new Map())
  const [saved, setSaved] = useState<Saved | null>(null)
  const bag = useMemo(() => {
    const active = getActiveBagClubIds()
    return active.length || !sampleVisits ? active : SAMPLE_BAG
  }, [sampleVisits])

  const load = useCallback(async () => {
    if (sampleVisits) {
      setData({ status: 'ready', visits: sampleVisits })
      setVisitKey((current) => current ?? sampleVisits[0]?.key ?? null)
      return
    }
    try {
      const visits = await loadUnsortedRangeVisits()
      setData({ status: 'ready', visits })
      setVisitKey((current) => (current && visits.some((v) => v.key === current) ? current : visits[0]?.key ?? null))
    } catch (error) {
      setData({ status: 'error', message: error instanceof Error ? error.message : 'Could not load your range swings.' })
    }
  }, [sampleVisits])

  useEffect(() => { void load() }, [load])

  const visits = data.status === 'ready' ? data.visits : []
  const visit = visits.find((v) => v.key === visitKey) ?? null

  useEffect(() => {
    if (!visit) return
    setChoices(new Map(visit.runs.map((run) => [run.key, startingChoice(run)])))
  // A new visit (or a reload after saving) starts from Looper's guesses.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visit?.key, visit?.swings.length])

  const keptRuns = visit ? visit.runs.filter((run) => choices.get(run.key)?.keep) : []
  const needClub = keptRuns.filter((run) => !choices.get(run.key)?.club).length
  const goingIn = keptRuns.reduce((sum, run) => sum + (choices.get(run.key)?.keepIds.size ?? 0), 0)

  const add = () => {
    if (!visit || needClub > 0 || goingIn === 0) return
    const final = new Map<string, RunChoice>()
    visit.runs.forEach((run) => {
      const choice = choices.get(run.key)
      final.set(run.key, { club: choice?.keep ? choice.club : null, keepIds: choice?.keepIds ?? new Set() })
    })
    const session = sessionFromVisit(visit, final)
    if (!session) return
    if (sampleVisits) {
      setSaved({ swings: session.shots.length, clubs: new Set(session.shots.map((shot) => shot.club)).size })
      return
    }
    saveSortedVisit(session)
    // Everything else in this visit was looked at and left out: don't offer it again.
    const savedIds = new Set(session.shots.map((shot) => shot.id.replace(/^range-/, '')))
    dismissSwings(visit.swings.filter((swing) => !savedIds.has(swing.id)).map((swing) => swing.id))
    setSaved({ swings: session.shots.length, clubs: new Set(session.shots.map((shot) => shot.club)).size })
    void load()
  }

  const skipVisit = () => {
    if (!visit || sampleVisits) return
    dismissSwings(visit.swings.map((swing) => swing.id))
    setSaved(null)
    void load()
  }

  return (
    <div className="rounds-page range-sort-page">
      <div className="rounds-shell">
        <BagTopBar active="bag" editBagHref="/bag-setup?returnTo=%2Frange-sort" onBag={() => navigate('/bag')} />
        <main className="rounds-main range-sort-main">
          <header className="range-sort-head">
            <h1 className="rounds-display-title">Sort your range swings</h1>
            <p className="range-sort-lead">
              Looper saw these swings on GSPro’s range, but no club was tagged, so they aren’t in your bag.
              Each row is a run of swings that look alike. Name the club once and they all go in.
            </p>
          </header>

          {saved ? (
            <div className="rounds-note range-sort-saved" role="status">
              <strong>Added {saved.swings} swing{saved.swings === 1 ? '' : 's'} across {saved.clubs} club{saved.clubs === 1 ? '' : 's'}.</strong>{' '}
              They count in your bag now. <a href="/bag">See your bag</a>
            </div>
          ) : null}

          {data.status === 'loading' ? <p className="rounds-empty">Looking for range swings…</p> : null}
          {data.status === 'error' ? <p className="rounds-empty">{data.message}</p> : null}
          {data.status === 'ready' && visits.length === 0 ? (
            <div className="rounds-empty">
              <strong>Nothing to sort.</strong>
              <span>When you hit balls on GSPro’s range with the companion running, the swings show up here.</span>
            </div>
          ) : null}

          {visits.length > 1 ? (
            <div className="range-sort-visits" role="tablist" aria-label="Range visits">
              {visits.map((v) => (
                <button
                  aria-selected={v.key === visitKey}
                  className={v.key === visitKey ? 'is-active' : ''}
                  key={v.key}
                  onClick={() => { setVisitKey(v.key); setSaved(null) }}
                  role="tab"
                  type="button"
                >
                  {visitDate(v)} <span>{v.swings.length} swings</span>
                </button>
              ))}
            </div>
          ) : null}

          {visit ? (
            <section className="range-sort-visit" aria-label={`Range visit ${visitDate(visit)}`}>
              <div className="range-sort-visit__head">
                <h2>{visitDate(visit)} · {visitTime(visit)}</h2>
                <span className="rounds-muted">{visit.swings.length} swings in {visit.runs.length} run{visit.runs.length === 1 ? '' : 's'}, in the order you hit them</span>
              </div>
              <ol className="range-sort-runs">
                {visit.runs.map((run) => {
                  const choice = choices.get(run.key) ?? startingChoice(run)
                  return (
                    <RunRow
                      bag={bag}
                      choice={choice}
                      key={run.key}
                      onChange={(next) => setChoices((current) => new Map(current).set(run.key, next))}
                      run={run}
                    />
                  )
                })}
              </ol>
              <div className="range-sort-actions">
                <div>
                  <button className="range-sort-add" disabled={needClub > 0 || goingIn === 0} onClick={add} type="button">
                    Add {goingIn} swing{goingIn === 1 ? '' : 's'} to your bag
                  </button>
                  {needClub > 0 ? (
                    <span className="range-sort-need">Pick a club for {needClub} run{needClub === 1 ? '' : 's'}, or untick {needClub === 1 ? 'it' : 'them'}.</span>
                  ) : null}
                </div>
                <div className="range-sort-actions__side">
                  <span className="rounds-muted">Unticked swings stay out of your bag.</span>
                  <button className="rounds-link-button" onClick={skipVisit} type="button">Skip this visit</button>
                </div>
              </div>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  )
}
