import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  LEADERBOARD_MIN_MOVE_YDS,
  cleanInitials,
  initialsRefused,
  loadInsightReadStats,
  loadTopReads,
  postTopRead,
  readMissYds,
  saveInsightRead,
  type InsightReadStats,
  type InsightTopRead,
} from './insightsReadStore'
import {
  INSIGHT_BASELINE,
  INSIGHT_HOLE,
  describeLeave,
  finishOf,
  type InsightArea,
  type InsightConditions,
  type InsightLie,
  type InsightSwing,
} from './insightsShotModel'

/**
 * Test your read: a shot the page makes up, and the visitor says where it
 * will finish.
 *
 * It reads left to right like the sum it is: the club's normal numbers, then
 * each thing that is known about the shot, then the guess. Checking it fills
 * in what each known was worth, where the ball really finishes, and what the
 * guess would have left: a birdie look, the middle of the green, the sand.
 *
 * The answers come from the models the live caddie runs. Each first check of
 * a shot is saved (no visitor details) so the page can say how people do.
 */

type Club = Readonly<{ name: string; short: string; swing: InsightSwing }>

/** Typical stock numbers for a mid-handicap player. */
const CLUBS: readonly Club[] = [
  { name: 'Pitching wedge', short: 'PW', swing: { ballSpeedMph: 94, launchDeg: 24, spinRpm: 8800 } },
  { name: '9 iron', short: '9i', swing: { ballSpeedMph: 101, launchDeg: 21.5, spinRpm: 8100 } },
  { name: '8 iron', short: '8i', swing: { ballSpeedMph: 108, launchDeg: 19.5, spinRpm: 7300 } },
  { name: '7 iron', short: '7i', swing: { ballSpeedMph: 114, launchDeg: 17.5, spinRpm: 6600 } },
  { name: '6 iron', short: '6i', swing: { ballSpeedMph: 120, launchDeg: 15.5, spinRpm: 5900 } },
  { name: '5 iron', short: '5i', swing: { ballSpeedMph: 125, launchDeg: 14, spinRpm: 5300 } },
]

const GRASS = { soft: 'Bentgrass', medium: 'Bermuda', firm: 'Links' } as const
const LIE_NAMES: Record<InsightLie, string> = { fairway: 'Fairway', rough: 'Rough', 'deep-rough': 'Deep rough', sand: 'Sand' }
const LEVELS = ['soft', 'medium', 'firm'] as const
/** Show how everyone is doing once there are enough reads for it to mean something. */
const STATS_FROM_READS = 20

type Scenario = Readonly<{ club: Club; conditions: InsightConditions; baseYds: number }>

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]
const tenth = (value: number) => Math.round(value * 10) / 10
const between = (low: number, high: number) => low + Math.random() * (high - low)
const eitherWay = (value: number) => (Math.random() < 0.5 ? -value : value)

/** Pick one of several ranges by how often it should come up (shares add to 1). */
const often = <T,>(choices: readonly (readonly [number, () => T])[]): T => {
  let roll = Math.random()
  for (const [share, make] of choices) {
    if (roll < share) return make()
    roll -= share
  }
  return choices[choices.length - 1][1]()
}

/*
 * How often each condition comes up. The aim is shots a GSPro player
 * recognises: mostly breezy, mostly gentle slopes, plenty of rough, deep
 * rough and sand, and elevation from flat to a big elevated green.
 */
const rollWind = () => often([
  [0.2, () => Math.round(between(0, 4.49))],
  [0.7, () => Math.round(between(4.5, 12.49))],
  [0.1, () => Math.round(between(12.5, 17.49))],
])
/**
 * The lie: usually one slope stands out and the other is slight. Side slope
 * leads more often, because it sends the ball offline, about three times as
 * far as an up or down slope of the same degrees changes its distance.
 */
const rollLieSlope = (): { up: number; across: number } => {
  const main = eitherWay(often([[0.35, () => between(0, 2)], [0.4, () => between(2, 4)], [0.2, () => between(4, 6)], [0.05, () => between(6, 7.5)]]))
  const slight = eitherWay(between(0, 1))
  return Math.random() < 0.65 ? { up: tenth(slight), across: tenth(main) } : { up: tenth(main), across: tenth(slight) }
}
/** Height of the green above the ball, in yards, as GSPro players talk about it. */
const rollElevationYds = () => Math.round(eitherWay(often([
  [0.35, () => between(0, 2.5)],
  [0.35, () => between(2.5, 7.5)],
  [0.2, () => between(7.5, 12.5)],
  [0.1, () => between(12.5, 18.5)],
])))
const rollAltitude = () => Math.round(often([
  [0.6, () => between(0, 1000)],
  [0.3, () => between(1000, 3500)],
  [0.1, () => between(3500, 5500)],
]) / 100) * 100
const rollLie = (): InsightLie => often<InsightLie>([
  [0.3, () => 'fairway'], [0.3, () => 'rough'], [0.22, () => 'deep-rough'], [0.18, () => 'sand'],
])
const rollGrass = () => often<(typeof LEVELS)[number]>([[0.35, () => 'soft'], [0.45, () => 'medium'], [0.2, () => 'firm']])
/** Green speed: mostly 10 to 12, sometimes a slow 9 or a tournament 13. */
const rollStimp = () => often([[0.1, () => 9], [0.25, () => 10], [0.3, () => 11], [0.25, () => 12], [0.1, () => 13]])
const rollFirmness = () => often<(typeof LEVELS)[number]>([[0.25, () => 'soft'], [0.5, () => 'medium'], [0.25, () => 'firm']])

/**
 * A shot that ends up further than this from normal is dealt again. Deep rough
 * alone can cost 30 yards, so this only catches the truly silly stack-ups.
 */
const MAX_MOVE_YDS = 60

const makeScenario = (): Scenario => {
  for (let tries = 0; ; tries += 1) {
    const club = pick(CLUBS)
    const slope = rollLieSlope()
    const conditions: InsightConditions = {
      grass: rollGrass(),
      firmness: rollFirmness(),
      lie: rollLie(),
      slopeUpDeg: slope.up,
      slopeRightDeg: slope.across,
      elevationFt: rollElevationYds() * 3,
      altitudeFt: rollAltitude(),
      windMph: rollWind(),
      stimp: rollStimp(),
      windFromDeg: Math.round((Math.random() * 360) / 15) * 15,
    }
    // The pin is wherever this club normally finishes: find the carry first so the ball lands on the green.
    const carryYds = finishOf(INSIGHT_BASELINE, 150, club.swing).carryYds
    const baseYds = Math.round(finishOf(INSIGHT_BASELINE, carryYds + 5, club.swing).totalYds)
    const finish = finishOf(conditions, baseYds, club.swing)
    const moved = Math.hypot(finish.totalYds - baseYds, finish.sideYds)
    // Too far stops looking like golf; too little leaves nothing to read.
    if ((moved > MAX_MOVE_YDS || moved < LEADERBOARD_MIN_MOVE_YDS) && tries < 40) continue
    return { club, conditions, baseYds }
  }
}

/** Up or down on one line, across on the next. */
const slopeText = (upDeg: number, rightDeg: number): ReactNode => {
  const up = Math.abs(upDeg) < 0.05 ? 'Level' : `${Math.abs(upDeg).toFixed(1)}° ${upDeg > 0 ? 'up' : 'down'}`
  const across = Math.abs(rightDeg) < 0.05 ? 'no side slope' : `${Math.abs(rightDeg).toFixed(1)}° ${rightDeg > 0 ? 'right' : 'left'}`
  return <>{up}<br />{across}</>
}

/** The speed on one line, the direction on the next. */
const windWords = (mph: number, fromDeg: number): ReactNode => {
  if (mph === 0) return 'Calm'
  const into = Math.cos((fromDeg * Math.PI) / 180)
  const fromRight = Math.sin((fromDeg * Math.PI) / 180)
  const along = into > 0.38 ? 'into' : into < -0.38 ? 'behind' : ''
  const across = fromRight > 0.38 ? 'from right' : fromRight < -0.38 ? 'from left' : ''
  // "12 mph into" then "from right": two short lines that fit a narrow tile.
  return <em className="insights-quiz__wind-text">{mph} mph{along ? ` ${along}` : ''}{across ? <><br />{across}</> : null}</em>
}

const signed = (value: number) => (Math.round(value) === 0 ? '±0' : `${value > 0 ? '+' : '−'}${Math.abs(Math.round(value))}`)
const sideWords = (value: number) => (Math.abs(value) < 0.5 ? '' : `${Math.round(Math.abs(value))} ${value > 0 ? 'right' : 'left'}`)

/** The hole from above with the pin, the sand, and where a read would leave the ball. */
/**
 * The hole from above as GSPro's minimap shows it: you hit up the page, so long
 * is up and left is left. Drawn from the same shapes that decide the verdict:
 * where the ball sits here is what it got.
 */
function Leave({ longYds, rightYds }: { longYds: number; rightYds: number }) {
  const { frame, green, fairway, bunkers, water, treesRightYds, outOfBoundsLongYds } = INSIGHT_HOLE
  const height = 230
  const k = height / (frame.longYds - frame.shortYds)
  const width = frame.halfWidthYds * 2 * k
  const x = (right: number) => (right + frame.halfWidthYds) * k
  const y = (long: number) => (frame.longYds - long) * k
  const ellipse = (area: InsightArea) => ({ cx: x(area.rightYds), cy: y(area.longYds), rx: area.halfWidthYds * k, ry: area.halfDepthYds * k })
  const ball = { cx: Math.max(6, Math.min(width - 6, x(rightYds))), cy: Math.max(6, Math.min(height - 6, y(longYds))) }
  const trees = Array.from({ length: 13 }, (_, i) => ({ cx: x(treesRightYds) + 6 + (i % 2) * 7, cy: 4 + i * 19, r: 7 + (i % 3) * 1.5 }))
  return (
    <svg aria-hidden="true" className="insights-quiz__hole" viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <clipPath id="insights-hole-frame"><rect height={height} rx="10" width={width} /></clipPath>
      </defs>
      <g clipPath="url(#insights-hole-frame)">
        <rect fill="#1f3a22" height={height} width={width} />
        <rect fill="#2e5a33" height={(fairway.toYds - fairway.fromYds) * k + 14} rx="12" width={(fairway.rightYds - fairway.leftYds) * k} x={x(fairway.leftYds)} y={y(fairway.toYds)} />
        <rect fill="#132016" height={y(outOfBoundsLongYds)} width={width} />
        <line stroke="#f4f1e6" strokeDasharray="2 7" strokeLinecap="round" strokeWidth="3" x1="0" x2={width} y1={y(outOfBoundsLongYds)} y2={y(outOfBoundsLongYds)} />
        <rect fill="#0f2414" height={height} width={width - x(treesRightYds)} x={x(treesRightYds)} />
        {trees.map((tree) => <circle {...tree} fill="#173a1d" key={`${tree.cy}`} stroke="#0b1d0e" />)}
        <ellipse {...ellipse(water)} fill="#1d4f73" stroke="#7fb2d6" strokeOpacity=".5" />
        <ellipse {...ellipse(green)} fill="#3f8a4a" stroke="rgba(242,226,184,.35)" />
        {bunkers.map((bunker) => <ellipse {...ellipse(bunker)} fill="#d6c496" fillOpacity=".8" key={`${bunker.longYds}`} />)}
        <path d={`M${x(0)} ${y(0)} V${y(0) - 20} l11 4 l-11 4`} fill="#eab308" stroke="#fff" strokeWidth="1.4" />
        <circle {...ball} fill="#fff" r="5" stroke="#07100a" strokeWidth="2.2" />
      </g>
    </svg>
  )
}

export default function InsightsReadQuiz() {
  const [scenario, setScenario] = useState<Scenario>(makeScenario)
  const [distance, setDistance] = useState<number>(scenario.baseYds)
  const [side, setSide] = useState(0)
  const [checked, setChecked] = useState(false)
  const [stats, setStats] = useState<InsightReadStats | null>(null)
  const [top, setTop] = useState<InsightTopRead[] | null>(null)
  const [initials, setInitials] = useState('')
  const [posted, setPosted] = useState<'no' | 'posting' | 'yes' | 'failed'>('no')
  const saved = useRef(false)
  /** The read as it was when first checked: what is saved, scored and posted. */
  const firstRead = useRef<{ guessYds: number; guessSideYds: number } | null>(null)

  const { club, conditions, baseYds } = scenario

  useEffect(() => {
    let live = true
    void loadInsightReadStats().then((found) => { if (live) setStats(found) })
    void loadTopReads().then((found) => { if (live) setTop(found) })
    return () => { live = false }
  }, [])

  /** The answer, and what each known was worth on the way to it, in the order they are shown. */
  const answer = useMemo(() => {
    // In the order a player thinks it through over the ball (and the tiles show it):
    // where it sits, the slope, the flight, then what the green does.
    const layers: { key: string; change: Partial<InsightConditions> }[] = [
      { key: 'surface', change: { lie: conditions.lie } },
      { key: 'lie', change: { slopeUpDeg: conditions.slopeUpDeg, slopeRightDeg: conditions.slopeRightDeg } },
      { key: 'wind', change: { windMph: conditions.windMph, windFromDeg: conditions.windFromDeg } },
      { key: 'altitude', change: { altitudeFt: conditions.altitudeFt } },
      { key: 'elevation', change: { elevationFt: conditions.elevationFt } },
      { key: 'green', change: { grass: conditions.grass, firmness: conditions.firmness } },
      { key: 'stimp', change: { stimp: conditions.stimp } },
    ]
    let running: InsightConditions = INSIGHT_BASELINE
    let before = finishOf(running, baseYds, club.swing)
    const worth: Record<string, { yards: number; side: number }> = {}
    for (const layer of layers) {
      running = { ...running, ...layer.change }
      const after = finishOf(running, baseYds, club.swing)
      worth[layer.key] = { yards: after.totalYds - before.totalYds, side: after.sideYds - before.sideYds }
      before = after
    }
    return { finish: before, worth }
  }, [baseYds, club, conditions])

  // Plan on your read and your ball ends up this far from the pin.
  const longMiss = answer.finish.totalYds - distance
  const rightMiss = answer.finish.sideYds - side
  const leave = describeLeave(longMiss, rightMiss)
  /** How far your read was from where it really finished, in a straight line. */
  const missYds = readMissYds({ actualYds: answer.finish.totalYds, actualSideYds: answer.finish.sideYds, guessYds: distance, guessSideYds: side })
  const first = firstRead.current
  const firstMissYds = first
    ? readMissYds({ actualYds: answer.finish.totalYds, actualSideYds: answer.finish.sideYds, guessYds: first.guessYds, guessSideYds: first.guessSideYds })
    : missYds
  const movedYds = Math.hypot(answer.finish.totalYds - baseYds, answer.finish.sideYds)
  const boardFull = (top?.length ?? 0) >= 20
  const makesBoard = movedYds >= LEADERBOARD_MIN_MOVE_YDS && (!boardFull || firstMissYds < (top?.[top.length - 1]?.missYds ?? Infinity))

  const post = () => {
    if (!first || !cleanInitials(initials)) return
    setPosted('posting')
    void postTopRead(initials, {
      club: club.name,
      baseYds,
      actualYds: answer.finish.totalYds,
      actualSideYds: answer.finish.sideYds,
      guessYds: first.guessYds,
      guessSideYds: first.guessSideYds,
      conditions: {},
    }).then((ok) => {
      setPosted(ok ? 'yes' : 'failed')
      if (ok) void loadTopReads().then((found) => { if (found) setTop(found) })
    })
  }

  const check = () => {
    setChecked(true)
    if (saved.current) return
    saved.current = true
    firstRead.current = { guessYds: distance, guessSideYds: side }
    void saveInsightRead({
      club: club.name,
      baseYds,
      actualYds: answer.finish.totalYds,
      actualSideYds: answer.finish.sideYds,
      guessYds: distance,
      guessSideYds: side,
      conditions,
    }).then((ok) => {
      if (ok) void loadInsightReadStats().then((found) => { if (found) setStats(found) })
    })
  }

  const next = () => {
    const fresh = makeScenario()
    saved.current = false
    firstRead.current = null
    setPosted('no')
    setScenario(fresh)
    setDistance(fresh.baseYds)
    setSide(0)
    setChecked(false)
  }

  const knowns: { key: string; name: ReactNode; value: ReactNode }[] = [
    { key: 'surface', name: 'Surface', value: LIE_NAMES[conditions.lie] },
    { key: 'lie', name: 'Lie', value: slopeText(conditions.slopeUpDeg, conditions.slopeRightDeg) },
    {
      key: 'wind',
      // The arrow sits by the label so the words get the tile's full width.
      name: (
        <>
          Wind
          {conditions.windMph > 0 ? (
            <svg aria-hidden="true" className="insights-quiz__wind" viewBox="-12 -12 24 24">
              {/* Up the page is toward the target; the arrow shows where the wind is blowing to. */}
              <g transform={`rotate(${conditions.windFromDeg + 180})`}>
                <path d="M0 9 L0 -8 M-5 -3 L0 -9 L5 -3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" />
              </g>
            </svg>
          ) : null}
        </>
      ),
      value: windWords(conditions.windMph, conditions.windFromDeg),
    },
    { key: 'altitude', name: 'Altitude', value: conditions.altitudeFt === 0 ? 'Sea level' : `${conditions.altitudeFt.toLocaleString('en-US')} ft` },
    { key: 'elevation', name: 'Elevation', value: conditions.elevationFt === 0 ? 'Level' : `${Math.round(Math.abs(conditions.elevationFt) / 3)} yd ${conditions.elevationFt > 0 ? 'up' : 'down'}` },
    { key: 'green', name: 'Green', value: `${GRASS[conditions.grass]}, ${conditions.firmness}` },
    { key: 'stimp', name: 'Stimp', value: `${conditions.stimp}` },
  ]


  return (
    <section className="insights-quiz" aria-labelledby="insights-quiz-title">
      <div className="insights-wrap">
        <div className="insights-quiz__card">
          <div className="insights-quiz__title">
            <p className="insights-eyebrow">Test your read</p>
            <h2 id="insights-quiz-title">Where does this one finish?</h2>
          </div>

          <div className="insights-quiz__sum">
            <div className="insights-quiz__base">
              <span>Your normal</span>
              <strong>{club.short} · {baseYds}</strong>
              <em className="insights-quiz__base-total">yards total, with roll</em>
              <small>{club.swing.spinRpm.toLocaleString('en-US')} rpm</small>
            </div>
            <ol className="insights-quiz__knowns">
              {knowns.map((known) => {
                const worth = answer.worth[known.key]
                return (
                  <li key={known.key}>
                    <span>{known.name}</span>
                    <strong>{known.value}</strong>
                    {/* Always two lines, distance then line, so every tile's rule sits at the same height. */}
                    <b className={checked ? 'is-shown' : ''}>
                      {checked
                        ? `${signed(worth.yards)} yd`
                        : '?'}
                      <br />
                      {(checked && sideWords(worth.side)) || '\u00a0'}
                    </b>
                  </li>
                )
              })}
            </ol>
            <form
              className="insights-quiz__guess"
              onSubmit={(event) => {
                event.preventDefault()
                check()
              }}
            >
              <span className="insights-quiz__guess-title">Your read</span>
              <label htmlFor="insights-quiz-distance">
                <span>It goes</span>
                <span className="insights-quiz__typed">
                  <input
                    aria-label="Yards it goes"
                    inputMode="decimal"
                    max={baseYds + 45}
                    min={baseYds - 70}
                    onChange={(event) => { const v = Number(event.target.value); if (Number.isFinite(v)) { setDistance(Math.round(v * 10) / 10); setChecked(false) } }}
                    step={0.1}
                    type="number"
                    value={distance}
                  />
                  yd
                </span>
              </label>
              <input
                id="insights-quiz-distance"
                max={baseYds + 45}
                min={baseYds - 70}
                onChange={(event) => { setDistance(Number(event.target.value)); setChecked(false) }}
                step={0.1}
                type="range"
                value={distance}
              />
              <label htmlFor="insights-quiz-side">
                <span>It finishes</span>
                <span className="insights-quiz__typed">
                  <input
                    aria-label="Yards left (negative) or right (positive)"
                    inputMode="decimal"
                    max={25}
                    min={-25}
                    onChange={(event) => { const v = Number(event.target.value); if (Number.isFinite(v)) { setSide(Math.round(v * 10) / 10); setChecked(false) } }}
                    step={0.1}
                    type="number"
                    value={side}
                  />
                  {side === 0 ? 'on line' : side > 0 ? 'yd right' : 'yd left'}
                </span>
              </label>
              <input
                id="insights-quiz-side"
                max={25}
                min={-25}
                onChange={(event) => { setSide(Number(event.target.value)); setChecked(false) }}
                step={0.1}
                type="range"
                value={side}
              />
              <small className="insights-quiz__sign">Right is plus, left is minus.</small>
              <button className="insights-button" type="submit">Check my read</button>
            </form>
          </div>

          {checked ? (
            <>
              <div className="insights-quiz__result" role="status">
                <Leave longYds={longMiss} rightYds={rightMiss} />
                <div>
                  <p className="insights-quiz__verdict">
                    {missYds < 0.05 ? 'Spot on.' : <>Your read was {missYds.toFixed(1)} yards off.</>}
                  </p>
                  <p className="insights-quiz__compare">
                    The ball went <strong>{answer.finish.totalYds.toFixed(1)}</strong>
                    {Math.abs(answer.finish.sideYds) < 0.05 ? ' on line' : <>, <strong>{Math.abs(answer.finish.sideYds).toFixed(1)} {answer.finish.sideYds > 0 ? 'right' : 'left'}</strong></>}.
                    {' '}You said <strong>{distance.toFixed(1)}</strong>{side === 0 ? ' on line' : <>, <strong>{Math.abs(side).toFixed(1)} {side > 0 ? 'right' : 'left'}</strong></>}.
                  </p>
                  <p className="insights-quiz__leave">
                    Played to your read: <strong>{leave.headline}</strong> {leave.detail}
                  </p>
                  {stats && stats.reads >= STATS_FROM_READS ? (
                    <p className="insights-quiz__stats">
                      Across {stats.reads.toLocaleString('en-US')} reads so far, people are off by {stats.missYds.toFixed(0)} yards on
                      average ({stats.missPct.toFixed(0)}% of the shot) and {stats.sideMissYds.toFixed(0)} yards in line.
                    </p>
                  ) : null}
                  <button className="insights-button insights-quiz__play" onClick={next} type="button">Play again</button>
                </div>
                <aside className="insights-quiz__looper">
                  <p className="insights-eyebrow">The Looper does this every shot</p>
                  <p>
                    That sum was seven numbers. Looper does it before every shot you hit in GSPro, and then keeps going:
                    it adds <strong>your own shot shape and how your mishits fly</strong>, then plays the odds against
                    <strong> this hole&rsquo;s hazards</strong> to pick the club and the line that save you the most strokes.
                  </p>
                </aside>
              </div>

            </>
          ) : (
            <p className="insights-quiz__hint">
              Seven things you know about the shot. Add them up, then check.{' '}
              <button className="insights-quiz__again" onClick={next} type="button">Give me a different shot</button>
            </p>
          )}

          <div className="insights-quiz__board">
            <div className="insights-quiz__board-head">
              <p className="insights-eyebrow">Closest reads</p>
              <span>Scored by the straight line from your read to where the ball finished. First read of each shot only.</span>
            </div>
            {checked && first && makesBoard && posted !== 'yes' ? (
              <form
                className="insights-quiz__post"
                onSubmit={(event) => {
                  event.preventDefault()
                  post()
                }}
              >
                <label htmlFor="insights-quiz-initials">
                  {firstMissYds.toFixed(1)} yards makes the board. Your initials:
                </label>
                <input
                  autoComplete="off"
                  id="insights-quiz-initials"
                  maxLength={3}
                  onChange={(event) => setInitials(event.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
                  placeholder="ABC"
                  value={initials}
                />
                <button className="insights-button" disabled={!cleanInitials(initials) || posted === 'posting'} type="submit">
                  {posted === 'posting' ? 'Posting…' : 'Post it'}
                </button>
                {initialsRefused(initials) ? <span className="insights-quiz__post-error">Nice try. Pick different initials.</span> : null}
                {posted === 'failed' ? <span className="insights-quiz__post-error">That didn&rsquo;t go through. Try different initials.</span> : null}
              </form>
            ) : null}
            {checked && first && !makesBoard && movedYds < LEADERBOARD_MIN_MOVE_YDS ? (
              <p className="insights-quiz__board-note">This shot played close to normal, so it doesn&rsquo;t count for the board. Play again.</p>
            ) : null}
            {top && top.length ? (
              <ol className="insights-quiz__top">
                {top.map((row, index) => (
                  <li key={`${row.initials}-${index}`}>
                    <span>{index + 1}</span>
                    <strong>{row.initials}</strong>
                    <em>{row.club}</em>
                    <b>{row.missYds.toFixed(1)} yd</b>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="insights-quiz__board-note">No reads on the board yet. Be the first.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
