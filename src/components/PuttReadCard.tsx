import { BASELINE_STIMP, feetInches, readPutt } from '../liveCaddie/puttRead'
import './PuttReadCard.css'

export type PuttElevationSource = 'green map' | 'GSPro HUD'

type Props = {
  distanceFt: number | null
  /** Rise (+) or fall (-) from the ball to the hole, inches. Null when nothing has read it yet. */
  riseIn: number | null
  stimp: number | null
  elevationSource?: PuttElevationSource | null
}

const ft = (value: number) => (value >= 10 ? `${Math.round(value)} ft` : `${value.toFixed(1)} ft`)

/**
 * The green-side card: how hard to hit this putt. Pace only; break isn't measured yet, so no aim line.
 */
export default function PuttReadCard({ distanceFt, riseIn, stimp }: Props) {
  if (distanceFt == null || !(distanceFt > 0)) {
    return (
      <section className="putt-read" data-state="waiting">
        <span className="live-kicker">ON GREEN</span>
        <h1>Reading the putt…</h1>
        <p>Looper needs the ball and the pin on the green map to size this putt.</p>
      </section>
    )
  }
  const read = readPutt(distanceFt, riseIn ?? 0, stimp)
  const flatKnown = riseIn != null
  const direction = riseIn == null ? null : Math.abs(riseIn) < 0.5 ? 'flat' : riseIn > 0 ? 'uphill' : 'downhill'
  const sameAsBaseline = Math.abs(read.stimp - BASELINE_STIMP) < 0.05
  return (
    <section className="putt-read" data-state={read.runaway ? 'runaway' : 'ready'}>
      <span className="live-kicker">ON GREEN · STIMP {read.stimp % 1 ? read.stimp.toFixed(1) : read.stimp}</span>
      {read.runaway ? (
        <p className="putt-read__warn">
          <b>This one won&rsquo;t stop.</b> At stimp {read.stimp} a putt can&rsquo;t stop on a downhill steeper than
          {' '}{read.runawayPercent.toFixed(1)}%. Die it at the hole; the green has to flatten to stop it.
        </p>
      ) : (
        <div className="putt-read__plays">
          <span>Plays like</span>
          <b>{read.playsLikeFt != null ? ft(read.playsLikeFt) : '–'}</b>
          <small>{flatKnown ? 'on a flat green at this speed' : 'until the slope is read'}</small>
          {sameAsBaseline ? null : (
            <p className="putt-read__baseline">
              Your stimp-11 stroke: <b>{read.stimp11Ft != null ? ft(read.stimp11Ft) : '–'}</b>
            </p>
          )}
        </div>
      )}

      {/* GSPro already shows these two, so they sit under the read, smaller. */}
      <div className="putt-read__line">
        <strong>{ft(distanceFt)}</strong>
        {direction == null ? <span className="putt-read__slope">rise or fall not read yet</span>
          : direction === 'flat' ? <span className="putt-read__slope">flat</span>
            : (
              <span className={`putt-read__slope is-${direction}`}>
                {direction === 'uphill' ? '▲' : '▼'} {feetInches(riseIn ?? 0)} {direction}
                <small> · {Math.abs(read.grade * 100).toFixed(1)}%</small>
              </span>
            )}
      </div>

      <p className="putt-read__note">Pace only. You own the read.</p>
    </section>
  )
}
