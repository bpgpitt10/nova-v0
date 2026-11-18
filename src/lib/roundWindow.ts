import type { RoundSummary } from './roundHistory'

/**
 * Which rounds a stats page looks at. Old golf should fade out without a decay
 * model (Brian, 18 Nov): the default is the last six months, with no cap on
 * rounds, and the most recent 5 or 15 or everything one tap away.
 */
export type RoundWindow = 'recent' | 'five' | 'fifteen' | 'all'

/** "Recent" reaches this many months back. */
export const RECENT_MONTHS = 6
/** Fewer rounds than this in the window is an early read. */
export const EARLY_READ_ROUNDS = 3

export const ROUND_WINDOWS: readonly (readonly [RoundWindow, string])[] = [
  ['recent', `Last ${RECENT_MONTHS} months`],
  ['five', 'Last 5'],
  ['fifteen', 'Last 15'],
  ['all', 'All'],
]

type WindowRound = Pick<RoundSummary, 'counts' | 'completeHoles' | 'playedAt'>

/**
 * The counting rounds inside a window, newest first. `eligible` narrows what a
 * page can use at all (Putting: rounds with real putts), so "Last 5" means the
 * last five rounds that page can say something about.
 */
export const roundsInWindow = <T extends WindowRound>(
  rounds: readonly T[],
  window: RoundWindow,
  now: Date = new Date(),
  eligible: (round: T) => boolean = () => true,
): T[] => {
  const usable = rounds
    .filter((round) => round.counts && round.completeHoles > 0 && eligible(round))
    .sort((a, b) => (b.playedAt ?? '').localeCompare(a.playedAt ?? ''))
  if (window === 'all') return usable
  if (window === 'five') return usable.slice(0, 5)
  if (window === 'fifteen') return usable.slice(0, 15)
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - RECENT_MONTHS)
  return usable.filter((round) => round.playedAt != null && new Date(round.playedAt).getTime() >= cutoff.getTime())
}

/** Open on the last six months; with nothing that recent, on everything. */
export const defaultRoundWindow = <T extends WindowRound>(
  rounds: readonly T[],
  now: Date = new Date(),
  eligible?: (round: T) => boolean,
): RoundWindow => (roundsInWindow(rounds, 'recent', now, eligible).length ? 'recent' : 'all')

/** "3 rounds in the last 6 months", "your last 5 rounds", "all 22 rounds". */
export const describeRoundWindow = (window: RoundWindow, count: number) => {
  const rounds = `${count} ${count === 1 ? 'round' : 'rounds'}`
  if (window === 'recent') return `${rounds} in the last ${RECENT_MONTHS} months`
  if (window === 'all') return count === 1 ? 'your 1 round' : `all ${rounds}`
  return count === 1 ? 'your last round' : `your last ${rounds}`
}
