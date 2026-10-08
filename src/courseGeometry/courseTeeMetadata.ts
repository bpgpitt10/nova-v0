import type { CourseId } from './courseCatalog'
import type { CourseTeeCandidate } from './types'

type TeeSlotMetadata = Readonly<{
  teeSet: string
  color: string
  aliases: readonly string[]
}>

const normalize = (value: string | null | undefined) =>
  value?.trim().replace(/\s+/g, ' ').toLowerCase() ?? ''

/**
 * OSM frequently maps tee polygons without the course's user-facing tee identity.
 * Keep reviewed course metadata separate from geometry: geometry stays OSM-derived,
 * while these aliases only enrich the selectable tee-set names.
 */
const FARMLINKS_TEE_SLOTS = new Map<string, TeeSlotMetadata>([
  ['tee 1 (back)', {
    teeSet: 'Black',
    color: 'Black',
    aliases: ['Longhorn'],
  }],
  ['tee 1', {
    teeSet: 'Black',
    color: 'Black',
    aliases: ['Longhorn'],
  }],
  ['tee 2', {
    teeSet: 'Gold',
    color: 'Gold',
    aliases: ['Copperhead', 'Copper', 'Yellow'],
  }],
  ['tee 3', {
    teeSet: 'White',
    color: 'White',
    aliases: ['Whitetail'],
  }],
  ['tee 4', {
    teeSet: 'Green',
    color: 'Green',
    aliases: ['Bobcat'],
  }],
  ['tee 5 (front)', {
    teeSet: 'Red',
    color: 'Red',
    aliases: ['Quail'],
  }],
  ['tee 5', {
    teeSet: 'Red',
    color: 'Red',
    aliases: ['Quail'],
  }],
])

const metadataFor = (
  courseId: CourseId,
  label: string | null | undefined,
): TeeSlotMetadata | null => {
  if (courseId !== 'farmlinks-pursell-farms-sylacauga-al') return null
  return FARMLINKS_TEE_SLOTS.get(normalize(label)) ?? null
}

const unique = (values: readonly (string | null | undefined)[]) =>
  [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))]

export const applyCourseTeeMetadata = (
  courseId: CourseId,
  candidates: readonly CourseTeeCandidate[],
): readonly CourseTeeCandidate[] =>
  candidates.map((candidate) => {
    const originalLabels = unique([
      candidate.teeSet,
      ...(candidate.teeAliases ?? []),
    ])
    const primaryMetadata = metadataFor(courseId, candidate.teeSet)
    const mappedMetadata = originalLabels
      .map((label) => metadataFor(courseId, label))
      .filter((value): value is TeeSlotMetadata => Boolean(value))

    if (!primaryMetadata && mappedMetadata.length === 0) return candidate

    const teeSet = primaryMetadata?.teeSet ?? candidate.teeSet
    const teeAliases = unique([
      teeSet,
      ...(primaryMetadata?.aliases ?? []),
      ...mappedMetadata.flatMap((metadata) => [metadata.teeSet, ...metadata.aliases]),
      ...originalLabels,
    ])

    return {
      ...candidate,
      ...(teeSet ? { teeSet } : {}),
      ...(teeAliases.length ? { teeAliases } : {}),
      ...(primaryMetadata?.color ? { color: primaryMetadata.color } : {}),
      ...(primaryMetadata?.teeSet ? { label: primaryMetadata.teeSet } : {}),
    }
  })
