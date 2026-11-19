import { useMemo, useState } from 'react'
import {
  INSIGHT_BASELINE,
  finishOf,
  scatterFor,
  strokesLostToMisread,
  type InsightConditions,
  type InsightLie,
  type InsightSwing,
} from './insightsShotModel'

/**
 * Test your read: a shot the page makes up, and the visitor says where it
 * will finish. Looper picks the club and its normal numbers, then a value for
 * each condition, written the way GSPro shows them. The answer and the cost of
 * the miss in strokes come from the models the live caddie runs.
 */

type Club = Readonly<{ name: string; swing: InsightSwing }>

/** Typical stock numbers for a mid-handicap player. */
const CLUBS: readonly Club[] = [
  { name: 'Pitching wedge', swing: { ballSpeedMph: 94, launchDeg: 24, spinRpm: 8800 } },
  { name: '9 iron', swing: { ballSpeedMph: 101, launchDeg: 21.5, spinRpm: 8100 } },
  { name: '8 iron', swing: { ballSpeedMph: 108, launchDeg: 19.5, spinRpm: 7300 } },
  { name: '7 iron', swing: { ballSpeedMph: 114, launchDeg: 17.5, spinRpm: 6600 } },
  { name: '6 iron', swing: { ballSpeedMph: 120, launchDeg: 15.5, spinRpm: 5900 } },
  { name: '5 iron', swing: { ballSpeedMph: 125, launchDeg: 14, spinRpm: 5300 } },
]

const GRASS = { soft: 'Bentgrass', medium: 'Bermuda', firm: 'Links' } as const
const LIE_NAMES: Record<InsightLie, string> = { fairway: 'Fairway', rough: 'Rough', 'deep-rough': 'Deep rough', sand: 'Sand' }
const LEVELS = ['soft', 'medium', 'firm'] as const

type Scenario = Readonly<{
  club: Club
  conditions: InsightConditions
  baseYds: number
}>

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
  const baseYds = Math.round(finishOf(INSIGHT_BASELINE, carryYds, club.swing).totalYds)
  return { club, conditions, baseYds }
}

const slopeText = (upDeg: number, rightDeg: number) => {
  const up = Math.abs(upDeg) < 0.05 ? 'level' : `${Math.abs(upDeg).toFixed(1)}° ${upDeg > 0 ? 'up' : 'down'}`
  const across = Math.abs(rightDeg) < 0.05 ? '' : `, ${Math.abs(rightDeg).toFixed(1)}° ${rightDeg > 0 ? 'right' : 'left'}`
  return `${up}${across}`
}

const windWords = (mph: number, fromDeg: number) => {
  if (mph === 0) return 'Calm'
  const into = Math.cos((fromDeg * Math.PI) / 180)
  const fromRight = Math.sin((fromDeg * Math.PI) / 180)
  const along = into > 0.38 ? 'into you' : into < -0.38 ? 'behind you' : ''
  const across = fromRight > 0.38 ? 'from the right' : fromRight < -0.38 ? 'from the left' : ''
  return `${mph} mph, ${[along, across].filter(Boolean).join(' and ')}`
}

const missText = (longYds: number, rightYds: number) => {
  const long = Math.round(longYds)
  const right = Math.round(rightYds)
  const parts = [
    long === 0 ? '' : `${Math.abs(long)} yd ${long > 0 ? 'long' : 'short'}`,
    right === 0 ? '' : `${Math.abs(right)} yd ${right > 0 ? 'right' : 'left'}`,
  ].filter(Boolean)
  return parts.length ? parts.join(' and ') : 'dead on'
}

const signed = (value: number) => (Math.round(value) === 0 ? '±0' : `${value > 0 ? '+' : '−'}${Math.abs(Math.round(value))}`)

export default function InsightsReadQuiz() {
  const [scenario, setScenario] = useState<Scenario>(makeScenario)
  const [distance, setDistance] = useState<number>(scenario.baseYds)
  const [side, setSide] = useState(0)
  const [checked, setChecked] = useState(false)

  const { club, conditions, baseYds } = scenario

  /** The answer, and what each condition added on the way to it. */
  const answer = useMemo(() => {
    const layers: { name: string; change: Partial<InsightConditions> }[] = [
      { name: 'Green', change: { grass: conditions.grass, firmness: conditions.firmness } },
      { name: 'Lie', change: { lie: conditions.lie } },
      { name: 'Slope', change: { slopeUpDeg: conditions.slopeUpDeg, slopeRightDeg: conditions.slopeRightDeg } },
      { name: 'Elevation', change: { elevationFt: conditions.elevationFt } },
      { name: 'Altitude', change: { altitudeFt: conditions.altitudeFt } },
      { name: 'Wind', change: { windMph: conditions.windMph, windFromDeg: conditions.windFromDeg } },
    ]
    let running: InsightConditions = INSIGHT_BASELINE
    let before = finishOf(running, baseYds, club.swing)
    const steps = layers.map((layer) => {
      running = { ...running, ...layer.change }
      const after = finishOf(running, baseYds, club.swing)
      const step = { name: layer.name, yards: after.totalYds - before.totalYds, side: after.sideYds - before.sideYds }
      before = after
      return step
    })
    return { finish: before, steps }
  }, [baseYds, club, conditions])

  const longMiss = answer.finish.totalYds - distance
  const rightMiss = answer.finish.sideYds - side
  const lost = strokesLostToMisread(longMiss, rightMiss, scatterFor(baseYds))

  const next = () => {
    const fresh = makeScenario()
    setScenario(fresh)
    setDistance(fresh.baseYds)
    setSide(0)
    setChecked(false)
  }

  const facts: [string, string][] = [
    ['Green', `${GRASS[conditions.grass]}, ${conditions.firmness}`],
    ['Lie', `${LIE_NAMES[conditions.lie]}, ${slopeText(conditions.slopeUpDeg, conditions.slopeRightDeg)}`],
    ['Elevation', conditions.elevationFt === 0 ? 'Level' : `Green ${Math.abs(conditions.elevationFt)} ft ${conditions.elevationFt > 0 ? 'above' : 'below'} you`],
    ['Altitude', conditions.altitudeFt === 0 ? 'Sea level' : `${conditions.altitudeFt.toLocaleString('en-US')} ft`],
    ['Wind', windWords(conditions.windMph, conditions.windFromDeg)],
  ]

  return (
    <section className="insights-quiz" aria-labelledby="insights-quiz-title">
      <div className="insights-wrap">
        <div className="insights-quiz__card">
          <div className="insights-quiz__shot">
            <p className="insights-eyebrow">Test your read</p>
            <h2 id="insights-quiz-title">Where does this one finish?</h2>
            <p className="insights-quiz__club">
              <strong>{club.name}.</strong> Normally {baseYds} yards for you, with {club.swing.spinRpm.toLocaleString('en-US')} rpm of spin,
              from a level fairway lie onto a Bermuda medium green in still air at sea level.
            </p>
            <dl className="insights-quiz__facts">
              {facts.map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>
                    {name === 'Wind' && conditions.windMph > 0 ? (
                      <svg aria-hidden="true" className="insights-quiz__wind" viewBox="-12 -12 24 24">
                        {/* Up the page is toward the target; the arrow shows where the wind is blowing to. */}
                        <g transform={`rotate(${conditions.windFromDeg + 180})`}>
                          <path d="M0 9 L0 -8 M-5 -3 L0 -9 L5 -3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" />
                        </g>
                      </svg>
                    ) : null}
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <form
            className="insights-quiz__guess"
            onSubmit={(event) => {
              event.preventDefault()
              setChecked(true)
            }}
          >
            <label htmlFor="insights-quiz-distance">
              <span>How far will it go?</span>
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
              <span>Where will it finish, left or right of your aim?</span>
              <output>{side === 0 ? 'On line' : `${Math.abs(side)} yd ${side > 0 ? 'right' : 'left'}`}</output>
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
            <div className="insights-quiz__buttons">
              <button className="insights-button" type="submit">Check my read</button>
              <button className="insights-quiz__again" onClick={next} type="button">Give me another</button>
            </div>
          </form>

          {checked ? (
            <div className="insights-quiz__result" role="status">
              <p className="insights-quiz__verdict">
                It goes <strong>{Math.round(answer.finish.totalYds)} yards</strong>
                {Math.abs(answer.finish.sideYds) < 0.5 ? ', on line.' : <> and finishes <strong>{Math.round(Math.abs(answer.finish.sideYds))} yards {answer.finish.sideYds > 0 ? 'right' : 'left'}</strong>.</>}
              </p>
              <p>
                Your read would leave you <strong>{missText(longMiss, rightMiss)}</strong>.{' '}
                {lost < 0.03
                  ? 'That costs you nothing. Nicely read.'
                  : <>Play it on your numbers and it costs about <strong>{lost.toFixed(2)} strokes</strong>.</>}
              </p>
              <ul className="insights-quiz__steps">
                <li><span>{club.name}, normal</span><b>{baseYds}</b></li>
                {answer.steps.map((step) => (
                  <li key={step.name}>
                    <span>{step.name}</span>
                    <b>
                      {signed(step.yards)}
                      {Math.abs(step.side) >= 0.5 ? <small>, {Math.round(Math.abs(step.side))} {step.side > 0 ? 'right' : 'left'}</small> : null}
                    </b>
                  </li>
                ))}
              </ul>
              <p className="insights-quiz__pitch">
                The live caddie works this out before every shot and gives you the club and the aim.{' '}
                <a href="/?signup=1">Create a free account</a>
              </p>
            </div>
          ) : (
            <p className="insights-quiz__hint">
              Strokes are worked out against tour averages for the putt or chip you would be left with.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
