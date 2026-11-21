import type { ReactNode } from 'react'
import { PUNCH_OUT_MAX_YDS, type PunchOutEscape } from '../liveCaddie/punchOut'
import './PunchOutCard.css'

type Props = {
  /** A low club from the player's bag, or null when they carry none. */
  club: string | null
  /** The club the player tapped in the rail, if any. */
  chosenClub: string | null
  escape: PunchOutEscape | null
  pinYds: number | null
  lie: string | null
  /** Looper's line for a normal shot from here (drawn on the map): a guess, not a promise. */
  guess?: ReactNode
}

const SIDE: Readonly<Record<PunchOutEscape['side'], string>> = {
  left: 'to your left', right: 'to your right', ahead: 'straight ahead', behind: 'behind you',
  'ahead-left': 'ahead and left', 'ahead-right': 'ahead and right',
}

/**
 * In the trees. Looper can't see the gaps between trunks, so it doesn't pick a line, doesn't quote
 * a chance of success and doesn't aim GSPro. It says what it does know: keep it low, don't go far,
 * and where the fairway is.
 */
export default function PunchOutCard({ club, chosenClub, escape, pinYds, lie, guess = null }: Props) {
  return (
    <section className="punch-out" aria-label="Punch out">
      <div className="punch-out__hero">PUNCH OUT</div>
      <p className="punch-out__own">You pick the line. Looper can&rsquo;t see the gaps between the trees.</p>
      <dl className="punch-out__facts">
        <div>
          <dt>Club</dt>
          <dd>{chosenClub ?? club ?? 'A low iron'}</dd>
          <small>{chosenClub && chosenClub !== club && club
            ? `Your pick. Looper would punch a ${club}: it stays under the branches.`
            : 'Half swing, ball back: it stays under the branches.'}</small>
        </div>
        <div>
          <dt>How far</dt>
          <dd>{PUNCH_OUT_MAX_YDS} yd at most</dd>
          <small>Get it back in play. Don&rsquo;t chase the green{pinYds != null ? ` (${Math.round(pinYds)} yd away)` : ''}.</small>
        </div>
        <div>
          <dt>Fairway</dt>
          <dd>{escape ? `${Math.max(1, Math.round(escape.yds))} yd ${SIDE[escape.side]}` : 'Not mapped here'}</dd>
          <small>{escape ? 'The nearest short grass. The clear gap may be somewhere else: look in GSPro.' : 'Look for the gap in GSPro.'}</small>
        </div>
      </dl>
      {guess ? (
        <p className="punch-out__guess">
          <b>Looper&rsquo;s best guess, on the map:</b> {guess}. It&rsquo;s the open side of the hole, not a checked gap:
          look at the trees in GSPro before you trust it.
        </p>
      ) : null}
      {lie ? <p className="punch-out__note">Lie: {lie}.</p> : null}
      <div className="punch-out__aim" role="status">AUTO AIM IS OFF IN THE TREES · AIM IT YOURSELF IN GSPRO</div>
      <p className="punch-out__note">No odds shown: Looper can&rsquo;t judge a shot through trees it can&rsquo;t see between. Tap the club you hit on the left so the shot is recorded.</p>
    </section>
  )
}
