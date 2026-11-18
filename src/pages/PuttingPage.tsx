import { useMemo, useState } from 'react'
import type { RoundSummary } from '../lib/roundHistory'
import {
  buildPuttingProfile,
  IDEAL_PAST_FT,
  leaveSummary,
  MIN_PUTT_FT,
  PUTT_LENGTH_BUCKETS,
  PUTT_SKILLS,
  READ_PUTTS_NEEDED,
  summarizeLine,
  summarizePace,
  summarizeRead,
  type ProfilePutt,
  type PuttSkill,
  type PuttSlope,
  type SkillSummary,
  LINE_ON_AIM_DEG,
  profilePutts,
} from '../lib/puttingProfile'
import { describeRoundWindow, EARLY_READ_ROUNDS, roundsInWindow, type RoundWindow } from '../lib/roundWindow'
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

/** "1 of 8" with the percentage beside it, quieter. */
const Made = ({ made, putts }: { made: number; putts: number }) => (putts
  ? <>{made} of {putts} <small className="putting-pct">{Math.round((made / putts) * 100)}%</small></>
  : <>–</>)

const SLOPE_LABEL: Record<PuttSlope, string> = { up: 'Uphill', flat: 'Flat', down: 'Downhill' }
const SKILL_LABEL: Record<PuttSkill, string> = { read: 'Read', pace: 'Pace', line: 'Line' }
const SKILL_COLOR: Record<PuttSkill, string> = {
  read: 'var(--putting-read)', pace: 'var(--putting-pace)', line: 'var(--putting-line)',
}

const leanShort = (skill: SkillSummary) => {
  // Out of every putt on the strip, so the count matches the bars you can see.
  if (skill.lean) return `${skill.lean.side} ${skill.lean.count} of ${skill.putts}`
  if (skill.split && skill.split.aCount + skill.split.bCount >= 4) return 'no lean'
  return 'too few to say'
}

const sizeText = (id: PuttSkill, skill: SkillSummary) =>
  skill.size == null ? 'Not enough yet'
    : id === 'read' ? `${feet(skill.size)} off at the hole`
      : id === 'pace' ? `${feet(skill.sizeFt ?? 0)} from the ideal finish`
        : `${skill.size.toFixed(1)}° off your aim`

/** The smallest round number from `steps` that holds every value. */
const stripRange = (values: readonly number[], steps: readonly number[]) => {
  const furthest = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  return steps.find((range) => range >= furthest) ?? steps[steps.length - 1]
}
const FEET_STEPS = [1, 2, 3, 6, 9, 15, 30] as const
const DEGREE_STEPS = [3, 6, 10] as const

/**
 * One skill along one axis of the cup chart: a centre mark, a shaded zone that
 * counts as good, and a tick for every putt. Pace runs up and down like the
 * chart (past at the top); Read and Line run left to right, because both move
 * the ball sideways. A tight bunch off to one side is a habit; ticks spread
 * both ways is scatter.
 */
function SkillStrip({ values, zone, color, low, high, centre, label, steps, format, vertical = false }: {
  values: readonly number[]
  zone: readonly [number, number]
  color: string
  /** Name of the negative end (left, or the bottom when vertical) and the positive end. */
  low: string
  high: string
  centre: string
  label: string
  steps: readonly number[]
  format: (value: number) => string
  vertical?: boolean
}) {
  const range = stripRange(values, steps)
  const at = (value: number) => Math.max(-1, Math.min(1, value / range))
  if (vertical) {
    // Tall and narrow: it stands beside the number, the full height of its column.
    const y = (value: number) => 100 - at(value) * 84
    return (
      <svg aria-label={label} className="putting-mini putting-mini-vertical" role="img" viewBox="0 0 120 200">
        <rect className="putting-mini-zone" height={Math.max(4, y(zone[0]) - y(zone[1]))} rx="3" width="44" x="18" y={y(zone[1])} />
        <line className="putting-mini-axis" x1="40" x2="40" y1="12" y2="188" />
        {values.map((value, index) => (
          <line key={index} className="putting-mini-tick" style={{ stroke: color }} x1="22" x2="58" y1={y(value)} y2={y(value)} />
        ))}
        <circle className="putting-mini-hole" cx="40" cy="100" r="4.5" />
        <text className="putting-mini-label" x="70" y="18">{high}</text>
        <text className="putting-mini-scale" x="70" y="31">{format(range)}</text>
        <text className="putting-mini-label" x="70" y="104">{centre}</text>
        <text className="putting-mini-scale" x="70" y="177">{format(range)}</text>
        <text className="putting-mini-label" x="70" y="190">{low}</text>
      </svg>
    )
  }
  const x = (value: number) => 150 + at(value) * 132
  return (
    <svg aria-label={label} className="putting-mini" role="img" viewBox="0 0 300 92">
      <rect className="putting-mini-zone" height="44" rx="3" width={Math.max(4, x(zone[1]) - x(zone[0]))} x={x(zone[0])} y="18" />
      <line className="putting-mini-axis" x1="18" x2="282" y1="40" y2="40" />
      {values.map((value, index) => (
        <line key={index} className="putting-mini-tick" style={{ stroke: color }} x1={x(value)} x2={x(value)} y1="22" y2="58" />
      ))}
      <circle className="putting-mini-hole" cx="150" cy="40" r="4.5" />
      <text className="putting-mini-label" x="18" y="80">{low}</text>
      <text className="putting-mini-label" textAnchor="middle" x="150" y="80">{centre}</text>
      <text className="putting-mini-label" textAnchor="end" x="282" y="80">{high}</text>
      <text className="putting-mini-scale" x="18" y="10">{format(range)}</text>
      <text className="putting-mini-scale" textAnchor="end" x="282" y="10">{format(range)}</text>
    </svg>
  )
}


const GOOD_ENOUGH_MEANS: Record<PuttSkill, string> = {
  read: 'Your aim was on a line that goes in.',
  line: 'The ball started close enough to your aim.',
  pace: 'It reached the hole without racing past.',
}

/** Half the hole, feet: the zone a read has to land in. */
const CUP_HALF_FT = 2.125 / 12

/** Rows in the putt list before "Show more". */
const PUTTS_PER_PAGE = 20


/** Three rings that cover the furthest miss shown. */
const ringStepFt = (misses: readonly ProfilePutt[]) => {
  const furthest = misses.reduce((max, putt) => Math.max(max, Math.abs(putt.alongFt ?? 0), Math.abs(putt.lateralFt ?? 0)), 0)
  return [0.5, 1, 2, 3, 5, 10].find((step) => step * 3 >= furthest) ?? 15
}

function CupChart({ misses, holed }: { misses: readonly ProfilePutt[]; holed: number | null }) {
  const step = ringStepFt(misses)
  const scale = 70 / step
  // Dots shrink and go translucent as they multiply, so 20 read as marks and 300 read as a cloud.
  const count = misses.length
  const dot = count <= 20 ? { r: 6.5, stroke: 1.5, opacity: 0.95 }
    : count <= 60 ? { r: 5, stroke: 1.25, opacity: 0.85 }
      : count <= 150 ? { r: 4, stroke: 1, opacity: 0.72 }
        : { r: 3, stroke: 0.75, opacity: 0.6 }
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
        <circle className="putting-cup-hole" cx="280" cy="280" r="24" />
        {holed != null ? <text className="putting-cup-holed" textAnchor="middle" x="280" y="287">{holed}</text> : null}
        {misses.map((putt) => (
          <circle
            key={`${putt.roundId}-${putt.holeNumber}-${putt.number}`}
            className="putting-cup-dot"
            cx={280 + Math.max(-258, Math.min(258, (putt.lateralFt ?? 0) * scale))}
            cy={280 - Math.max(-258, Math.min(258, (putt.alongFt ?? 0) * scale))}
            r={dot.r}
            style={{ fill: putt.cause ? SKILL_COLOR[putt.cause] : 'var(--putting-unsplit)', fillOpacity: dot.opacity, strokeWidth: dot.stroke }}
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

/** Rounds with real putting, so "Last 5" is the last five rounds this page can say something about. */
const hasPutts = (round: RoundSummary) => profilePutts(round).length > 0

export function PuttingPage({ rounds, roundWindow, onRoundWindow }: {
  rounds: readonly RoundSummary[]
  /** Chosen in the top ribbon, shared with Your game. */
  roundWindow: RoundWindow
  onRoundWindow: (next: RoundWindow) => void
}) {
  const now = useMemo(() => new Date(), [])
  const [slope, setSlope] = useState<PuttSlope | 'all'>('all')
  const [length, setLength] = useState<string>('all')
  // Tapping Read, Line or Pace shows only the misses that skill caused.
  const [cause, setCause] = useState<PuttSkill | 'all'>('all')
  const [listLimit, setListLimit] = useState(PUTTS_PER_PAGE)
  // The putt-by-putt list is detail: closed until asked for.
  const [listOpen, setListOpen] = useState(false)

  const everything = useMemo(() => buildPuttingProfile(rounds), [rounds])
  const profile = useMemo(() => {
    if (roundWindow === 'all') return everything
    return buildPuttingProfile(roundsInWindow(rounds, roundWindow, now, hasPutts))
  }, [everything, roundWindow, rounds, now])
  const thinWindow = roundWindow === 'recent' && profile.rounds < EARLY_READ_ROUNDS && everything.rounds > profile.rounds

  const shown = profile.putts.filter((putt) =>
    (slope === 'all' || putt.slope === slope) && (length === 'all' || putt.lengthBucket === length))
  const allMisses = shown.filter((putt) => !putt.holed && putt.alongFt != null && putt.lateralFt != null)
  const misses = cause === 'all' ? allMisses : allMisses.filter((putt) => putt.cause === cause)
  const holed = shown.filter((putt) => putt.holed).length
  const leftGimme = shown.filter((putt) => putt.leftGimme).length
  const missed = shown.length - holed - leftGimme
  const share = (count: number) => `${shown.length ? (count / shown.length) * 100 : 0}%`
  const byCause = PUTT_SKILLS.map((id) => ({ id, count: allMisses.filter((putt) => putt.cause === id).length }))
  const unsplit = allMisses.filter((putt) => putt.cause == null).length
  const topCause = [...byCause].sort((a, b) => b.count - a.count)[0]
  const leaves = leaveSummary(shown)
  // How often each part, on its own, was good enough for the putt to drop.
  const judged = shown.filter((putt) => !putt.holed && putt.readLateralFt != null && putt.startDirectionDeg != null && putt.alongFt != null)
  const judgedTotal = holed + judged.length
  const goodEnough: Record<PuttSkill, number> = {
    read: holed + judged.filter((putt) => Math.abs(putt.readLateralFt as number) <= CUP_HALF_FT).length,
    line: holed + judged.filter((putt) => Math.abs(putt.lengthFt * Math.tan(((putt.startDirectionDeg as number) * Math.PI) / 180)) <= CUP_HALF_FT).length,
    pace: holed + judged.filter((putt) => (putt.alongFt as number) >= 0 && (putt.alongFt as number) <= 4).length,
  }
  const shownSkills: Record<PuttSkill, SkillSummary> = {
    read: summarizeRead(shown), pace: summarizePace(shown), line: summarizeLine(shown),
  }
  const skills: Record<PuttSkill, SkillSummary> = { read: profile.read, pace: profile.pace, line: profile.line }
  // Shown to one decimal: the last skill takes up the rounding so the three always add up to the total exactly.
  const round1 = (value: number) => Math.round(value * 10) / 10
  const shownStrokes: Record<PuttSkill, number> | null = profile.skillStrokes && profile.sgPer18 != null
    ? (() => {
        const read = round1(profile.skillStrokes.read)
        const line = round1(profile.skillStrokes.line)
        return { read, line, pace: round1(round1(profile.sgPer18) - read - line) }
      })()
    : null
  // The list follows the filters above, newest round first.
  const listed = [...shown]
    .filter((putt) => cause === 'all' || putt.cause === cause)
    .sort((a, b) => (b.playedAt ?? '').localeCompare(a.playedAt ?? '') || a.holeNumber - b.holeNumber || a.number - b.number)
  const hasSlope = profile.putts.some((putt) => putt.slope != null)

  const cupHeadline = cause !== 'all'
    ? (misses.length === 0 ? `No misses here had ${SKILL_LABEL[cause].toLowerCase()} as the main cause.`
      : `${misses.length} of ${allMisses.length} misses here were mainly ${SKILL_LABEL[cause].toLowerCase()}.`)
    : allMisses.length === 0 ? 'No missed putts match.'
      : allMisses.length < 4 ? `Only ${allMisses.length} misses here. Not enough to call a pattern yet.`
        : topCause.count === 0 ? 'These misses could not be split by cause.'
          : `${SKILL_LABEL[topCause.id]} is the main cause here: ${topCause.count} of ${allMisses.length} misses.`
  const toggleCause = (id: PuttSkill) => setCause((current) => (current === id ? 'all' : id))

  if (everything.putts.length === 0) {
    return (
      <main className="rounds-main putting">
        <header className="putting-header">
          <a className="putting-back" href="/game">Your game</a>
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

  if (profile.putts.length === 0) {
    // Real putting exists, just not in the rounds picked in the ribbon.
    return (
      <main className="rounds-main putting">
        <header className="putting-header">
          <a className="putting-back" href="/game">Your game</a>
          <span className="rounds-eyebrow">Putting</span>
          <h1 className="rounds-display-title">No real putts in these rounds</h1>
          <p className="rounds-muted">
            Nothing to show from {describeRoundWindow(roundWindow, profile.rounds)}. Your real putting is in older
            rounds. <button className="round-window-all" onClick={() => onRoundWindow('all')} type="button">See all</button>
          </p>
        </header>
      </main>
    )
  }

  return (
    <main className="rounds-main putting">
      <header className="putting-header">
        <a className="putting-back" href="/game">Your game</a>
        <div className="putting-title-row">
          <div className="putting-title">
            <h1 className="rounds-display-title">Putting</h1>
            <details className="putting-info">
              <summary aria-label="How this page works"><span aria-hidden="true">i</span></summary>
              <div>
                <p><b>What counts.</b> Putts of {MIN_PUTT_FT} ft and longer that you stroked yourself. Gimmes and auto-putt rounds are left out.</p>
                <p><b>Read</b> is where you placed your aim. <b>Line</b> is whether the ball started there. <b>Pace</b> is distance: right pace would finish about {IDEAL_PAST_FT} ft past the hole. Read is judged at that pace: a putt hit too hard breaks less and one left short breaks more, and that part of the miss counts as Pace.</p>
                <p><b>The split.</b> Each miss is replayed with the read, the pace or the start line put right, and each skill is credited with what that would have saved. The three add up to your strokes gained putting against the tour benchmark.</p>
                <p><b>Early days.</b> Read is worked out from where the ball finished until {READ_PUTTS_NEEDED} putts carry your aim and roll ({everything.readPutts} so far). Break size arrives with it.</p>
              </div>
            </details>
          </div>
        </div>
        <p className="rounds-muted">
          {profile.putts.length} real putts across {describeRoundWindow(roundWindow, profile.rounds)}, against
          the tour benchmark. Gimmes and auto putts are not counted.
          {thinWindow ? (
            <> An early read: {everything.rounds} rounds in all. <button className="round-window-all" onClick={() => onRoundWindow('all')} type="button">See all</button></>
          ) : null}
        </p>
      </header>

      <section className="putting-equation" aria-label="Strokes gained putting, and how it splits by skill">
        <div className="putting-total">
          <strong className={tone(profile.sgPer18)}>{profile.sgPer18 != null ? signed(profile.sgPer18, 1) : '–'}</strong>
          <span>strokes a round, putting</span>
        </div>
        {PUTT_SKILLS.map((id) => (
          <div key={id} className={`putting-term${cause === id ? ' active' : ''}`} data-skill={id}>
            <button aria-pressed={cause === id} onClick={() => toggleCause(id)} title={`Show only the misses ${SKILL_LABEL[id].toLowerCase()} caused`} type="button">
              <b>{SKILL_LABEL[id]}</b>
              <strong>
                {shownStrokes ? signed(shownStrokes[id], 1)
                  : profile.skillShare ? `${Math.round(profile.skillShare[id] * 100)}%`
                    : '–'}
              </strong>
              {id === 'read' ? (
                <SkillStrip
                  centre="hole"
                  color={SKILL_COLOR.read}
                  format={feet}
                  high="right"
                  label="Where your aim alone would have left each putt, left or right of the hole"
                  low="left"
                  steps={FEET_STEPS}
                  values={profile.putts.flatMap((putt) => (!putt.holed && putt.readLateralFt != null ? [putt.readLateralFt] : []))}
                  zone={[-CUP_HALF_FT, CUP_HALF_FT]}
                />
              ) : id === 'pace' ? (
                <SkillStrip
                  centre="hole"
                  color={SKILL_COLOR.pace}
                  format={feet}
                  high="past"
                  label="Where each missed putt stopped, short of the hole or past it"
                  low="short"
                  steps={FEET_STEPS}
                  values={profile.putts.flatMap((putt) => (!putt.holed && putt.alongFt != null ? [putt.alongFt] : []))}
                  vertical
                  zone={[0, 2]}
                />
              ) : (
                <SkillStrip
                  centre="aim"
                  color={SKILL_COLOR.line}
                  format={(value) => `${value}°`}
                  high="right"
                  label="Start direction of each putt, left or right of your aim"
                  low="left"
                  steps={DEGREE_STEPS}
                  values={profile.putts.flatMap((putt) => (putt.startDirectionDeg != null ? [putt.startDirectionDeg] : []))}
                  zone={[-LINE_ON_AIM_DEG, LINE_ON_AIM_DEG]}
                />
              )}
              <span>{sizeText(id, skills[id])} · {leanShort(skills[id])}</span>
            </button>
          </div>
        ))}
      </section>
      <section className="rounds-section putting-hero-section">
        <div className="putting-hero">
          <CupChart holed={cause === 'all' ? holed : null} misses={misses} />
          <div className="putting-hero-side">
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
              <label>
                <span>Main cause</span>
                <select onChange={(event) => setCause(event.target.value as PuttSkill | 'all')} value={cause}>
                  <option value="all">All causes</option>
                  {byCause.map(({ id, count }) => <option key={id} value={id}>{SKILL_LABEL[id]} ({count})</option>)}
                </select>
              </label>
              {(slope !== 'all' || length !== 'all' || cause !== 'all') ? (
                <button className="putting-reset" onClick={() => { setSlope('all'); setLength('all'); setCause('all') }} type="button">Clear filters</button>
              ) : null}
            </div>
            {cause === 'all' ? (
              <>
            <div className="putting-makemiss">
              <div><strong className="is-gain">{holed}</strong><span>holed</span></div>
              <div><strong className="putting-gimme">{leftGimme}</strong><span>left a gimme</span></div>
              <div><strong>{missed}</strong><span>missed</span></div>
            </div>
            <div aria-hidden="true" className="putting-makemiss-bar">
              <div className="holed" style={{ width: share(holed) }} />
              <div className="gimme" style={{ width: share(leftGimme) }} />
            </div>
              </>
            ) : null}
            <h3>{cupHeadline}</h3>
            <ul className="putting-legend">
              {byCause.map(({ id, count }) => (
                <li key={id} className={cause !== 'all' && cause !== id ? 'dim' : ''}>
                  <i style={{ background: SKILL_COLOR[id] }} />
                  <span><b>{SKILL_LABEL[id]}</b> {sizeText(id, shownSkills[id]).toLowerCase()} · {leanShort(shownSkills[id])}</span>
                  <b>{count}</b>
                </li>
              ))}
              {unsplit ? <li><i style={{ background: 'var(--putting-unsplit)' }} /><span>No start direction recorded</span><b>{unsplit}</b></li> : null}
            </ul>
            {cause === 'all' && judgedTotal >= 4 ? (
              <div className="putting-good">
                <h4>Good enough to go in?</h4>
                <p className="rounds-muted">
                  A putt needs all three to drop. Taken one at a time, this is how often each was good enough to go in
                  if the other two had been perfect.
                </p>
                {PUTT_SKILLS.map((id) => (
                  <div key={id} className="putting-good-row" data-skill={id}>
                    <b>{SKILL_LABEL[id]}</b>
                    <div aria-hidden="true"><i style={{ width: `${(goodEnough[id] / judgedTotal) * 100}%`, background: SKILL_COLOR[id] }} /></div>
                    <span>{goodEnough[id]} of {judgedTotal}</span>
                    <small>{GOOD_ENOUGH_MEANS[id]}</small>
                  </div>
                ))}
              </div>
            ) : null}
            {leaves.firsts ? (
              <p className="putting-leaves">
                First putts left inside 3 ft: <b>{leaves.inside3} of {leaves.firsts}</b>. Inside the 5 ft gimme
                circle: <b>{leaves.inside5} of {leaves.firsts}</b>.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="rounds-section">
        <div className="rounds-section-head"><h2>Trend</h2><span className="rounds-muted">Strokes gained putting per round, three rounds at a time.</span></div>
        {everything.trend.length >= 3
          ? <div className="putting-card"><TrendChart points={everything.trend} /></div>
          : <p className="rounds-muted">A trend needs three rounds of real putting; there {everything.trend.length === 1 ? 'is 1' : `are ${everything.trend.length}`} so far.</p>}
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
                <tr><th scope="row">Made</th>{profile.slopes.map((row) => <td key={row.slope}><Made made={row.made} putts={row.putts} /></td>)}</tr>
                <tr><th data-skill="read" scope="row">Read</th>{profile.slopes.map((row) => (
                  <td key={row.slope}>{row.read.sizeFt != null && row.read.putts >= 4 ? `${feet(row.read.sizeFt)} off · ${leanShort(row.read)}` : 'Not enough yet'}</td>
                ))}</tr>
                <tr><th data-skill="line" scope="row">Line</th>{profile.slopes.map((row) => (
                  <td key={row.slope}>{row.line.size != null && row.line.putts >= 4 ? `${row.line.size.toFixed(1)}° off · ${leanShort(row.line)}` : 'Not enough yet'}</td>
                ))}</tr>
                <tr><th data-skill="pace" scope="row">Pace</th>{profile.slopes.map((row) => (
                  <td key={row.slope}>{row.pace.size != null && row.pace.putts >= 4 ? `${feet(row.pace.sizeFt ?? 0)} off · ${leanShort(row.pace)}` : 'Not enough yet'}</td>
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
                  <td className="is-num"><Made made={row.made} putts={row.putts} /></td>
                  <td className={`is-num ${tone(row.sgPerPutt)}`}>{row.sgPerPutt != null ? signed(row.sgPerPutt) : '–'}</td>
                  <td className="is-num">{row.avgLeaveFt != null ? feet(row.avgLeaveFt) : '–'}</td>
                  <td className="is-num">{row.putts ? row.threePutts : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {listed.length ? (
        <section className="rounds-section">
          <div className="rounds-section-head putting-list-head">
            <h2>Every putt</h2>
            <button aria-expanded={listOpen} className="putting-more" onClick={() => setListOpen((open) => !open)} type="button">
              {listOpen ? 'Hide' : `Show ${listed.length} ${listed.length === 1 ? 'putt' : 'putts'}`}
            </button>
          </div>
          {listOpen ? (
          <div className="yourgame-scroll">
            <table className="rounds-table">
              <thead>
                <tr>
                  <th scope="col">Round</th>
                  <th scope="col">Hole</th>
                  <th className="is-num" scope="col">Length</th>
                  <th scope="col">Slope</th>
                  <th scope="col">Start line</th>
                  <th scope="col">Finished</th>
                  <th scope="col">Main cause</th>
                  <th className="is-num" scope="col">SG</th>
                </tr>
              </thead>
              <tbody>
                {listed.slice(0, listLimit).map((putt) => (
                  <tr key={`${putt.roundId}-${putt.holeNumber}-${putt.number}`}>
                    <td><a className="putting-quiet-link" href={`/rounds/${putt.roundId}`}>{putt.courseName}</a></td>
                    <td><strong>{putt.holeNumber}</strong></td>
                    <td className="is-num">{Math.round(putt.lengthFt)} ft</td>
                    <td>{putt.slope && putt.riseIn != null ? `${SLOPE_LABEL[putt.slope]}${putt.slope === 'flat' ? '' : `, ${feet(putt.riseIn / 12)}`}` : '–'}</td>
                    <td>{putt.startDirectionDeg == null ? '–'
                      : Math.abs(putt.startDirectionDeg) <= LINE_ON_AIM_DEG ? 'On line'
                        : `${Math.abs(putt.startDirectionDeg).toFixed(1)}° ${putt.startDirectionDeg < 0 ? 'left' : 'right'}`}</td>
                    <td>{putt.holed ? 'Holed'
                      : putt.alongFt == null || putt.lateralFt == null ? `${feet(putt.leaveFt)} left`
                        : `${feet(putt.alongFt)} ${putt.alongFt < 0 ? 'short' : 'past'}, ${feet(putt.lateralFt)} ${putt.lateralFt < 0 ? 'left' : 'right'}`}</td>
                    <td style={putt.cause ? { color: SKILL_COLOR[putt.cause] } : undefined}>{putt.holed ? 'Holed' : putt.cause ? SKILL_LABEL[putt.cause] : '–'}</td>
                    <td className={`is-num ${tone(putt.sg)}`}>{putt.sg != null ? signed(putt.sg) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          ) : null}
          {listOpen && listed.length > listLimit ? (
            <button className="putting-more" onClick={() => setListLimit((limit) => limit + PUTTS_PER_PAGE)} type="button">
              Show {Math.min(PUTTS_PER_PAGE, listed.length - listLimit)} more ({listed.length - listLimit} left)
            </button>
          ) : null}
        </section>
      ) : null}

    </main>
  )
}
