import type { CourseSurfaceClassification } from '../courseGeometry/types'
import type { AimPureFinish } from './aimOptimization'

/**
 * One card line when flushing this club gets the golfer in trouble.
 *
 * The decision already accounts for flushed shots (the core is the player's
 * real shot shape). This only explains it, using the same Pure number as the
 * yardage book, so the golfer sees why a club that "looks right" at Stock was
 * passed over, or what to watch for with the one that was picked.
 */
const TROUBLE_WORDS: Partial<Record<CourseSurfaceClassification, string>> = {
  bunker: 'a bunker',
  water: 'the water',
  penalty: 'the hazard',
  'deep-rough': 'the trees / deep rough',
}

export const pureFinishRead = ({
  club,
  pureFinish,
}: {
  club: string | null | undefined
  pureFinish: AimPureFinish | null | undefined
}): string | null => {
  if (!club || !pureFinish) return null
  const trouble = TROUBLE_WORDS[pureFinish.kind]
  if (!trouble) return null
  return `Flush it (your Pure ${club}, ${Math.round(pureFinish.carryYds)} carry) and it finishes in ${trouble}.`
}
