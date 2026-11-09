import { buildYourGame, FIRM_SHOTS, GIMME_CIRCLE_FT, SHOTS_PER_DOT, type LadderRung, type Segment } from '../lib/yourGame'
import type { RoundSummary } from '../lib/roundHistory'

/** Full rounds (90 holes) before most calls here are firm. */
const FIRM_HOLES = 90
/** Bars run from −0.5 to +0.5 strokes per shot. */
const BAR_SCALE = 0.5

const MINUS = '−'
const signed = (value: number, digits = 2) => {
  const rounded = Number(value.toFixed(digits))
  if (rounded === 0) return (0).toFixed(digits)
  return `${rounded > 0 ? '+' : MINUS}${Math.abs(rounded).toFixed(digits)}`
}
const tone = (value: number | null) =>
  value == null ? 'is-even' : value >= 0.05 ? 'is-gain' : value <= -0.05 ? 'is-loss' : 'is-even'

/** Diverging bar around zero, with an optional marker (your typical shot). */
function PerShotBar({ value, marker }: { value: number | null; marker?: number | null }) {
  const width = value == null ? 0 : (Math.min(Math.abs(value), BAR_SCALE) / BAR_SCALE) * 50
  const markerLeft = marker == null ? null : 50 + (Math.max(-BAR_SCALE, Math.min(BAR_SCALE, marker)) / BAR_SCALE) * 50
  return (
    <span className="yourgame-bar" aria-hidden="true">
      <span className="yourgame-bar-axis" />
      {value != null ? (
        <span
          className={value >= 0 ? 'is-gain-bar' : 'is-loss-bar'}
          style={value >= 0 ? { left: '50%', width: `${width}%` } : { left: `${50 - width}%`, width: `${width}%` }}
        />
      ) : null}
      {markerLeft != null ? <span className="yourgame-bar-marker" style={{ left: `${markerLeft}%` }} /> : null}
    </span>
  )
}

function Dots({ shots }: { shots: number }) {
  const on = Math.min(5, Math.floor(shots / SHOTS_PER_DOT))
  return (
    <span className="yourgame-dots" aria-label={`${shots} of ${FIRM_SHOTS} shots for a firm call`} role="img">
      {[0, 1, 2, 3, 4].map((i) => <span className={i < on ? 'is-on' : undefined} key={i} />)}
    </span>
  )
}

function SegmentCell({ segment }: { segment: Segment }) {
  return (
    <div className="yourgame-leak">
      <strong className={tone(segment.perRound)}>{signed(segment.perRound, 1)}</strong>
      <span className="yourgame-leak-label">{segment.label}</span>
      <span className="rounds-muted">{segment.detail}</span>
      <span className={`yourgame-tag${segment.early ? ' is-early' : ''}`}>
        {segment.early ? `Early read · ${segment.shots} shots` : `${segment.shots} shots`}
      </span>
    </div>
  )
}

const rungRow = (rung: LadderRung, typical: number | null) => (
  <tr key={rung.label}>
    <td><strong>{rung.label}</strong></td>
    <td className="is-num">{rung.shots || '–'}</td>
    <td className="is-num">{rung.shots ? `${rung.onGreen}/${rung.shots}` : '–'}</td>
    <td className="is-num">{rung.avgLeaveFt != null ? `${Math.round(rung.avgLeaveFt)} ft` : '–'}</td>
    <td className="yourgame-bar-cell"><PerShotBar marker={typical} value={rung.sgPerShot} /></td>
    <td className={`is-num ${tone(rung.sgPerShot)}`}>{rung.sgPerShot != null ? signed(rung.sgPerShot) : '–'}</td>
    <td><Dots shots={rung.shots} /></td>
  </tr>
)

export function YourGame({ rounds }: { rounds: readonly RoundSummary[] }) {
  const game = buildYourGame(rounds)
  const progress = Math.min(100, (game.holes / FIRM_HOLES) * 100)

  return (
    <main className="rounds-main yourgame">
      <header className="yourgame-header">
        <div className="yourgame-intro">
          <span className="rounds-eyebrow">Your game</span>
          <h1 className="rounds-display-title">Where you lose strokes</h1>
          <p className="rounds-muted">
            Every shot is compared with your typical shot, then weighted by how often that shot comes up. The result is
            strokes per round, so a small leak you face five times a round outranks a big one you face once a month.
          </p>
        </div>
        <div className="yourgame-data">
          <span className="rounds-label">Data behind this page</span>
          <strong>{game.holes} holes</strong>
          <div className="rounds-progress" aria-hidden="true"><div style={{ width: `${progress}%` }} /></div>
          <span className="rounds-muted">
            {game.courses.length ? `${game.courses.join(', ')}. ` : ''}Test sessions left out. Firm calls start around 5 rounds.
          </span>
        </div>
      </header>

      {game.holes === 0 ? (
        <section className="rounds-section">
          <p className="rounds-muted">Play a round in GSPro with the companion running and this page fills in.</p>
        </section>
      ) : (
        <>
          <section className="rounds-section">
            <div className="rounds-section-head">
              <h2>Your biggest leaks</h2>
              <span className="rounds-muted">Strokes per round against your typical shot</span>
            </div>
            {game.leaks.length ? (
              <div className="yourgame-leaks">{game.leaks.map((s) => <SegmentCell key={s.id} segment={s} />)}</div>
            ) : (
              <p className="rounds-muted">Nothing costs you a tenth of a stroke a round yet, against your own typical shot.</p>
            )}
            {game.strengths.length ? (
              <div className="rounds-keyline yourgame-strengths">
                <span className="rounds-keyline-label is-hero">Holding up</span>
                <div className="rounds-keyline-shots">
                  {game.strengths.map((s) => (
                    <span className="yourgame-strength" key={s.id}>
                      <strong className={tone(s.perRound)}>{signed(s.perRound, 1)}</strong> {s.label}
                      <span className="rounds-muted"> · {s.shots} shots</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <section className="rounds-section">
            <div className="rounds-section-head">
              <h2>Approach and short game, by distance</h2>
              <span className="rounds-muted">
                Bar = strokes gained per shot vs tour. Gold line = your typical shot
                {game.typical != null ? ` (${signed(game.typical)})` : ''}.
              </span>
            </div>
            <div className="rounds-table-wrap yourgame-table-wrap">
              <table className="rounds-table yourgame-ladder">
                <thead>
                  <tr>
                    <th scope="col">Distance</th>
                    <th className="is-num" scope="col">Shots</th>
                    <th className="is-num" scope="col">On green</th>
                    <th className="is-num" scope="col">Avg leave</th>
                    <th className="yourgame-bar-head" scope="col">{MINUS}0.5 · per shot · +0.5</th>
                    <th className="is-num" scope="col">SG / shot</th>
                    <th scope="col">Data</th>
                  </tr>
                </thead>
                <tbody>{game.ladder.map((rung) => rungRow(rung, game.typical))}</tbody>
              </table>
            </div>
            <p className="rounds-muted yourgame-foot">Each dot is {SHOTS_PER_DOT} shots; five dots ({FIRM_SHOTS} shots) is a firm call.</p>
          </section>

          <div className="yourgame-pair">
            <section className="rounds-section">
              <div className="rounds-section-head">
                <h2>Last round vs your normal</h2>
                <span className="rounds-muted">
                  {game.vsNormal
                    ? `${game.vsNormal.courseName} against your earlier rounds (${game.vsNormal.normalHoles} holes).`
                    : 'Needs a second round to compare with.'}
                </span>
              </div>
              {game.vsNormal ? (
                <div className="yourgame-scroll">
                <table className="rounds-table yourgame-vs">
                  <thead>
                    <tr>
                      <th scope="col">Shot type</th>
                      <th className="is-num" scope="col">Shots</th>
                      <th className="yourgame-bar-head" scope="col">Per shot</th>
                      <th className="is-num" scope="col">Round</th>
                    </tr>
                  </thead>
                  <tbody>
                    {game.vsNormal.rows.map((row) => (
                      <tr key={row.label}>
                        <td><strong>{row.label}</strong></td>
                        <td className="is-num">{row.shots || '–'}</td>
                        <td className="yourgame-bar-cell"><PerShotBar value={row.perShot} /></td>
                        <td className={`is-num ${tone(row.roundTotal)}`}>{row.roundTotal != null ? signed(row.roundTotal, 1) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              ) : (
                <p className="rounds-muted">Once there are two rounds, the latest is set against the ones before it, shot type by shot type.</p>
              )}
            </section>

            <section className="rounds-section">
              <div className="rounds-section-head">
                <h2>Putting by length</h2>
                <span className="rounds-muted">
                  Inside the {GIMME_CIRCLE_FT}–6 ft gimme circle there&apos;s nothing to read
                  {game.gimmes ? ` (${game.gimmes} gimmes)` : ''}; rounds with auto putt on are left out.
                </span>
              </div>
              <div className="yourgame-scroll">
              <table className="rounds-table yourgame-putts">
                <thead>
                  <tr>
                    <th scope="col">Length</th>
                    <th className="is-num" scope="col">Made</th>
                    <th className="is-num" scope="col">SG / putt</th>
                    <th scope="col">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {game.putting.map((bucket) => (
                    <tr key={bucket.label}>
                      <td><strong>{bucket.label}</strong></td>
                      <td className="is-num">{bucket.putts ? `${bucket.made} of ${bucket.putts}` : '–'}</td>
                      <td className={`is-num ${tone(bucket.sgPerPutt)}`}>{bucket.sgPerPutt != null ? signed(bucket.sgPerPutt) : '–'}</td>
                      <td className="rounds-muted">{bucket.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </section>
          </div>

          <div className="yourgame-pair">
            <section className="rounds-section yourgame-coming">
              <div className="rounds-section-head">
                <h2>When you take some off</h2>
                <span className="yourgame-tag">Needs Live Caddie logging</span>
              </div>
              <p className="rounds-muted">
                Shots where the club you armed was longer than the carry Looper asked for, by how much you took off:
                do you come up short, and how often do you find the green? Without the armed club, a smooth 7-iron looks
                like a full 8-iron, so this fills in from Live Caddie rounds.
              </p>
            </section>
            <section className="rounds-section yourgame-coming">
              <div className="rounds-section-head">
                <h2>Off the tee by hole shape</h2>
                <span className="yourgame-tag">Coming</span>
              </div>
              <p className="rounds-muted">
                Fairways, misses and strokes gained on dogleg lefts, straight holes and dogleg rights, set against your
                stock shot shape.
              </p>
            </section>
          </div>

          <section className="yourgame-how rounds-muted">
            <strong>How this is worked out.</strong> Strokes gained per shot uses the PGA Tour baseline. Your typical shot is
            your average approach or short-game shot (no tee shots, no putts){game.typical != null ? `: ${signed(game.typical)} vs tour` : ''}.
            A leak is how far a shot type sits below that, times how often it comes up in 18 holes. As rounds build up, each
            shot type will be compared with your own history for that same shot instead.
          </section>
        </>
      )}
    </main>
  )
}
