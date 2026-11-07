import { useEffect, useMemo, useRef, useState } from 'react'
import type { SavedSession } from '../types'
import type { QuickBagPrior } from '../lib/quickBag'
import type { ClubAimEvaluation } from './aimOptimization'
import {
  screenOnlyAdvice,
  screenOnlyHole,
  type ScreenOnlyAdvice,
  type ScreenOnlyReading,
} from './screenOnlyHole'

/**
 * Runs the engine on the screen-only stand-in hole in a worker (about a second
 * per reading), once per distinct reading.
 */

export type ScreenOnlyState = Readonly<{
  status: 'idle' | 'working' | 'ready' | 'error'
  advice: ScreenOnlyAdvice | null
  evaluations: readonly ClubAimEvaluation[]
  error: string | null
}>

const readingKey = (r: ScreenOnlyReading) => JSON.stringify([
  r.distanceToPinYds == null ? null : Math.round(r.distanceToPinYds),
  r.elevationFt == null ? null : Math.round(r.elevationFt),
  r.surface ?? null,
  r.lieUpDownDeg == null ? null : Math.round(r.lieUpDownDeg * 2) / 2,
  r.lieLeftRightDeg == null ? null : Math.round(r.lieLeftRightDeg * 2) / 2,
  r.windMph == null ? null : Math.round(r.windMph),
  r.windRelativeDeg == null ? null : Math.round(r.windRelativeDeg / 5) * 5,
  r.onTee === true,
])

export const useScreenOnlyCaddie = (
  reading: ScreenOnlyReading | null,
  sessions: readonly SavedSession[],
  quickBag: QuickBagPrior | null,
): ScreenOnlyState => {
  const [state, setState] = useState<ScreenOnlyState>({ status: 'idle', advice: null, evaluations: [], error: null })
  const key = reading ? readingKey(reading) : null
  const quickBagKey = quickBag ? quickBag.input.savedAt : null
  const workerRef = useRef<Worker | null>(null)
  const latest = useMemo(() => reading, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    workerRef.current?.terminate()
    workerRef.current = null
  }, [])

  useEffect(() => {
    const r = latest
    if (!r || r.distanceToPinYds == null || !Number.isFinite(r.distanceToPinYds) || r.distanceToPinYds < 5) {
      setState({ status: 'idle', advice: null, evaluations: [], error: null })
      return
    }
    const hole = screenOnlyHole({ distanceToPinYds: r.distanceToPinYds, onTee: r.onTee })
    const pin = hole.markers.pin!
    workerRef.current?.terminate()
    const worker = new Worker(new URL('../pages/LiveCaddieWorker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    setState((s) => ({ ...s, status: 'working', error: null }))
    let done = false
    worker.onmessage = (event: MessageEvent<{ type: 'success'; evaluations: ClubAimEvaluation[] } | { type: 'error'; error: string }>) => {
      done = true
      const message = event.data
      if (message.type === 'error') {
        setState({ status: 'error', advice: null, evaluations: [], error: message.error })
      } else {
        const ranked = message.evaluations
          .filter((e) => e.decisionRank != null)
          .sort((a, b) => (a.decisionRank ?? 99) - (b.decisionRank ?? 99))
        const advice = ranked[0] ? screenOnlyAdvice(r, ranked[0], ranked[1] ?? null) : null
        setState({ status: advice ? 'ready' : 'error', advice, evaluations: ranked,
          error: advice ? null : 'No club in your bag has numbers yet.' })
      }
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
    }
    worker.onerror = (event) => {
      done = true
      setState({ status: 'error', advice: null, evaluations: [], error: event.message || 'Worker failed.' })
    }
    worker.postMessage({
      sessions,
      hole,
      ball: [0, 0],
      target: pin,
      environment: {
        quickBag,
        exactPinLocalYds: pin,
        elevationDeltaFt: r.elevationFt ?? null,
        elevationSource: r.elevationFt == null ? undefined : 'screen',
        // Wind only when its direction against the shot is known.
        windMph: r.windMph != null && r.windRelativeDeg != null ? r.windMph : 0,
        windRelativeDeg: r.windRelativeDeg ?? 0,
        surfaceOverride: r.surface ?? (r.onTee ? 'tee' : null),
        shotOrigin: r.onTee ? 'tee' : 'non-tee',
        lieUpDownDeg: r.lieUpDownDeg ?? null,
        lieLeftRightDeg: r.lieLeftRightDeg ?? null,
        lieSource: 'screen',
      },
      nowMs: Date.now(),
    })
    return () => {
      if (!done) worker.terminate()
    }
  }, [latest, sessions, quickBagKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return state
}
