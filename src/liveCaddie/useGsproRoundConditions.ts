import { useEffect, useState } from 'react'
import {
  GSPRO_LOG_CONDITIONS_EVENT,
  latestGsproLogConditions,
  type GsproLogConditions,
} from '../adapters/gsproLogConditions'
import { rememberRoundConditions, type Firmness } from './roundConditions'
import {
  applyGsproConditionsToActiveRound,
  LIVE_CADDIE_START_ROUND_EVENT,
  loadActiveLiveCaddieRound,
} from './roundRuntime'

export type RoundPhysicsConditions = Readonly<{
  fairwayConditions: { courseType: Firmness; fairwayFirmness: Firmness } | null
  greenConditions: { courseType: Firmness; greenFirmness: Firmness; stimp: number | null } | null
  /** GSPro's own altitude for the round, once a shot has landed. */
  gsproAltitudeFt: number | null
  /** True when the settings are GSPro's own rather than picked at Start a Round. */
  fromGspro: boolean
}>

const fromActiveRound = (): RoundPhysicsConditions => {
  const round = loadActiveLiveCaddieRound()
  const picked = round?.conditions
  return {
    fairwayConditions: picked?.courseType && picked.fairwayFirmness
      ? { courseType: picked.courseType, fairwayFirmness: picked.fairwayFirmness } : null,
    greenConditions: picked?.courseType && picked.greenFirmness
      ? { courseType: picked.courseType, greenFirmness: picked.greenFirmness, stimp: picked.stimp ?? null } : null,
    gsproAltitudeFt: round?.gsproAltitudeFt ?? null,
    fromGspro: round?.conditionsFromGspro === true,
  }
}

const sameConditions = (a: RoundPhysicsConditions, b: RoundPhysicsConditions) =>
  a.fromGspro === b.fromGspro && a.gsproAltitudeFt === b.gsproAltitudeFt
    && a.fairwayConditions?.courseType === b.fairwayConditions?.courseType
    && a.fairwayConditions?.fairwayFirmness === b.fairwayConditions?.fairwayFirmness
    && a.greenConditions?.courseType === b.greenConditions?.courseType
    && a.greenConditions?.greenFirmness === b.greenConditions?.greenFirmness
    && a.greenConditions?.stimp === b.greenConditions?.stimp

/**
 * The round's course type, firmness and altitude for the roll, green and
 * flight models. They start as picked at Start a Round. Once GSPro logs a shot
 * of this round (one hit after the round started), its own settings replace them and are kept on the round, so a
 * page reload doesn't go back to the picks.
 */
export const useGsproRoundConditions = (): RoundPhysicsConditions => {
  const [conditions, setConditions] = useState(fromActiveRound)
  useEffect(() => {
    const take = (seen: GsproLogConditions | null) => {
      if (!seen) return
      const round = applyGsproConditionsToActiveRound(seen)
      if (round?.conditions) rememberRoundConditions(round.courseId, round.conditions)
      const next = fromActiveRound()
      setConditions((current) => (sameConditions(current, next) ? current : next))
    }
    take(latestGsproLogConditions())
    const onSeen = (event: Event) => take((event as CustomEvent<GsproLogConditions>).detail ?? null)
    // A new round starts on its own picks, not the last round's GSPro settings.
    const onStart = () => {
      const next = fromActiveRound()
      setConditions((current) => (sameConditions(current, next) ? current : next))
    }
    window.addEventListener(GSPRO_LOG_CONDITIONS_EVENT, onSeen)
    window.addEventListener(LIVE_CADDIE_START_ROUND_EVENT, onStart)
    return () => {
      window.removeEventListener(GSPRO_LOG_CONDITIONS_EVENT, onSeen)
      window.removeEventListener(LIVE_CADDIE_START_ROUND_EVENT, onStart)
    }
  }, [])
  return conditions
}
