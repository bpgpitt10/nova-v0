/**
 * The four player-facing outcome tiles. Every simulated shot lands in exactly
 * one: landings past the edge of the mapped hole ("Outside Map Area") count as
 * Trouble, so the tiles cover all of them. Whole percentages are rounded so
 * they add up to 100 (largest remainder); a bucket with any probability that
 * rounds to 0 shows "<1%".
 */
export type OutcomeRisk = Readonly<{
  success: number
  manageable: number
  seriousTrouble: number
  catastrophe: number
  unknown: number
}>

export type OutcomeTile = Readonly<{ label: string; percent: number; text: string }>

export const outcomeTiles = (risk: OutcomeRisk | null | undefined): OutcomeTile[] | null => {
  if (!risk) return null
  const raw = [
    ['Success', risk.success],
    ['Manageable', risk.manageable],
    ['Trouble', risk.seriousTrouble + risk.unknown],
    ['Catastrophe', risk.catastrophe],
  ] as const
  const values = raw.map(([, value]) => (Number.isFinite(value) ? Math.max(0, value) : 0))
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return null
  const exact = values.map((value) => (value / total) * 100)
  const floors = exact.map(Math.floor)
  let left = 100 - floors.reduce((sum, value) => sum + value, 0)
  exact
    .map((value, index) => ({ index, remainder: value - floors[index] }))
    .sort((a, b) => b.remainder - a.remainder)
    .forEach(({ index }) => {
      if (left > 0) { floors[index] += 1; left -= 1 }
    })
  return raw.map(([label], index) => ({
    label,
    percent: floors[index],
    text: floors[index] === 0 && values[index] > 0 ? '<1%' : `${floors[index]}%`,
  }))
}
