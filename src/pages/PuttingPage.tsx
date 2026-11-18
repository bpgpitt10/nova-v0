import { useMemo, useState } from 'react'
import type { RoundSummary } from '../lib/roundHistory'
import {
  buildPuttingProfile,
  IDEAL_PAST_FT,
  MIN_PUTT_FT,
  MIN_PUTTS_FOR_LABEL,
  PUTT_LENGTH_BUCKETS,
  READ_PUTTS_NEEDED,
  summarizeLine,
  summarizePace,
  type ProfilePutt,
  type PuttSlope,
  type SkillKind,
  type SkillSummary,
} from '../lib/puttingProfile'
import './PuttingPage.css'

const MINUS = '−'
const signed = (value: number, digits = 2) => {
  const rounded = Number(value.toFixed(digits))
  if (rounded === 0) return (0).toFixed(digits)
  return `${rounded > 0 ? '+' : MINUS}${Math.abs(rounded).toFixed(digits)}`
}
const tone = (value: number | null) =>
  value == null ? 'is-even' : value >= 0.05 ? 'is-gain' : value <= -0.05 ? 'is-loss' : 'is-even'

const feet = (value: number) => {
  const inches = Math.round(Math.abs(value) * 12)
  if (inches < 12) return `${inches} in.`
  const ft = Math.floor(inches / 12)
  const rest = inches % 12
  return rest ? `${ft} ft ${rest} in.` : `${ft} ft`
}

const KIND_LABEL: Record<SkillKind, string> = {
  collecting: 'Collecting',
  strength: 'Strength',
  habit: 'Good, with a habit',
  'habit-scatter': 'Habit plus scatter',
  scattered: 'Scattered',
}

const SLOPE_LABEL: Record<PuttSlope, string> = { up: 'Uphill', flat: 'Flat', down: 'Downhill' }

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const leanText = (skill: SkillSummary) => {
  if (skill.lean) return `${capital(skill.lean.side)} ${skill.lean.count} times in ${skill.lean.of}`
  if (skill.split && skill.split.aCount + skill.split.bCount >= 4) {
    return `None: ${skill.split.a} ${skill.split.aCount}, ${skill.split.b} ${skill.split.bCount}`
  }
  return 'Too few to say'
}

const paceSize = (skill: SkillSummary) => (skill.size != null ? `${Math.round(skill.size * 100)}% of the putt’s length` : 'Not enough yet')
const lineSize = (skill: SkillSummary) => (skill.size != null ? `${skill.size.toFixed(1)}° off your aim` : 'Not enough yet')

const paceAdvice = (skill: SkillSummary) => {
  if (skill.kind === 'collecting') return `Needs ${MIN_PUTTS_FOR_LABEL} missed putts to say; ${skill.putts} so far.`
  if (skill.lean?.side === 'short') return 'Get it to the hole first. A putt that stops short never had a chance.'
  if (skill.lean?.side === 'long') return 'You run it well past. Less pace leaves a shorter one coming back.'
  if (skill.kind === 'scattered') return 'Short as often as long. This is feel, not one fix: practise rolling to a distance.'
  return 'Your distance control holds up.'
}
const lineAdvice = (skill: SkillSummary) => {
  if (skill.kind === 'collecting') return `Needs ${MIN_PUTTS_FOR_LABEL} putts with a start direction; ${skill.putts} so far.`
  if (skill.lean) return `You start it ${skill.lean.side} of where you aim. Check your set-up before changing your read.`
  if (skill.kind === 'scattered') return 'The start direction wanders both ways. A gate drill tightens this.'
  return 'Your stroke starts the ball where you point it.'
}

type RoundWindow = 'last' | 'five' | 'all'

const PACE_COLOR = { short: 'var(--putting-pace)', long: 'var(--putting-long)', good: 'var(--putting-sideways)' } as const

/** Three rings that cover the furthest miss shown. */
const ringStepFt = (misses: readonly ProfilePutt[]) => {
  const furthest = misses.reduce((max, putt) => Math.max(max, Math.abs(putt.alongFt ?? 0), Math.abs(putt.lateralFt ?? 0)), 0)
  return [0.5, 1, 2, 3, 5, 10].find((step) => step * 3 >= furthest) ?? 15
}

function CupChart({ misses }: { misses: readonly ProfilePutt[] }) {
  const step = ringStepFt(misses)
  const scale = 70 / step
  return (
    <div className="putting-cup">
      <svg aria-label={`${misses.length} missed putts drawn where they finished around the cup`} role="img" viewBox="0 0 560 560">
        <g className="putting-cup-rings">
          <circle cx="280" cy="280" r="70" /><circle cx="280" cy="280" r="140" /><circle cx="280" cy="280" r="210" />
          <line x1="280" x2="280" y1="36" y2="524" /><line x1="36" x2="524" y1="280" y2="280" />
        </g>
        <g className="putting-cup-scale">
          {[1, 2, 3].map((ring) => <text key={ring} x="286" y={280 - ring * 70 - 4}>{feet(step * ring)}</text>)}
        </g>
        <g className="putting-cup-sides">
          <text textAnchor="middle" x="280" y="26">LONG</text>
          <text textAnchor="middle" x="280" y="548">SHORT</text>
          <text x="16" y="274">LEFT</text>
          <text textAnchor="end" x="544" y="274">RIGHT</text>
        </g>
        <circle className="putting-cup-hole" cx="280" cy="280" r="14" />
        {misses.map((putt) => (
          <circle
            key={`${putt.roundId}-${putt.holeNumber}-${putt.number}`}
            className="putting-cup-dot"
            cx={280 + Math.max(-258, Math.min(258, (putt.lateralFt ?? 0) * scale))}
            cy={280 - Math.max(-258, Math.min(258, (putt.alongFt ?? 0) * scale))}
            r="8"
            style={{ fill: PACE_COLOR[putt.pace === 'short' ? 'short' : putt.pace === 'long' ? 'long' : 'good'] }}
          >
            <title>{`${putt.courseName} hole ${putt.holeNumber}: ${Math.round(putt.lengthFt)} ft putt`}</title>
          </circle>
        ))}
      </svg>
    </div>
  )
}

function TrendChart({ points }: { points: ReadonlyArray<{ rolling: number; courseName: string; playedAt: string | null }> }) {
  const low = Math.min(0, ...points.map((p) => p.rolling))
  const high = Math.max(0, ...points.map((p) => p.rolling))
  const span = Math.max(0.5, high - low)
  const x = (index: number) => 60 + (points.length > 1 ? (index / (points.length - 1)) * 900 : 450)
  const y = (value: number) => 20 + ((high - value) / span) * 180
  return (
    <svg aria-label="Strokes gained putting per round, averaged over three rounds at a time" className="putting-trend" role="img" viewBox="0 0 1000 240">
      <line className="putting-trend-zero" x1="60" x2="960" y1={y(0)} y2={y(0)} />
      <text className="putting-trend-label" textAnchor="end" x="52" y={y(0) + 4}>0</text>
      <text className="putting-trend-label" textAnchor="end" x="52" y={y(low) + 4}>{signed(low, 1)}</text>
      <polyline className="putting-trend-line" points={points.map((p, index) => `${x(index)},${y(p.rolling)}`).join(' ')} />
      {points.map((p, index) => (
        <circle key={index} className="putting-trend-dot" cx={x(index)} cy={y(p.rolling)} r="5">
          <title>{`${p.courseName}: ${signed(p.rolling, 1)} strokes a round (three-round average)`}</title>
        </circle>
      ))}
    </svg>
  )
}

export function PuttingPage({ rounds }: { rounds: readonly RoundSummary[] }) {
  const [roundWindow, setRoundWindow] = useState<RoundWindow>('all')
  const [slope, setSlope] = useState<PuttSlope | 'all'>('all')
  const [length, setLength] = useState<string>('all')

  const everything = useMemo(() => buildPuttingProfile(rounds), [rounds])
  const profile = useMemo(() => {
    if (roundWindow === 'all') return everything
    const recent = [...everything.trend].reverse().slice(0, roundWindow === 'last' ? 1 : 5).map((point) => point.roundId)
    return buildPuttingProfile(rounds.filter((round) => recent.includes(round.roundId)))
  }, [everything, roundWindow, rounds])

  const shown = profile.putts.filter((putt) =>
    (slope === 'all' || putt.slope === slope) && (length === 'all' || putt.lengthBucket === length))
  const misses = shown.filter((putt) => !putt.holed && putt.alongFt != null && putt.lateralFt != null)
  const shownPace = summarizePace(shown)
  const shownLine = summarizeLine(shown)
  const holed = shown.filter((putt) => putt.holed).length
  const short = misses.filter((putt) => putt.pace === 'short').length
  const long = misses.filter((putt) => putt.pace === 'long').length
  const sideways = misses.length - short - long
  const lastRound = everything.trend[everything.trend.length - 1] ?? null
  const lastPutts = lastRound ? everything.putts.filter((putt) => putt.roundId === lastRound.roundId) : []
  const hasSlope = profile.putts.some((putt) => putt.slope != null)

  const cupHeadline = misses.length === 0 ? 'No missed putts match.'
    : misses.length < 4 ? `Only ${misses.length} here. Not enough to call a pattern yet.`
      : short >= long && short >= sideways ? `Short is the most common miss here: ${short} of ${misses.length}.`
        : long >= sideways ? `Too firm is the most common miss here: ${long} of ${misses.length}.`
          : `Pace was fine on most of these: ${sideways} of ${misses.length} missed to the side.`

  if (everything.putts.length === 0) {
    return (
      <main className="rounds-main putting">
        <header className="putting-header">
          <a className="putting-back" href="/rounds/game">Your game</a>
          <span className="rounds-eyebrow">Putting</span>
          <h1 className="rounds-display-title">No real putts yet</h1>
          <p className="rounds-muted">
            This page fills in from putts of {MIN_PUTT_FT} ft and longer that you stroke yourself. Gimmes and rounds with
            auto putt on are left out{everything.autoPuttRounds ? ` (${everything.autoPuttRounds} of your rounds used auto putt)` : ''}.
          </p>
        </header>
      </main>
    )
  }

  return (
    <main className="rounds-main putting">
      <header className="putting-header">
        <a className="putting-back" href="/rounds/game">Your game</a>
        <span className="rounds-eyebrow">Putting</span>
        <h1 className="rounds-display-title">
          {profile.sgPer18 == null ? 'Your putting'
            : profile.sgPer18 <= -0.05 ? `Putting costs you ${Math.abs(profile.sgPer18).toFixed(1)} strokes a round`
              : profile.sgPer18 >= 0.05 ? `Putting gains you ${profile.sgPer18.toFixed(1)} strokes a round`
                : 'Your putting is level with the benchmark'}
        </h1>
        <p className="rounds-muted">
          {profile.putts.length} real putts across {profile.rounds} {profile.rounds === 1 ? 'round' : 'rounds'}, against
          the tour benchmark. Gimmes and auto putts are not counted.
        </p>
        <div aria-label="Rounds included" className="putting-pills" role="group">
          {([['last', 'Last round'], ['five', 'Last 5 rounds'], ['all', `All ${everything.rounds} rounds`]] as const).map(([id, label]) => (
            <button key={id} aria-pressed={roundWindow === id} className={roundWindow === id ? 'active' : ''} onClick={() => setRoundWindow(id)} type="button">
              {label}
            </button>
          ))}
        </div>
      </header>

      <section className="rounds-section">
        <div className="rounds-section-head"><h2>Three skills</h2><span className="rounds-muted">Size is your typical miss. Lean is which way it goes.</span></div>
        <div className="putting-skills">
          <article className="putting-skill" data-skill="read">
            <header><b>Read</b><span>Collecting</span></header>
            <p className="putting-skill-question">Did you play the right amount of break?</p>
            <div className="rounds-progress" aria-hidden="true"><div style={{ width: `${Math.min(100, (profile.readPutts / READ_PUTTS_NEEDED) * 100)}%` }} /></div>
            <p className="rounds-muted">
              {profile.readPutts} of {READ_PUTTS_NEEDED} putts. Read needs where you aimed and how the putt rolled,
              which Looper records from now on. Break size and the strokes each skill costs arrive with it.
            </p>
          </article>
          <article className="putting-skill" data-skill="pace">
            <header><b>Pace</b><span>{KIND_LABEL[profile.pace.kind]}</span></header>
            <p className="putting-skill-question">Did you hit it the right distance?</p>
            <dl>
              <div><dt>Typical miss</dt><dd>{paceSize(profile.pace)}</dd></div>
              <div><dt>Lean</dt><dd>{leanText(profile.pace)}</dd></div>
            </dl>
            <p className="putting-skill-advice">{paceAdvice(profile.pace)}</p>
          </article>
          <article className="putting-skill" data-skill="line">
            <header><b>Line</b><span>{KIND_LABEL[profile.line.kind]}</span></header>
            <p className="putting-skill-question">Did it start where you aimed?</p>
            <dl>
              <div><dt>Typical miss</dt><dd>{lineSize(profile.line)}</dd></div>
              <div><dt>Lean</dt><dd>{leanText(profile.line)}</dd></div>
            </dl>
            <p className="putting-skill-advice">{lineAdvice(profile.line)}</p>
          </article>
        </div>
      </section>

      <section className="rounds-section">
        <div className="rounds-section-head"><h2>Trend</h2><span className="rounds-muted">Strokes gained putting per round, three rounds at a time.</span></div>
        {everything.trend.length >= 3
          ? <div className="putting-card"><TrendChart points={everything.trend} /></div>
          : <p className="rounds-muted">A trend needs three rounds of real putting; there {everything.trend.length === 1 ? 'is 1' : `are ${everything.trend.length}`} so far.</p>}
      </section>

      <section className="rounds-section">
        <div className="rounds-section-head"><h2>Where your misses finish</h2></div>
        <div className="putting-filters">
          <label>
            <span>Slope</span>
            <select disabled={!hasSlope} onChange={(event) => setSlope(event.target.value as PuttSlope | 'all')} value={slope}>
              <option value="all">All slopes</option>
              {(['up', 'flat', 'down'] as const).map((id) => (
                <option key={id} value={id}>{SLOPE_LABEL[id]} ({profile.putts.filter((putt) => putt.slope === id).length})</option>
              ))}
            </select>
          </label>
          <label>
            <span>Length</span>
            <select onChange={(event) => setLength(event.target.value)} value={length}>
              <option value="all">All lengths</option>
              {PUTT_LENGTH_BUCKETS.map(([id, label]) => (
                <option key={id} value={id}>{label} ({profile.putts.filter((putt) => putt.lengthBucket === id).length})</option>
              ))}
            </select>
          </label>
          <label>
            <span>Break</span>
            <select disabled value="all"><option value="all">Arrives with Read</option></select>
          </label>
          {(slope !== 'all' || length !== 'all') ? (
            <button className="putting-reset" onClick={() => { setSlope('all'); setLength('all') }} type="button">Show all</button>
          ) : null}
        </div>
        <div className="putting-hero">
          <CupChart misses={misses} />
          <div className="putting-hero-side">
            <h3>{cupHeadline}</h3>
            <p className="rounds-muted">{shown.length} putts · {holed} holed · {misses.length} misses drawn</p>
            <ul className="putting-legend">
              <li><i style={{ background: PACE_COLOR.short }} />Short of the hole<b>{short}</b></li>
              <li><i style={{ background: PACE_COLOR.long }} />More than 3 ft past<b>{long}</b></li>
              <li><i style={{ background: PACE_COLOR.good }} />Good pace, missed to the side<b>{sideways}</b></li>
            </ul>
            <dl className="putting-hero-stats">
              <div><dt>Pace</dt><dd>{paceSize(shownPace)}. Lean: {leanText(shownPace).toLowerCase()}.</dd></div>
              <div><dt>Line</dt><dd>{lineSize(shownLine)}. Lean: {leanText(shownLine).toLowerCase()}.</dd></div>
            </dl>
            <p className="putting-note">
              Each dot is one missed putt, drawn where it stopped. The rings widen for longer putts. Dots will be
              turned to low side and high side, and coloured by cause, once Read has enough putts.
            </p>
          </div>
        </div>
      </section>

      <section className="rounds-section">
        <div className="rounds-section-head"><h2>Uphill and downhill</h2><span className="rounds-muted">Slope changes how hard a putt has to be hit, so this is where pace shows most.</span></div>
        {hasSlope ? (
          <div className="yourgame-scroll">
            <table className="rounds-table">
              <thead>
                <tr><th scope="col" /><th scope="col">Uphill</th><th scope="col">Flat</th><th scope="col">Downhill</th></tr>
              </thead>
              <tbody>
                <tr><th scope="row">Putts</th>{profile.slopes.map((row) => <td key={row.slope}>{row.putts || '–'}</td>)}</tr>
                <tr><th scope="row">Made</th>{profile.slopes.map((row) => <td key={row.slope}>{row.putts ? `${row.made} of ${row.putts}` : '–'}</td>)}</tr>
                <tr><th scope="row">Pace</th>{profile.slopes.map((row) => (
                  <td key={row.slope}>{row.pace.size != null && row.pace.putts >= 4 ? `${Math.round(row.pace.size * 100)}% off · ${leanText(row.pace).toLowerCase()}` : 'Not enough yet'}</td>
                ))}</tr>
                <tr><th scope="row">Line</th>{profile.slopes.map((row) => (
                  <td key={row.slope}>{row.line.size != null && row.line.putts >= 4 ? `${row.line.size.toFixed(1)}° off` : 'Not enough yet'}</td>
                ))}</tr>
                <tr><th scope="row">Three-putts</th>{profile.slopes.map((row) => <td key={row.slope}>{row.putts ? row.threePutts : '–'}</td>)}</tr>
              </tbody>
            </table>
          </div>
        ) : <p className="rounds-muted">Slope needs GSPro’s cup position, which these rounds were saved without. It fills in from new rounds.</p>}
      </section>

      <section className="rounds-section">
        <div className="rounds-section-head"><h2>By length</h2><span className="rounds-muted">Strokes gained per putt against the tour benchmark.</span></div>
        <div className="yourgame-scroll">
          <table className="rounds-table">
            <thead>
              <tr>
                <th scope="col">Length</th>
                <th className="is-num" scope="col">Made</th>
                <th className="is-num" scope="col">SG / putt</th>
                <th className="is-num" scope="col">Average leave</th>
                <th className="is-num" scope="col">Three-putts</th>
              </tr>
            </thead>
            <tbody>
              {profile.lengths.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.label}</strong></td>
                  <td className="is-num">{row.putts ? `${row.made} of ${row.putts}` : '–'}</td>
                  <td className={`is-num ${tone(row.sgPerPutt)}`}>{row.sgPerPutt != null ? signed(row.sgPerPutt) : '–'}</td>
                  <td className="is-num">{row.avgLeaveFt != null ? feet(row.avgLeaveFt) : '–'}</td>
                  <td className="is-num">{row.putts ? row.threePutts : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {lastRound ? (
        <section className="rounds-section">
          <div className="rounds-section-head">
            <h2>Every putt</h2>
            <span className="rounds-muted">Last round with real putting: <a href={`/rounds/${lastRound.roundId}`}>{lastRound.courseName}</a></span>
          </div>
          <div className="yourgame-scroll">
            <table className="rounds-table">
              <thead>
                <tr>
                  <th scope="col">Hole</th>
                  <th className="is-num" scope="col">Length</th>
                  <th scope="col">Slope</th>
                  <th scope="col">Start line</th>
                  <th scope="col">Finished</th>
                  <th className="is-num" scope="col">SG</th>
                </tr>
              </thead>
              <tbody>
                {lastPutts.map((putt) => (
                  <tr key={`${putt.holeNumber}-${putt.number}`}>
                    <td><strong>{putt.holeNumber}</strong></td>
                    <td className="is-num">{Math.round(putt.lengthFt)} ft</td>
                    <td>{putt.slope && putt.riseIn != null ? `${SLOPE_LABEL[putt.slope]}${putt.slope === 'flat' ? '' : `, ${feet(putt.riseIn / 12)}`}` : '–'}</td>
                    <td>{putt.startDirectionDeg == null ? '–'
                      : Math.abs(putt.startDirectionDeg) < 0.25 ? 'On line'
                        : `${Math.abs(putt.startDirectionDeg).toFixed(1)}° ${putt.startDirectionDeg < 0 ? 'left' : 'right'}`}</td>
                    <td>{putt.holed ? 'Holed'
                      : putt.alongFt == null || putt.lateralFt == null ? `${feet(putt.leaveFt)} left`
                        : `${feet(putt.alongFt)} ${putt.alongFt < 0 ? 'short' : 'past'}, ${feet(putt.lateralFt)} ${putt.lateralFt < 0 ? 'left' : 'right'}`}</td>
                    <td className={`is-num ${tone(putt.sg)}`}>{putt.sg != null ? signed(putt.sg) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <p className="putting-note">
        <b>What counts.</b> Only putts of {MIN_PUTT_FT} ft and longer that you stroked yourself: {everything.gimmes} gimmes
        {everything.autoPuttRounds ? ` and ${everything.autoPuttRounds} auto-putt ${everything.autoPuttRounds === 1 ? 'round' : 'rounds'}` : ''} are
        left out. Read is where you placed your aim. Line is whether the ball started there. Right pace means a putt
        that would finish about {IDEAL_PAST_FT} ft past the hole.
      </p>
    </main>
  )
}
