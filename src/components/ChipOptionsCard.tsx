import { CHIP_LABEL, chipLieRead, defaultChip, type ChipOption, type ChipType, type LandingSurface } from '../liveCaddie/chipOptions'
import './ChipOptionsCard.css'

type Props = {
  distanceYds: number
  options: readonly ChipOption[]
  /** The chip whose landing is on the map. */
  shown: ChipType | null
  onShow: (type: ChipType) => void
  /** e.g. "Bermuda · medium green, firm fairway · stimp 12" */
  conditions: string
  /** False: no green map here, so no break. */
  hasGreenMap: boolean
  fromSand?: boolean
  /** GSPro's lie: + starts the ball left, + uphill. Null when it hasn't been read. */
  lieLeftRightDeg?: number | null
  lieUpDownDeg?: number | null
  /** What the ball is sitting on, in plain words. */
  surface?: string
  /** Feet to aim left (+) or right (-) so each chip's run breaks to the hole; null when not known. */
  breakLeftFt?: Partial<Record<ChipType, number | null>> | null
  /** The break was scaled to GSPro's own height for this line (the map and GSPro's green differ). */
  breakScaled?: boolean
  /** Height of the hole above (+) or below (-) the ball, feet, and where it was read. */
  riseFt?: number | null
  riseSource?: 'GSPro' | 'green map' | null
  /** Aim GSPro for this chip (Auto Aim). */
  onAim?: (type: ChipType) => void
  aim?: { type: ChipType; state: 'aiming' | 'aimed' | 'not-aimed'; message: string } | null
  /** Around the pin: one or two short lines, only what changes how to play the chip. */
  pinNotes?: readonly string[]
  /** Looper's green outline ends close to the pin (or misses it): where GSPro's green starts is unsure. */
  greenEdgeUncertain?: boolean
}

const SURFACE: Readonly<Record<LandingSurface, string>> = {
  green: 'green', fairway: 'fairway', fringe: 'fringe', rough: 'rough', 'deep-rough': 'deep rough', bunker: 'bunker', water: 'water', other: 'off the map',
}

const TAG: Readonly<Record<ChipOption['verdict'], string | null>> = {
  good: 'Best here', fine: null, short: 'Lands short', 'not-needed': 'Not needed', avoid: 'Avoid',
}

/** Under 3 inches of break reads as straight. */
const BREAK_STRAIGHT_FT = 0.25

const yd = (value: number) => (value < 10 ? value.toFixed(1) : String(Math.round(value)))
const heightText = (ft: number) => {
  const a = Math.abs(ft)
  return a >= 3 ? `${Math.round(a)} ft` : `${Math.floor(a)} ft ${Math.round((a % 1) * 12)} in`.replace(/^0 ft /, '')
}
const feet = (value: number) => (Math.abs(value) >= 9.5 ? `${Math.round(Math.abs(value) / 3)} yd` : `${Math.max(1, Math.round(Math.abs(value)))} ft`)

/**
 * Around the green, in the shot card's place. Left: the four chips as rows, each sized to finish at
 * the hole, and where to aim. Right: what is moving this chip (lie, surface, slope to the hole).
 * Tap a row to put its landing on the map.
 */
export default function ChipOptionsCard({
  distanceYds, options, shown, onShow, conditions, hasGreenMap, fromSand = false,
  lieLeftRightDeg = null, lieUpDownDeg = null, surface = '', onAim, aim = null,
  pinNotes = [], greenEdgeUncertain = false, riseFt = null, riseSource = null, breakLeftFt = null,
}: Props) {
  const riseText = riseFt == null ? null
    : Math.abs(riseFt) < 0.25 ? 'level'
      : `${riseFt > 0 ? '▲' : '▼'} ${Math.floor(Math.abs(riseFt))} ft ${Math.round((Math.abs(riseFt) % 1) * 12)} in`
  // A shot "landing short" of an outline we doubt may well land on GSPro's green: don't call it short.
  // Sand and water short of the green are still real.
  const edgeUnclear = (option: ChipOption) => greenEdgeUncertain && option.verdict === 'short'
    && option.landsOn !== 'bunker' && option.landsOn !== 'water'
  // Nothing lands on the green and stops: the shot to look at first is the highest one left, which
  // lands nearest the green. Never a low one landing short (Brian, 21 Nov).
  const nearest = options.some((o) => o.verdict === 'good') ? null : defaultChip(options)
  const tagFor = (option: ChipOption) => (option === nearest ? 'Nearest the green'
    : edgeUnclear(option) ? 'Edge unclear' : TAG[option.verdict] ?? '')
  const aimedThis = aim != null && aim.type === shown
  const current = options.find((o) => o.type === shown) ?? null
  const onlyLine = !current ? 'None of the four finishes at the hole cleanly from here.'
    : current.verdict === 'avoid' ? current.reason
      : current === nearest ? 'Nothing lands on the green and stops: this lands nearest it.'
        : current.carries
          ? fromSand && current.carries.surface === 'bunker'
            ? `Out of the bunker: lands ${Math.round(current.carries.landsPastYds)} yd past its edge.`
            : `Carries the ${SURFACE[current.carries.surface]}: lands ${Math.round(current.carries.landsPastYds)} yd past it.`
          : null
  // Landing a yard or more off level changes the swing: say it like sand does (Brian, 21 Nov).
  const heightCounts = current != null && Math.abs(current.levelCarryYds - current.flight.carryYds) >= 1
  const swingYds = current == null ? null
    : current.swingLikeYds ?? (heightCounts ? current.levelCarryYds : null)
  const comfortable = options.filter((o) => o.verdict === 'fine' || o.verdict === 'good').length >= 2
  const lieOnly = current ? chipLieRead(current, distanceYds, lieLeftRightDeg, lieUpDownDeg) : null
  const breakFt = current ? breakLeftFt?.[current.type] ?? null : null
  // The aim line is the two together; each row below shows its own share.
  const lie = lieOnly ? { ...lieOnly, aimLeftFt: lieOnly.aimLeftFt + (breakFt ?? 0) } : null
  const aimOff = lie && Math.abs(lie.aimLeftFt) >= 1
  const lieAimOff = lieOnly != null && Math.abs(lieOnly.aimLeftFt) >= 1
  const sideText = lieLeftRightDeg == null ? 'not read' : Math.abs(lieLeftRightDeg) < 0.25 ? 'level'
    : `${Math.abs(lieLeftRightDeg).toFixed(1)}° ${lieLeftRightDeg > 0 ? 'left' : 'right'}`
  const upText = lieUpDownDeg == null ? 'not read' : Math.abs(lieUpDownDeg) < 0.25 ? 'level'
    : `${Math.abs(lieUpDownDeg).toFixed(1)}° ${lieUpDownDeg > 0 ? 'up' : 'down'}`
  return (
    <>
      <section className="chip-options" aria-label="Chip options">
        <div className="chip-options__head">
          {swingYds != null && current ? (
            // From sand, or landing well above or below the ball, the number to play is the swing, not
            // the distance: big and yellow, like a putt's Plays like.
            <div className="chip-options__swing">
              <span>Swing for</span>
              <b>{Math.round(swingYds)} YD CARRY</b>
              <small>
                {Math.round(distanceYds)} yd to the pin
                {heightCounts && current.landingRiseFt != null
                  ? ` · lands ${heightText(current.landingRiseFt)} ${current.landingRiseFt > 0 ? 'above' : 'below'} you`
                  : ''}
                {current.swingLikeYds != null ? ` · the sand takes it down to ${yd(current.flight.carryYds)}` : ` · flies ${yd(current.flight.carryYds)} on this ground`}
              </small>
            </div>
          ) : (
            <div className="chip-options__distance">{Math.round(distanceYds)} YDS</div>
          )}
          <div className={`chip-options__aim${aimOff ? ' is-off' : ''}`}>
            <span>AIM</span>
            {aimOff && lie
              ? `${feet(lie.aimLeftFt)} ${lie.aimLeftFt > 0 ? 'left' : 'right'} of the pin`
              : 'at the pin'}
            {fromSand ? <em>Sand adjusted</em> : null}
          </div>
          {greenEdgeUncertain ? (
            <p className="chip-options__edge">
              Looper&rsquo;s green may be short here: check where GSPro&rsquo;s green starts.
            </p>
          ) : null}
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
              className={`chip-row is-${option.verdict}${edgeUnclear(option) ? ' is-edge-unclear' : ''}${option === nearest ? ' is-nearest' : ''}${option.type === shown ? ' is-shown' : ''}`}
              onClick={() => onShow(option.type)}
            >
              <span className="chip-row__name">{CHIP_LABEL[option.type]}<small>{option.launchDeg}&deg;</small></span>
              <span className="chip-row__num">{yd(option.flight.carryYds)}</span>
              <span className="chip-row__num">{yd(option.runYds)}</span>
              <span className="chip-row__tag">{tagFor(option)}</span>
            </button>
          ))}
        </div>
        {/* One line, and only what the rows, the tags, the big number and the table don't already say. */}
        {onlyLine ? <p className="chip-options__reason">{onlyLine}</p> : null}
        <p className="chip-options__note">
          {comfortable ? 'More than one lands on the green: pick the one you’re most comfortable with.' : ''}
        </p>
      </section>

      {onAim && current ? (
        <div className="chip-options__arm-wrap">
          <button
            type="button"
            className={`chip-options__arm${aimedThis && aim?.state === 'aimed' ? ' is-aimed' : ''}`}
            disabled={current.verdict === 'avoid' || (aimedThis && aim?.state === 'aiming')}
            onClick={() => onAim(current.type)}
          >
            {aimedThis && aim?.state === 'aiming' ? 'AIMING IN GSPRO…'
              : aimedThis && aim?.state === 'aimed' ? `${CHIP_LABEL[current.type].toUpperCase()} · AIMED · TAP TO RE-AIM`
                : `HITTING THE ${CHIP_LABEL[current.type].toUpperCase()} · TAP TO AIM`}
          </button>
          {/* Always there, so a message never moves the button. */}
          <p className="chip-options__arm-note">{aimedThis && aim && aim.state !== 'aiming' ? aim.message : ''}</p>
        </div>
      ) : null}

      <aside className="chip-conditions" aria-label="What is moving this chip">
        <div className="chip-conditions__title">
          <span>What’s moving this chip</span>
          <b>{current ? CHIP_LABEL[current.type] : '—'}</b>
        </div>
        {/* Under the ball first (up/down then side, as GSPro lists them), then the green, then the strike. */}
        <div className="chip-conditions__row">
          <span>Up or down slope</span>
          <b>{upText}</b>
          <em>
            {lie && Math.abs(lie.launchDeltaDeg) >= 0.75
              ? `launches ${Math.abs(lie.launchDeltaDeg).toFixed(0)}° ${lie.launchDeltaDeg > 0 ? 'higher: lands softer, runs less' : 'lower: comes in hotter, runs more'} · included in Fly and Run`
              : lieUpDownDeg == null ? '—' : 'no change'}
          </em>
        </div>
        <div className="chip-conditions__row">
          <span>Side slope</span>
          <b>{sideText}</b>
          <em className={lieAimOff ? 'is-off' : ''}>
            {lieAimOff && lieOnly ? `starts it ${lieOnly.aimLeftFt > 0 ? 'right' : 'left'}: ${feet(lieOnly.aimLeftFt)} ${lieOnly.aimLeftFt > 0 ? 'left' : 'right'}` : lieLeftRightDeg == null ? '—' : 'no change to the aim'}
          </em>
        </div>
        <div className="chip-conditions__row">
          <span>Lie</span>
          <b>{fromSand ? 'sand' : /rough/.test(surface) ? 'rough' : 'clean'}</b>
          <em>
            {fromSand ? 'about a quarter of the speed gone: bigger swing, pitch or flop only'
              : /rough/.test(surface) ? 'about a third less spin: runs a little more' : 'no change'}
          </em>
        </div>
        <div className="chip-conditions__row">
          <span>To the hole</span>
          <b>{riseText ?? '—'}</b>
          <em>
            {riseFt == null ? '—'
              : Math.abs(riseFt) < 0.25 ? 'no change'
                : `${(Math.abs(riseFt) / (distanceYds * 3) * 100).toFixed(1)}% ${riseFt > 0 ? 'uphill: runs less' : 'downhill: runs more'}${hasGreenMap || riseSource === 'GSPro' ? ' · included in Run' : ''}`}
          </em>
        </div>
        <div className="chip-conditions__row">
          <span>Break on the green</span>
          {/* Under a foot still says which way and how many inches: "straight" only when it truly is. */}
          <b>{breakFt == null ? '—' : Math.abs(breakFt) < BREAK_STRAIGHT_FT ? 'straight'
            : Math.abs(breakFt) < 1 ? `${Math.round(Math.abs(breakFt) * 12)} in ${breakFt > 0 ? 'left' : 'right'}`
              : `${feet(breakFt)} ${breakFt > 0 ? 'left' : 'right'}`}</b>
          <em className={breakFt != null && Math.abs(breakFt) >= 1 ? 'is-off' : ''}>
            {breakFt == null ? (hasGreenMap ? '—' : 'no green map here') : Math.abs(breakFt) < BREAK_STRAIGHT_FT ? 'no change to the aim'
              : Math.abs(breakFt) < 1 ? `runs ${breakFt > 0 ? 'left to right' : 'right to left'}, a little: aim stays at the pin`
                : `runs ${breakFt > 0 ? 'left to right' : 'right to left'}: aim ${feet(breakFt)} ${breakFt > 0 ? 'left' : 'right'}`}
          </em>
        </div>
        {pinNotes.length ? (
          <div className="chip-conditions__row">
            <span>Around the pin</span><b />
            <ul className="chip-conditions__notes">{pinNotes.map((note) => <li key={note}>{note}</li>)}</ul>
          </div>
        ) : null}
        <div className="chip-conditions__row">
          <span>Ball data</span>
          <b>{current ? `${Math.round(current.launchDeg + (lie?.launchDeltaDeg ?? 0))}° launch` : '—'}</b>
          <em>{current ? `${Math.round(current.swingFlight.ballSpeedMph)} mph · ${Math.round(current.swingFlight.spinRpm / 50) * 50} rpm (typical spin; yours may differ)` : '—'}</em>
        </div>
        <p className="chip-conditions__foot">
          {conditions}.{hasGreenMap ? ' The run uses the green’s slope to the hole.' : ' No green map here, so the run is for a level green and there’s no break.'}
          {' '}Ground short of the green isn’t mapped for slope.
        </p>
      </aside>
    </>
  )
}
