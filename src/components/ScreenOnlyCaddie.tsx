import { useEffect, useMemo, useState } from 'react'
import { readLooperCompanionObservations } from '../adapters/looperCompanion'
import { getClubLabel, type Club } from '../lib/bagConfig'
import { loadSavedSessions, SESSION_HISTORY_UPDATED_EVENT } from '../lib/sessions'
import { useQuickBagPrior } from '../lib/useQuickBag'
import type { ScreenOnlyReading } from '../liveCaddie/screenOnlyHole'
import { useScreenOnlyCaddie } from '../liveCaddie/useScreenOnlyCaddie'
import './ScreenOnlyCaddie.css'

/**
 * Screen-only caddie: club and aim from what the sim's screen shows, with no
 * map and no course file. Reads the companion's screen observations when it's
 * running (distance, pin height, lie, slope), or takes typed numbers, so it
 * can be tried anywhere.
 */

const POLL_MS = 6000
const FRESH_MS = 30_000

type Observed = Readonly<{ reading: ScreenOnlyReading; source: string; at: number }>

const signedFt = (ft: number) => `${ft > 0 ? '+' : ft < 0 ? '−' : ''}${Math.abs(Math.round(ft))} ft`

const parseNum = (value: string): number | null => {
  const n = Number(value)
  return value.trim() !== '' && Number.isFinite(n) ? n : null
}

export default function ScreenOnlyCaddie({ companionConnected }: { companionConnected: boolean }) {
  const [sessions, setSessions] = useState(() => loadSavedSessions())
  const quickBag = useQuickBagPrior()
  const [observed, setObserved] = useState<Observed | null>(null)
  const [typed, setTyped] = useState({ distance: '', elevation: '', surface: 'fairway', onTee: false })

  useEffect(() => {
    const refresh = () => setSessions(loadSavedSessions())
    window.addEventListener(SESSION_HISTORY_UPDATED_EVENT, refresh)
    return () => window.removeEventListener(SESSION_HISTORY_UPDATED_EVENT, refresh)
  }, [])

  // Read the sim's screen through the companion while it's connected.
  useEffect(() => {
    if (!companionConnected) return
    let alive = true
    let pending = false
    const read = async () => {
      if (pending || !alive || document.hidden) return
      pending = true
      try {
        const obs = await readLooperCompanionObservations(20000, false)
        if (!alive) return
        const hud = obs.ocr?.hud
        if (hud?.status !== 'READY' || hud.distanceToPinYds == null) return
        const lie = obs.ocr?.lie
        const lieReady = lie?.status === 'READY'
        const surface = lieReady && lie?.surface ? lie.surface.toLowerCase() : null
        setObserved({
          source: 'GSPro screen',
          at: Date.now(),
          reading: {
            distanceToPinYds: hud.distanceToPinYds,
            elevationFt: hud.elevationFt ?? null,
            surface,
            lieUpDownDeg: lieReady && typeof lie?.upDownDegrees === 'number' ? lie.upDownDegrees : null,
            lieLeftRightDeg: lieReady && typeof lie?.leftRightDegrees === 'number' ? -lie.leftRightDegrees : null,
            // GSPro's wind box gives a compass direction; with no map Looper
            // doesn't know which way the hole points, so wind isn't applied yet.
            windMph: obs.ocr?.wind?.status === 'READY' ? obs.ocr.wind.speedMph ?? null : null,
            windRelativeDeg: null,
            onTee: hud.shotNumber === 1,
          },
        })
      } catch {
        // Companion busy or GSPro not on a shot: keep the last reading.
      } finally {
        pending = false
      }
    }
    void read()
    const timer = window.setInterval(() => { void read() }, POLL_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [companionConnected])

  const typedReading = useMemo<ScreenOnlyReading | null>(() => {
    const distance = parseNum(typed.distance)
    if (distance == null) return null
    return {
      distanceToPinYds: distance,
      elevationFt: parseNum(typed.elevation),
      surface: typed.onTee ? 'tee' : typed.surface,
      onTee: typed.onTee,
    }
  }, [typed])

  const fresh = observed && Date.now() - observed.at < FRESH_MS ? observed : null
  const reading = typedReading ?? fresh?.reading ?? null
  const source = typedReading ? 'typed' : fresh?.source ?? null
  const state = useScreenOnlyCaddie(reading, sessions, quickBag)
  const advice = state.advice

  return (
    <section className="screen-only" aria-label="Screen-only caddie">
      <span className="live-kicker">NO MAP · SCREEN ONLY</span>
      <h2>Club and aim from what the screen shows</h2>
      <p className="screen-only-lead">
        Distance, pin height and lie from the sim's screen, your bag's numbers and dispersion. No hazards: Looper
        can't see them without a map.
      </p>

      {advice ? (
        <div className="screen-only-pick" data-state={state.status}>
          <div className="screen-only-club">
            <strong>{getClubLabel(advice.club as Club)}</strong>
            {advice.closeClub ? <span>or {getClubLabel(advice.closeClub as Club)}, a close call</span> : null}
          </div>
          <div className="screen-only-lines">
            <p><strong>Plays {advice.playsLikeYds} yd</strong>
              {advice.adjustments.length ? (
                <span> ({reading?.distanceToPinYds != null ? `${Math.round(reading.distanceToPinYds)} yd` : ''}
                  {advice.adjustments.map((a) => `, ${a.label} ${a.yds > 0 ? '+' : ''}${a.yds}`).join('')})</span>
              ) : null}
            </p>
            <p><strong>{advice.aimText}</strong></p>
            {advice.missing.length ? (
              <p className="screen-only-fine">Not read: {advice.missing.join(', ')}.</p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="screen-only-waiting">
          {state.status === 'working' ? 'Working it out…'
            : state.error ? state.error
              : companionConnected ? 'Waiting for the sim to show a shot (distance to the pin).'
                : 'Type a distance below to try it.'}
        </p>
      )}

      {reading ? (
        <p className="screen-only-fine">
          From {source}: {reading.distanceToPinYds != null ? `${Math.round(reading.distanceToPinYds)} yd` : '–'}
          {reading.elevationFt != null ? ` · pin ${signedFt(reading.elevationFt)}` : ''}
          {reading.surface ? ` · ${reading.surface}` : ''}
          {reading.lieUpDownDeg ? ` · ${reading.lieUpDownDeg > 0 ? 'uphill' : 'downhill'} lie ${Math.abs(reading.lieUpDownDeg).toFixed(1)}°` : ''}
          {reading.windMph != null ? ` · wind ${Math.round(reading.windMph)} mph (direction not used yet)` : ''}
        </p>
      ) : null}

      <details className="screen-only-type" open={!companionConnected}>
        <summary>Type the numbers instead</summary>
        <div className="screen-only-form">
          <label>
            <span>To the pin</span>
            <input inputMode="numeric" onChange={(e) => setTyped((t) => ({ ...t, distance: e.target.value }))}
              placeholder="150" type="number" value={typed.distance} />
            <em>yd</em>
          </label>
          <label>
            <span>Pin height</span>
            <input inputMode="numeric" onChange={(e) => setTyped((t) => ({ ...t, elevation: e.target.value }))}
              placeholder="+12 or −8" type="number" value={typed.elevation} />
            <em>ft</em>
          </label>
          <label>
            <span>Lie</span>
            <select disabled={typed.onTee} onChange={(e) => setTyped((t) => ({ ...t, surface: e.target.value }))}
              value={typed.surface}>
              <option value="fairway">Fairway</option>
              <option value="rough">Rough</option>
              <option value="deep-rough">Deep rough</option>
              <option value="bunker">Bunker</option>
            </select>
          </label>
          <label className="screen-only-check">
            <input checked={typed.onTee} onChange={(e) => setTyped((t) => ({ ...t, onTee: e.target.checked }))}
              type="checkbox" />
            <span>On the tee</span>
          </label>
        </div>
      </details>
    </section>
  )
}
