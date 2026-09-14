import type {
  CourseSurfaceClassification,
  CourseSurfaceKind,
  TacticalSurfaceSemantics,
} from './types'

export const TACTICAL_SURFACE_SEMANTICS: Readonly<
  Record<CourseSurfaceClassification, TacticalSurfaceSemantics>
> = {
  tee: {
    label: 'Tee',
    severity: 0,
    playable: true,
    preferred: true,
    countsAsTrouble: false,
    countsAsPenalty: false,
  },
  fairway: {
    label: 'Fairway',
    severity: 0,
    playable: true,
    preferred: true,
    countsAsTrouble: false,
    countsAsPenalty: false,
  },
  green: {
    label: 'Green',
    severity: 0,
    playable: true,
    preferred: true,
    countsAsTrouble: false,
    countsAsPenalty: false,
  },
  rough: {
    label: 'Rough',
    severity: 1,
    playable: true,
    preferred: false,
    countsAsTrouble: false,
    countsAsPenalty: false,
  },
  'deep-rough': {
    label: 'Deep rough / woods',
    severity: 3,
    playable: true,
    preferred: false,
    countsAsTrouble: true,
    countsAsPenalty: false,
  },
  bunker: {
    label: 'Bunker',
    severity: 3,
    playable: true,
    preferred: false,
    countsAsTrouble: true,
    countsAsPenalty: false,
  },
  water: {
    label: 'Water',
    severity: 5,
    playable: false,
    preferred: false,
    countsAsTrouble: true,
    countsAsPenalty: true,
  },
  penalty: {
    label: 'Penalty area',
    severity: 5,
    playable: false,
    preferred: false,
    countsAsTrouble: true,
    countsAsPenalty: true,
  },
  unknown: {
    label: 'Unknown / unmapped',
    severity: 2,
    playable: false,
    preferred: false,
    countsAsTrouble: false,
    countsAsPenalty: false,
  },
}

export const SURFACE_CLASSIFICATION_PRECEDENCE: readonly CourseSurfaceKind[] = [
  'water',
  'penalty',
  'bunker',
  'deep-rough',
  'green',
  'tee',
  'fairway',
  'rough',
]

type RawOsmTags = Readonly<Record<string, string | undefined>>

/**
 * Translate source-map semantics into Looper's tactical vocabulary.
 *
 * Important: OSM golf=rough remains ordinary rough. Woods/forest/scrub are
 * elevated separately to deep-rough because Looper cares about tactical
 * severity, not just the source cartography label.
 */
export function tacticalSurfaceFromOsmTags(tags: RawOsmTags): CourseSurfaceKind | null {
  const golf = tags.golf
  const natural = tags.natural
  const landuse = tags.landuse

  if (golf === 'tee') return 'tee'
  if (golf === 'fairway') return 'fairway'
  if (golf === 'green') return 'green'
  if (golf === 'bunker') return 'bunker'
  if (golf === 'rough') return 'rough'

  if (golf === 'water_hazard' || golf === 'lateral_water_hazard') return 'penalty'
  if (natural === 'water' || tags.waterway) return 'water'

  if (
    natural === 'wood' ||
    natural === 'scrub' ||
    landuse === 'forest' ||
    landuse === 'wood'
  ) {
    return 'deep-rough'
  }

  return null
}
