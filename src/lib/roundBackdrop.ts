/**
 * Rounds backdrop: a painted scene that fits the course.
 *
 * The course's essence comes from the GSPro course designer's own style tags
 * in the GKD (KeywordLinks, KeywordMountain, ...; read by companion courses.8+
 * and kept in live_course_info.style_keywords), then altitude, then the
 * player's override. Courses with nothing to go on keep the links scene.
 */

export const BACKDROPS = ['links', 'parkland', 'mountain', 'coastal', 'desert', 'heathland', 'tropical'] as const
export type Backdrop = (typeof BACKDROPS)[number]

export const BACKDROP_LABEL: Record<Backdrop, string> = {
  links: 'Links',
  parkland: 'Parkland',
  mountain: 'Mountain',
  coastal: 'Coastal',
  desert: 'Desert',
  heathland: 'Heathland',
  tropical: 'Tropical',
}

/** When a course carries several tags, the most distinctive landscape wins. */
const TAG_PRIORITY: readonly Backdrop[] = ['mountain', 'desert', 'tropical', 'coastal', 'heathland', 'links', 'parkland']

/** GSPro altitude is in feet (FarmLinks, Sylacauga AL: 545). */
const MOUNTAIN_ALTITUDE_FT = 3000

export const isBackdrop = (value: unknown): value is Backdrop =>
  typeof value === 'string' && (BACKDROPS as readonly string[]).includes(value)

export type BackdropInputs = Readonly<{
  override?: string | null
  keywords?: readonly string[] | null
  altitudeFt?: number | null
}>

export const pickBackdrop = ({ override, keywords, altitudeFt }: BackdropInputs): { backdrop: Backdrop; reason: 'override' | 'designer-tag' | 'altitude' | 'default' } => {
  if (isBackdrop(override)) return { backdrop: override, reason: 'override' }
  const tags = new Set((keywords ?? []).map((tag) => tag.toLowerCase()))
  const tagged = TAG_PRIORITY.find((backdrop) => tags.has(backdrop))
  if (tagged) return { backdrop: tagged, reason: 'designer-tag' }
  if (typeof altitudeFt === 'number' && altitudeFt >= MOUNTAIN_ALTITUDE_FT) return { backdrop: 'mountain', reason: 'altitude' }
  return { backdrop: 'links', reason: 'default' }
}
