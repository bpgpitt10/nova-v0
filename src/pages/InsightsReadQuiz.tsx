import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { loadInsightReadStats, saveInsightRead, type InsightReadStats } from './insightsReadStore'
import {
  INSIGHT_BASELINE,
  INSIGHT_HOLE,
  describeLeave,
  finishOf,
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
/** Every shot is on stimp 11: Looper's green model does not change with stimp yet. */
const STIMP = 11
/** Show how everyone is doing once there are enough reads for it to mean something. */
const STATS_FROM_READS = 20

type Scenario = Readonly<{ club: Club; conditions: InsightConditions; baseYds: number }>

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]
const nearZero = (most: number) => (Math.random() + Math.random() - 1) * most
const tenth = (value: number) => Math.round(value * 10) / 10

const makeScenario = (): Scenario => {
  const club = pick(CLUBS)
  const lieRoll = Math.random()
  const conditions: InsightConditions = {
    grass: pick(LEVELS),
    firmness: pick(LEVELS),
    lie: lieRoll < 0.4 ? 'fairway' : lieRoll < 0.75 ? 'rough' : lieRoll < 0.87 ? 'deep-rough' : 'sand',
    slopeUpDeg: tenth(nearZero(7)),
    slopeRightDeg: tenth(nearZero(5)),
    elevationFt: Math.round(nearZero(35)),
    altitudeFt: Math.random() < 0.45 ? Math.round(Math.random() * 4) * 100 : Math.round((500 + Math.random() * 5000) / 100) * 100,
    windMph: Math.round(Math.random() * 16),
    windFromDeg: Math.round((Math.random() * 360) / 15) * 15,
  }
  // The pin is wherever this club normally finishes: find the carry first so the ball lands on the green.
  const carryYds = finishOf(INSIGHT_BASELINE, 150, club.swing).carryYds
  const baseYds = Math.round(finishOf(INSIGHT_BASELINE, carryYds + 5, club.swing).totalYds)
  return { club, conditions, baseYds }
}

const slopeText = (upDeg: number, rightDeg: number) => {
  const up = Math.abs(upDeg) < 0.05 ? 'Level' : `${Math.abs(upDeg).toFixed(1)}° ${upDeg > 0 ? 'up' : 'down'}`
  const across = Math.abs(rightDeg) < 0.05 ? '' : `, ${Math.abs(rightDeg).toFixed(1)}° ${rightDeg > 0 ? 'right' : 'left'}`
  return `${up}${across}`
}

const windWords = (mph: number, fromDeg: number) => {
  if (mph === 0) return 'Calm'
  const into = Math.cos((fromDeg * Math.PI) / 180)
  const fromRight = Math.sin((fromDeg * Math.PI) / 180)
  const along = into > 0.38 ? 'into' : into < -0.38 ? 'behind' : ''
  const across = fromRight > 0.38 ? 'from right' : fromRight < -0.38 ? 'from left' : ''
  return `${mph} mph ${[along, across].filter(Boolean).join(', ')}`
}

const signed = (value: number) => (Math.round(value) === 0 ? '±0' : `${value > 0 ? '+' : '−'}${Math.abs(Math.round(value))}`)
const sideWords = (value: number) => (Math.abs(value) < 0.5 ? '' : `${Math.round(Math.abs(value))} ${value > 0 ? 'right' : 'left'}`)

/** The hole from above with the pin, the sand, and where a read would leave the ball. */
function Leave({ longYds, rightYds }: { longYds: number; rightYds: number }) {
  const scale = 4.4
  const at = (long: number, right: number) => ({ cx: 150 + long * scale, cy: 70 + right * scale })
  const { green, bunkers } = INSIGHT_HOLE
  const ball = at(Math.max(-32, Math.min(32, longYds)), Math.max(-14, Math.min(14, rightYds)))
  return (
    <svg aria-hidden="true" className="insights-quiz__hole" viewBox="0 0 300 140">
      <rect fill="#12281a" height="140" rx="10" width="300" />
      <ellipse {...at(green.longYds, green.rightYds)} fill="#1c3d28" rx={green.halfDepthYds * scale} ry={green.halfWidthYds * scale} stroke="rgba(242,226,184,.3)" />
      {bunkers.map((bunker) => (
        <ellipse {...at(bunker.longYds, bunker.rightYds)} fill="rgba(214,196,150,.5)" key={`${bunker.longYds}`} rx={bunker.halfDepthYds * scale} ry={bunker.halfWidthYds * scale} />
      ))}
      <path d="M150 70 V44 l14 5 l-14 5" fill="#eab308" stroke="#fff" strokeWidth="1.6" />
      <circle {...ball} fill="#fff" r="6" stroke="#07100a" strokeWidth="2.5" />
    </svg>
  )
}

export default function InsightsReadQuiz() {
  const [scenario, setScenario] = useState<Scenario>(makeScenario)
  const [distance, setDistance] = useState<number>(scenario.baseYds)
  const [side, setSide] = useState(0)
  const [checked, setChecked] = useState(false)
  const [stats, setStats] = useState<InsightReadStats | null>(null)
  const saved = useRef(false)

  const { club, conditions, baseYds } = scenario

  useEffect(() => {
    let live = true
    void loadInsightReadStats().then((found) => { if (live) setStats(found) })
    return () => { live = false }
  }, [])

  /** The answer, and what each known was worth on the way to it, in the order they are shown. */
  const answer = useMemo(() => {
    const layers: { key: string; change: Partial<InsightConditions> }[] = [
      { key: 'green', change: { grass: conditions.grass, firmness: conditions.firmness } },
      { key: 'surface', change: { lie: conditions.lie } },
      { key: 'lie', change: { slopeUpDeg: conditions.slopeUpDeg, slopeRightDeg: conditions.slopeRightDeg } },
      { key: 'wind', change: { windMph: conditions.windMph, windFromDeg: conditions.windFromDeg } },
      { key: 'altitude', change: { altitudeFt: conditions.altitudeFt } },
      { key: 'elevation', change: { elevationFt: conditions.elevationFt } },
    ]
    let running: InsightConditions = INSIGHT_BASELINE
    let before = finishOf(running, baseYds, club.swing)
    const worth: Record<string, { yards: number; side: number }> = { stimp: { yards: 0, side: 0 } }
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

  const check = () => {
    setChecked(true)
    if (saved.current) return
    saved.current = true
    void saveInsightRead({
      club: club.name,
      baseYds,
      actualYds: answer.finish.totalYds,
      actualSideYds: answer.finish.sideYds,
      guessYds: distance,
      guessSideYds: side,
      conditions: { ...conditions, stimp: STIMP },
    }).then((ok) => {
      if (ok) void loadInsightReadStats().then((found) => { if (found) setStats(found) })
    })
  }

  const next = () => {
    const fresh = makeScenario()
    saved.current = false
    setScenario(fresh)
    setDistance(fresh.baseYds)
    setSide(0)
    setChecked(false)
  }

  const knowns: { key: string; name: string; value: ReactNode }[] = [
    { key: 'green', name: 'Green', value: `${GRASS[conditions.grass]}, ${conditions.firmness}` },
    { key: 'stimp', name: 'Stimp', value: `${STIMP}` },
    { key: 'surface', name: 'Surface', value: LIE_NAMES[conditions.lie] },
    { key: 'lie', name: 'Lie', value: slopeText(conditions.slopeUpDeg, conditions.slopeRightDeg) },
    {
      key: 'wind',
      name: 'Wind',
      value: (
        <>
          {conditions.windMph > 0 ? (
            <svg aria-hidden="true" className="insights-quiz__wind" viewBox="-12 -12 24 24">
              {/* Up the page is toward the target; the arrow shows where the wind is blowing to. */}
              <g transform={`rotate(${conditions.windFromDeg + 180})`}>
                <path d="M0 9 L0 -8 M-5 -3 L0 -9 L5 -3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" />
              </g>
            </svg>
          ) : null}
          {windWords(conditions.windMph, conditions.windFromDeg)}
        </>
      ),
    },
    { key: 'altitude', name: 'Altitude', value: conditions.altitudeFt === 0 ? 'Sea level' : `${conditions.altitudeFt.toLocaleString('en-US')} ft` },
    { key: 'elevation', name: 'Elevation', value: conditions.elevationFt === 0 ? 'Level' : `${Math.abs(conditions.elevationFt)} ft ${conditions.elevationFt > 0 ? 'up' : 'down'}` },
  ]

  const guessMiss = Math.round(Math.abs(longMiss))
  const guessSideMiss = Math.round(Math.abs(rightMiss))

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
              <small>{club.swing.spinRpm.toLocaleString('en-US')} rpm</small>
            </div>
            <ol className="insights-quiz__knowns">
              {knowns.map((known) => {
                const worth = answer.worth[known.key]
                return (
                  <li key={known.key}>
                    <span>{known.name}</span>
                    <strong>{known.value}</strong>
                    <b className={checked ? 'is-shown' : ''}>
                      {checked
                        ? known.key === 'stimp'
                          ? 'as normal'
                          : `${signed(worth.yards)} yd${sideWords(worth.side) ? `, ${sideWords(worth.side)}` : ''}`
                        : '?'}
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
                <output>{distance} yd</output>
              </label>
              <input
                id="insights-quiz-distance"
                max={baseYds + 45}
                min={baseYds - 70}
                onChange={(event) => { setDistance(Number(event.target.value)); setChecked(false) }}
                step={1}
                type="range"
                value={distance}
              />
              <label htmlFor="insights-quiz-side">
                <span>It finishes</span>
                <output>{side === 0 ? 'on line' : `${Math.abs(side)} yd ${side > 0 ? 'right' : 'left'}`}</output>
              </label>
              <input
                id="insights-quiz-side"
                max={25}
                min={-25}
                onChange={(event) => { setSide(Number(event.target.value)); setChecked(false) }}
                step={1}
                type="range"
                value={side}
              />
              <button className="insights-button" type="submit">Check my read</button>
            </form>
          </div>

          {checked ? (
            <div className="insights-quiz__result" role="status">
              <Leave longYds={longMiss} rightYds={rightMiss} />
              <div>
                <p className="insights-quiz__verdict">{leave.headline}</p>
                <p>{leave.detail}</p>
                <p>
                  It goes <strong>{Math.round(answer.finish.totalYds)} yards</strong>
                  {Math.abs(answer.finish.sideYds) < 0.5 ? ', on line' : <> and finishes <strong>{sideWords(answer.finish.sideYds)}</strong></>}.
                  {' '}You said {distance}{side === 0 ? ', on line' : `, ${Math.abs(side)} ${side > 0 ? 'right' : 'left'}`}:
                  {' '}{guessMiss === 0 && guessSideMiss === 0
                    ? 'dead on.'
                    : `off by ${[guessMiss ? `${guessMiss} yd in distance` : '', guessSideMiss ? `${guessSideMiss} yd in line` : ''].filter(Boolean).join(' and ')}.`}
                </p>
                {stats && stats.reads >= STATS_FROM_READS ? (
                  <p className="insights-quiz__stats">
                    Across {stats.reads.toLocaleString('en-US')} reads so far, people are off by {stats.missYds.toFixed(0)} yards on
                    average ({stats.missPct.toFixed(0)}% of the shot) and {stats.sideMissYds.toFixed(0)} yards in line.
                  </p>
                ) : null}
                <div className="insights-quiz__after">
                  <button className="insights-quiz__again" onClick={next} type="button">Give me another</button>
                  <span>
                    The live caddie does this sum before every shot. <a href="/?signup=1">Create a free account</a>
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <p className="insights-quiz__hint">
              Seven things you know about the shot. Add them up, then check.{' '}
              <button className="insights-quiz__again" onClick={next} type="button">Give me a different shot</button>
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
