import { CHIP_LABEL, type ChipOption, type ChipType, type LandingSurface } from '../liveCaddie/chipOptions'
import './ChipOptionsCard.css'

type Props = {
  distanceYds: number
  options: readonly ChipOption[]
  armed: ChipType | null
  onArm: (type: ChipType | null) => void
  /** e.g. "Bermuda firm fairway · stimp 12 · from the rough" */
  conditions: string
  /** False: no green map here, so no aim or break. */
  hasGreenMap: boolean
}

const SURFACE: Readonly<Record<LandingSurface, string>> = {
  green: 'green', fairway: 'fairway', fringe: 'fringe', rough: 'rough', 'deep-rough': 'deep rough', bunker: 'bunker', water: 'water', other: 'off the map',
}

const VERDICT: Readonly<Record<ChipOption['verdict'], string | null>> = {
  good: 'Best here', fine: null, 'not-needed': 'Not needed', avoid: 'Avoid',
}

const yd = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)} yd`

/** Around the green: all four chips, each sized to finish at the hole. Arm one to mark where to land it. */
export default function ChipOptionsCard({ distanceYds, options, armed, onArm, conditions, hasGreenMap }: Props) {
  const comfortable = options.filter((o) => o.verdict === 'fine' || o.verdict === 'good').length >= 2
    && !options.some((o) => o.verdict === 'good')
  return (
    <section className="chip-options">
      <header>
        <span className="live-kicker">AROUND THE GREEN · CHIP LAB</span>
        <h1>{Math.round(distanceYds)} yd to the pin</h1>
        <p>{conditions}</p>
      </header>
      <div className="chip-options__grid">
        {options.map((option) => {
          const isArmed = armed === option.type
          return (
            <article
              key={option.type}
              className={`chip-option is-${option.verdict}${isArmed ? ' is-armed' : ''}`}
            >
              <div className="chip-option__head">
                <b>{CHIP_LABEL[option.type]}</b>
                {VERDICT[option.verdict] ? <span className="chip-option__tag">{VERDICT[option.verdict]}</span> : null}
              </div>
              <dl>
                <div><dt>Fly</dt><dd>{yd(option.flight.carryYds)}</dd></div>
                <div><dt>Runs</dt><dd>{yd(option.runYds)}</dd></div>
              </dl>
              <p className="chip-option__lands">Lands on the {SURFACE[option.landsOn]}</p>
              <p className="chip-option__spec">
                {option.launchDeg}&deg; launch &middot; {Math.round(option.flight.spinRpm / 50) * 50} rpm &middot; {Math.round(option.flight.ballSpeedMph)} mph
              </p>
              {option.reason ? <p className="chip-option__reason">{option.reason}</p> : null}
              <button
                type="button"
                className="chip-option__arm"
                onClick={() => onArm(isArmed ? null : option.type)}
                aria-pressed={isArmed}
              >
                {isArmed ? 'Armed · land it on the marker' : 'Arm'}
              </button>
            </article>
          )
        })}
      </div>
      <p className="chip-options__note">
        {comfortable ? 'More than one works here: pick the one you’re most comfortable with. ' : ''}
        Spin is typical for each shot; yours may differ.
        {hasGreenMap ? '' : ' Aim and break need a green map — not available on this course.'}
      </p>
    </section>
  )
}
