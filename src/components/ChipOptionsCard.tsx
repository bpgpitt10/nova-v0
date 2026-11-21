import { CHIP_LABEL, type ChipOption, type ChipType, type LandingSurface } from '../liveCaddie/chipOptions'
import './ChipOptionsCard.css'

type Props = {
  distanceYds: number
  options: readonly ChipOption[]
  /** The chip whose landing is on the map. */
  shown: ChipType | null
  onShow: (type: ChipType) => void
  /** e.g. "Bermuda · medium green, firm fairway · stimp 12 · from the rough" */
  conditions: string
  /** False: no green map here, so no break. */
  hasGreenMap: boolean
}

const SURFACE: Readonly<Record<LandingSurface, string>> = {
  green: 'green', fairway: 'fairway', fringe: 'fringe', rough: 'rough', 'deep-rough': 'deep rough', bunker: 'bunker', water: 'water', other: 'off the map',
}

const TAG: Readonly<Record<ChipOption['verdict'], string | null>> = {
  good: 'Best here', fine: null, 'not-needed': 'Not needed', avoid: 'Avoid',
}

const yd = (value: number) => (value < 10 ? value.toFixed(1) : String(Math.round(value)))

/**
 * Around the green, in the shot card's place: the four chips as rows, each sized to finish at the
 * hole. Tap a row to put its landing on the map; the map beside it stays in view.
 */
export default function ChipOptionsCard({ distanceYds, options, shown, onShow, conditions, hasGreenMap }: Props) {
  const current = options.find((o) => o.type === shown) ?? null
  const comfortable = options.filter((o) => o.verdict === 'fine' || o.verdict === 'good').length >= 2
    && !options.some((o) => o.verdict === 'good')
  return (
    <section className="chip-options" aria-label="Chip options">
      <div className="chip-options__head">
        <div className="live-club-hero chip-options__distance">{Math.round(distanceYds)} YDS</div>
        <p>{conditions}</p>
      </div>
      <div className="chip-options__rows" role="radiogroup" aria-label="Chips">
        <div className="chip-options__cols" aria-hidden="true">
          <span>Shot</span><span>Fly</span><span>Run</span><span />
        </div>
        {options.map((option) => (
          <button
            key={option.type}
            type="button"
            role="radio"
            aria-checked={option.type === shown}
            className={`chip-row is-${option.verdict}${option.type === shown ? ' is-shown' : ''}`}
            onClick={() => onShow(option.type)}
          >
            <span className="chip-row__name">{CHIP_LABEL[option.type]}<small>{option.launchDeg}&deg;</small></span>
            <span className="chip-row__num">{yd(option.flight.carryYds)}</span>
            <span className="chip-row__num">{yd(option.runYds)}</span>
            <span className="chip-row__tag">{TAG[option.verdict] ?? ''}</span>
          </button>
        ))}
      </div>
      {current ? (
        <div className="chip-options__detail">
          <p className="chip-options__line">
            <strong>{CHIP_LABEL[current.type]}:</strong> fly {yd(current.flight.carryYds)} yd, lands on the {SURFACE[current.landsOn]},
            runs {yd(current.runYds)}.
          </p>
          {current.reason ? <p className="chip-options__reason">{current.reason}</p> : null}
          <p className="chip-options__spec">
            {current.launchDeg}&deg; launch &middot; {Math.round(current.flight.spinRpm / 50) * 50} rpm &middot; {Math.round(current.flight.ballSpeedMph)} mph
          </p>
        </div>
      ) : (
        <p className="chip-options__reason">None of the four finishes at the hole cleanly from here.</p>
      )}
      <p className="chip-options__note">
        {comfortable ? 'More than one works: pick the one you’re most comfortable with. ' : ''}
        Typical spin; yours may differ.{hasGreenMap ? '' : ' No green map here, so no break.'}
      </p>
    </section>
  )
}
