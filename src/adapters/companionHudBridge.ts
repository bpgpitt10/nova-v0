import type { LooperCompanionLiveObservations } from './looperCompanion'
import { dispatchGsproWindOcrObservation } from './gsproWindObservation'
import { dispatchGsproLieOcrObservation } from './gsproLieObservation'

/**
 * An existing ONE-SHOT pre-shot native capture already reads wind and lie.
 * Publish those fresh OCR values into the SAME event adapters as the optional
 * 16-second native polling mode, without starting any more native work.
 *
 * Crucially, the structured GSPro file can still refer to yesterday's final
 * shot while the captured GSPro HUD is current. Validate screenshot freshness
 * and HWND state instead of pretending the stale file establishes current wind.
 */
export const publishOneShotCompanionHud = (
  observation: LooperCompanionLiveObservations,
  nowMs = Date.now(),
): Readonly<{ wind: boolean; lie: boolean }> => {
  const absent = { wind: false, lie: false }
  const capturedMs = Date.parse(observation.observedAt ?? '')
  if (observation.status !== 'ready'
    || observation.gspro?.status !== 'connected'
    || observation.gspro.window?.minimized !== false
    || !Number.isFinite(capturedMs)
    || capturedMs > nowMs + 5_000
    || nowMs - capturedMs > 30_000) return absent

  const recentOcr = (timestamp: string | null | undefined) => {
    const timestampMs = Date.parse(timestamp ?? '')
    return Number.isFinite(timestampMs)
      && timestampMs >= capturedMs - 5_000
      && timestampMs <= nowMs + 5_000
      && nowMs - timestampMs <= 30_000
  }
  const wind = observation.ocr?.wind
  const lie = observation.ocr?.lie
  const sendWind = Boolean(wind?.status === 'READY'
    && Number.isFinite(wind.speedMph)
    && Number.isFinite(wind.directionDegrees)
    && recentOcr(wind.observedAt))
  const sendLie = Boolean(lie?.status === 'READY'
    && recentOcr(lie.observedAt)
    && (Number.isFinite(lie.upDownDegrees)
      || Number.isFinite(lie.leftRightDegrees)))
  if (sendWind && wind) dispatchGsproWindOcrObservation(wind)
  if (sendLie && lie) dispatchGsproLieOcrObservation(lie)
  return { wind: sendWind, lie: sendLie }
}
