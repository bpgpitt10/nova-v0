import type { DecisionRiskProfile } from './decisionRiskProfile'

export type PlayerFacingOutcomePercentages = {
  success: number
  manageable: number
  trouble: number
  catastrophe: number
}

const clampProbability = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0

/**
 * Build the four player-facing outcome buckets from the canonical risk profile.
 *
 * Internal `unknown` means the model landed outside the classified map area. That
 * is intentionally visible to the player as Trouble (and remains separately
 * visible as Outside Map Area in the detail/audit UI). The visible integer
 * percentages use largest-remainder rounding so the four displayed buckets always
 * sum to exactly 100% without hiding probability mass.
 */
export const buildPlayerFacingOutcomePercentages = (
  risk: DecisionRiskProfile | null | undefined,
): PlayerFacingOutcomePercentages | null => {
  if (!risk) return null

  const raw = [
    clampProbability(risk.success),
    clampProbability(risk.manageable),
    clampProbability(risk.seriousTrouble) + clampProbability(risk.unknown),
    clampProbability(risk.catastrophe),
  ]
  const total = raw.reduce((sum, value) => sum + value, 0)
  if (total <= 1e-12) {
    return { success: 0, manageable: 0, trouble: 0, catastrophe: 0 }
  }

  const exact = raw.map((value) => (value / total) * 100)
  const rounded = exact.map((value) => Math.floor(value))
  let remainder = 100 - rounded.reduce((sum, value) => sum + value, 0)

  const priority = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)

  for (let index = 0; index < priority.length && remainder > 0; index += 1) {
    rounded[priority[index].index] += 1
    remainder -= 1
  }

  return {
    success: rounded[0],
    manageable: rounded[1],
    trouble: rounded[2],
    catastrophe: rounded[3],
  }
}
