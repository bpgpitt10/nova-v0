/**
 * Player-made links from a GSPro course (CourseKey) to a loaded Looper course
 * (slug), for GSPro names that don't match the map name ("DPC Pebble" →
 * Pebble Beach). Kept in Supabase (course_gspro_links) and loaded at app start;
 * the course catalog treats them like reviewed aliases.
 */
export type GsproLink = Readonly<{ gsproCourseKey: string; gsproCourseName: string | null; courseSlug: string }>

const CACHE_KEY = 'looper.gspro-links.v1'
export const GSPRO_LINKS_UPDATED_EVENT = 'looper:gspro-links-updated'

let links: readonly GsproLink[] = (() => {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(CACHE_KEY) : null
    const parsed = raw ? JSON.parse(raw) as unknown : null
    return Array.isArray(parsed)
      ? parsed.filter((l): l is GsproLink => typeof l?.gsproCourseKey === 'string' && typeof l?.courseSlug === 'string')
      : []
  } catch {
    return []
  }
})()

export const gsproLinks = (): readonly GsproLink[] => links

export const setGsproLinks = (next: readonly GsproLink[]) => {
  links = [...next]
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(links))
  } catch {
    // memory copy is enough
  }
  try {
    window.dispatchEvent(new Event(GSPRO_LINKS_UPDATED_EVENT))
  } catch {
    // not in a browser (tests)
  }
}
