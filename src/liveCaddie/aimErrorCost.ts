import { nextStateValueForAimCandidate, type RiskRankableAim } from './aimDecisionRanking'

/**
 * What an aim click that lands up to `errorYds` off the meant line would cost,
 * for this club and target, in expected strokes.
 *
 * Before the first shot on a hole the pin is often only estimated, and Auto
 * Aim lines the minimap up on ball and pin, so the click can be a few yards
 * off. A fixed 3 yd limit treated a drive to a 33 yd fairway like a wedge to
 * a tucked pin (Valhalla 1, 11/8: Aim by hand for a 5 yd worst case). The
 * engine already has the expected strokes at every aim on a 3 yd grid, so the
 * error is priced from them: shift the aim by the error both ways, read the
 * strokes (linear between grid points), and take the worse side.
 */
export type AimErrorCost = Readonly<{
  /** Expected strokes added by the worst-case error, against the chosen aim. */
  strokes: number
  /** Catastrophe probability added by the worst-case error. */
  catastrophe: number
  /** The error is affordable for this shot. */
  affordable: boolean
  /** Why not, when it isn't. */
  reason: 'affordable' | 'too-costly' | 'off-the-grid' | 'unpriced'
}>

/** One aim step of a well-chosen target; anything smaller is noise in the model. */
export const AIM_ERROR_MAX_COST_STROKES = 0.03
export const AIM_ERROR_MAX_CATASTROPHE_INCREASE = 0.01

type Priced = { offset: number; strokes: number; catastrophe: number }

const priceCandidate = (candidate: RiskRankableAim): Priced | null => {
  const value = nextStateValueForAimCandidate(candidate)
  if (value?.expectedFutureStrokes == null || !Number.isFinite(value.expectedFutureStrokes)) return null
  return {
    offset: candidate.aimOffsetYds,
    strokes: value.expectedFutureStrokes,
    catastrophe: candidate.riskProfile?.catastrophe ?? 0,
  }
}

const at = (priced: readonly Priced[], offset: number): Priced | null => {
  // Linear between the two grid points around `offset`; null outside the grid.
  let below: Priced | null = null
  let above: Priced | null = null
  for (const p of priced) {
    if (p.offset <= offset && (!below || p.offset > below.offset)) below = p
    if (p.offset >= offset && (!above || p.offset < above.offset)) above = p
  }
  if (!below || !above) return null
  if (above.offset === below.offset) return below
  const t = (offset - below.offset) / (above.offset - below.offset)
  return {
    offset,
    strokes: below.strokes + (above.strokes - below.strokes) * t,
    catastrophe: below.catastrophe + (above.catastrophe - below.catastrophe) * t,
  }
}

export const priceAimError = ({ candidates, chosenOffsetYds, errorYds }: Readonly<{
  candidates: readonly RiskRankableAim[]
  chosenOffsetYds: number
  errorYds: number
}>): AimErrorCost => {
  if (!Number.isFinite(errorYds) || errorYds < 0) return { strokes: NaN, catastrophe: NaN, affordable: false, reason: 'unpriced' }
  const priced = candidates.map(priceCandidate).filter((p): p is Priced => p !== null)
  const chosen = at(priced, chosenOffsetYds)
  if (!chosen) return { strokes: NaN, catastrophe: NaN, affordable: false, reason: 'unpriced' }
  const left = at(priced, chosenOffsetYds - errorYds)
  const right = at(priced, chosenOffsetYds + errorYds)
  if (!left || !right) return { strokes: NaN, catastrophe: NaN, affordable: false, reason: 'off-the-grid' }
  const strokes = Math.max(left.strokes, right.strokes) - chosen.strokes
  const catastrophe = Math.max(left.catastrophe, right.catastrophe) - chosen.catastrophe
  const affordable = strokes <= AIM_ERROR_MAX_COST_STROKES && catastrophe <= AIM_ERROR_MAX_CATASTROPHE_INCREASE
  return { strokes, catastrophe, affordable, reason: affordable ? 'affordable' : 'too-costly' }
}
