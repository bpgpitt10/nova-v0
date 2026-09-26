export const LIVE_CADDIE_START_ROUND_EVENT = 'looper:live-caddie-start-round'
export const LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT = 'looper:live-caddie-shot-state-changed'

export type LiveCaddieStartRoundDetail = {
  startedAt: string
}

export type LiveCaddieShotStateChangedDetail = {
  key: string
  holeNumber: number | null
  nextShotNumber: number | null
  source: 'manual-start' | 'gspro'
}

export const startLiveCaddieRound = () => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<LiveCaddieStartRoundDetail>(LIVE_CADDIE_START_ROUND_EVENT, {
    detail: { startedAt: new Date().toISOString() },
  }))
}

export const dispatchLiveCaddieShotStateChanged = (
  detail: LiveCaddieShotStateChangedDetail,
) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<LiveCaddieShotStateChangedDetail>(
    LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT,
    { detail },
  ))
}
