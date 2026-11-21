import type { DecisionRiskProfile } from './decisionRiskProfile'
import { nextStateValueForAimCandidate, type RiskRankableAim } from './aimDecisionRanking'

/**
 * Up to three aim lines for one club, shown as pills on the shot map:
 * Best (the club's ranked pick), 2nd best (the next-lowest expected strokes on
 * a line that is really a different aim), and Safest (the least water/OB, then
 * the least serious trouble). Display only: ranking is unchanged.
 */
export const AIM_LINE_MIN_SEPARATION_YDS = 6
/** Safest must cut this much to be called safer; below it, Best is already the safe line. */
export const AIM_LINE_SAFER_CATASTROPHE_CUT = 0.01
export const AIM_LINE_SAFER_TROUBLE_CUT = 0.03
/**
 * What a safer line may cost before it stops being worth showing (Georgia Golf Club 2, 21 Nov:
 * "Safest" was 12 yd left of the pin, off the green, for 0.39 strokes, to trim sand from 24% to
 * 21%). A line that only trims sand or rough may cost this much; one that takes out water or OB,
 * more.
 */
export const AIM_LINE_SAFER_MAX_COST_TROUBLE = 0.15
export const AIM_LINE_SAFER_MAX_COST_CATASTROPHE = 0.35

export type AimLineKey = 'best' | 'second' | 'safest'

export type AimLineOption<T> = Readonly<{
  /** 'best' first; a line that is both 2nd best and safest appears once, as 'second' with alsoSafest. */
  key: AimLineKey
  alsoSafest: boolean
  candidate: T
  aimOffsetYds: number
  /** Expected strokes above the Best line (0 for Best). */
  costStrokes: number
  catastrophe: number
  seriousTrouble: number
}>

type AimLineCandidate = RiskRankableAim & { aimOffsetYds: number; riskProfile?: DecisionRiskProfile | null }

export const pickAimLineOptions = <T extends AimLineCandidate>(
  candidates: readonly T[],
  best: T | null | undefined,
): AimLineOption<T>[] => {
  if (!best) return []
  const scored = candidates.flatMap((candidate) => {
    const risk = candidate.riskProfile
    const strokes = nextStateValueForAimCandidate(candidate)?.expectedFutureStrokes
    if (!risk || strokes == null || !Number.isFinite(strokes)) return []
    return [{ candidate, strokes, catastrophe: risk.catastrophe, seriousTrouble: risk.seriousTrouble }]
  })
  const bestRow = scored.find((row) => row.candidate.aimOffsetYds === best.aimOffsetYds)
  if (!bestRow) return []
  const option = (row: typeof bestRow, key: AimLineKey, alsoSafest: boolean): AimLineOption<T> => ({
    key, alsoSafest, candidate: row.candidate, aimOffsetYds: row.candidate.aimOffsetYds,
    costStrokes: Math.max(0, row.strokes - bestRow.strokes),
    catastrophe: row.catastrophe, seriousTrouble: row.seriousTrouble,
  })
  const apart = scored.filter((row) =>
    Math.abs(row.candidate.aimOffsetYds - bestRow.candidate.aimOffsetYds) >= AIM_LINE_MIN_SEPARATION_YDS - 1e-9)
  const byStrokes = (a: typeof bestRow, b: typeof bestRow) =>
    a.strokes - b.strokes || Math.abs(a.candidate.aimOffsetYds) - Math.abs(b.candidate.aimOffsetYds)
  const second = [...apart].sort(byStrokes)[0] ?? null
  // Safest: least water/OB, then least serious trouble, then fewest strokes.
  const bySafety = (a: typeof bestRow, b: typeof bestRow) =>
    (Math.abs(a.catastrophe - b.catastrophe) > 0.005 ? a.catastrophe - b.catastrophe : 0)
    || (Math.abs(a.seriousTrouble - b.seriousTrouble) > 0.005 ? a.seriousTrouble - b.seriousTrouble : 0)
    || byStrokes(a, b)
  // A safer line has to be worth its price: cut water/OB within the bigger allowance, or cut
  // serious trouble (without adding water) within the smaller one. The safest of those is shown.
  const worthIt = (row: typeof bestRow) => {
    const cost = row.strokes - bestRow.strokes
    const cutsCatastrophe = bestRow.catastrophe - row.catastrophe >= AIM_LINE_SAFER_CATASTROPHE_CUT - 1e-9
    const cutsTrouble = row.catastrophe <= bestRow.catastrophe + 0.005
      && bestRow.seriousTrouble - row.seriousTrouble >= AIM_LINE_SAFER_TROUBLE_CUT - 1e-9
    return (cutsCatastrophe && cost <= AIM_LINE_SAFER_MAX_COST_CATASTROPHE + 1e-9)
      || (cutsTrouble && cost <= AIM_LINE_SAFER_MAX_COST_TROUBLE + 1e-9)
  }
  const safest = apart.filter(worthIt).sort(bySafety)[0] ?? null

  const options: AimLineOption<T>[] = [option(bestRow, 'best', safest == null)]
  if (second) options.push(option(second, 'second', safest === second))
  if (safest && safest !== second) options.push(option(safest, 'safest', true))
  return options
}
