import { getSupabaseClient } from '../cloud/supabaseClient'
import { courseNameMatchScore } from './courseNameMatch'

export { courseNameMatchScore }

/**
 * One-click course loading (client side): search OpenStreetMap for golf
 * courses, queue a load in Supabase (course_load_requests), start the loader
 * (Supabase function course-load-dispatch), and read progress back.
 */

export type CourseLoadStatus = 'queued' | 'running' | 'publishing' | 'ready' | 'failed'

export type CourseLoadRow = {
  id: string
  created_at: string
  course_name: string
  location: string | null
  slug: string | null
  gspro_course_key: string | null
  status: CourseLoadStatus
  stage: string | null
  stage_index: number | null
  stage_count: number | null
  started_at: string | null
  finished_at: string | null
  error: string | null
}

export type GolfCourseSearchResult = Readonly<{
  name: string
  location: string
  lat: number
  lon: number
  osmType: 'way' | 'relation'
  osmId: number
}>

const STOP_WORDS = new Set(['the', 'golf', 'club', 'course', 'country', 'links', 'resort', 'at', 'of', 'and', 'gc', 'cc'])

/** URL-safe course slug from its name: "Valhalla Golf Club" -> "valhalla". */
export const courseSlugFromName = (name: string) => {
  const words = name.normalize('NFKD').replace(/[^\w\s-]/g, '').toLowerCase().split(/[\s_-]+/).filter(Boolean)
  const kept = words.filter((w) => !STOP_WORDS.has(w))
  return (kept.length ? kept : words).join('-').slice(0, 60) || 'course'
}

// Measured on GitHub Actions (Valhalla, Royal New Kent, Muirfield Village):
// typical seconds per stage. The LiDAR download varies most (40 s - 4.6 min).
const TYPICAL_STAGE_SECONDS: Record<string, number> = {
  setup: 60, find: 90, config: 0, import: 60, osm: 35, dem: 11, lidar: 120, trees: 20, enrich: 30, publish: 180,
}
const STAGE_ORDER = ['setup', 'find', 'config', 'import', 'osm', 'dem', 'lidar', 'trees', 'enrich', 'publish']

export const typicalLoadMinutes = () =>
  Math.round(Object.values(TYPICAL_STAGE_SECONDS).reduce((a, b) => a + b, 0) / 60)

/** Rough minutes left for a load in progress. */
export const minutesLeft = (row: CourseLoadRow): number | null => {
  if (row.status === 'ready' || row.status === 'failed') return null
  const current = row.status === 'queued' ? 'setup' : row.status === 'publishing' ? 'publish' : row.stage ?? 'find'
  const index = Math.max(0, STAGE_ORDER.indexOf(current))
  const seconds = STAGE_ORDER.slice(index).reduce((sum, stage) => sum + (TYPICAL_STAGE_SECONDS[stage] ?? 0), 0)
  return Math.max(1, Math.round(seconds / 60))
}

export const STAGE_LABELS: Record<string, string> = {
  find: 'Finding the course on the map',
  config: 'Preparing',
  import: 'Building holes, tees and greens',
  osm: 'Adding paths, roads and hazards',
  dem: 'Downloading elevation',
  lidar: 'Reading LiDAR (trees and terrain)',
  trees: 'Finding trees',
  enrich: 'Assembling the course',
  publish: 'Publishing to thelooper.golf',
}

export const listCourseLoads = async (): Promise<CourseLoadRow[]> => {
  const client = await getSupabaseClient()
  const { data, error } = await client
    .from<CourseLoadRow[]>('course_load_requests')
    .select('id, created_at, course_name, location, slug, gspro_course_key, status, stage, stage_index, stage_count, started_at, finished_at, error')
    .order('created_at', { ascending: false })
    .limit(40)
  if (error) throw new Error(error.message)
  return data ?? []
}

export const requestCourseLoad = async (course: Readonly<{
  name: string
  location: string
  lat: number
  lon: number
  osmType?: 'way' | 'relation' | null
  osmId?: number | null
  gsproCourseKey?: string | null
}>): Promise<{ dispatched: boolean }> => {
  const client = await getSupabaseClient()
  const { error } = await client.from('course_load_requests').insert({
    course_name: course.name.slice(0, 120),
    location: course.location.slice(0, 120) || null,
    lat: course.lat,
    lon: course.lon,
    osm_type: course.osmType ?? null,
    osm_id: course.osmId ?? null,
    gspro_course_key: course.gsproCourseKey ?? null,
    slug: courseSlugFromName(course.name),
  })
  if (error) {
    throw new Error(/duplicate key|one_active_per_slug/i.test(error.message)
      ? 'This course is already loading.'
      : error.message)
  }
  // Start the loader now; if the function is not configured, the 6-hourly
  // backstop still picks the request up.
  const { data } = await client.functions.invoke<{ dispatched?: boolean }>('course-load-dispatch', { body: {} })
    .catch(() => ({ data: null }))
  return { dispatched: Boolean(data?.dispatched) }
}

type NominatimPlace = {
  name?: string
  display_name?: string
  lat?: string
  lon?: string
  osm_type?: string
  osm_id?: number
  category?: string
  type?: string
  address?: Record<string, string>
}

const placeLocation = (address: Record<string, string> | undefined) => {
  if (!address) return ''
  const town = address.city ?? address.town ?? address.village ?? address.hamlet ?? address.county ?? ''
  const region = address.state ?? address.region ?? address.country ?? ''
  return [town, region].filter(Boolean).join(', ')
}

/** Golf courses by name from OpenStreetMap (Nominatim). */
/** OpenStreetMap's search refused us (too many searches); not "no match". */
export class CourseSearchBusyError extends Error {}

// Nominatim allows about one request per second per site. Every search on this
// page goes through one queue, spaced, and identical searches are remembered:
// loading several courses in a row used to trip the limit, every search came
// back empty, and real courses (Bethpage Black, Mammoth Dunes) "didn't match".
let searchChain: Promise<unknown> = Promise.resolve()
let lastSearchAt = 0
const searchCache = new Map<string, NominatimPlace[]>()

const nominatimSearch = (q: string, extra: Record<string, string> = {}): Promise<NominatimPlace[]> => {
  const cacheKey = `${q}|${JSON.stringify(extra)}`
  const cached = searchCache.get(cacheKey)
  if (cached) return Promise.resolve(cached)
  const run = async () => {
    const again = searchCache.get(cacheKey)
    if (again) return again
    const wait = lastSearchAt + NOMINATIM_SPACING_MS - Date.now()
    if (wait > 0) await pause(wait)
    lastSearchAt = Date.now()
    const params = new URLSearchParams({ format: 'jsonv2', q, limit: '15', addressdetails: '1', ...extra })
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { Accept: 'application/json' } })
      .catch(() => { throw new CourseSearchBusyError('OpenStreetMap search did not answer.') })
    if (response.status === 429 || response.status === 403 || response.status === 503) {
      lastSearchAt = Date.now() + 5000
      throw new CourseSearchBusyError(`OpenStreetMap search is busy (${response.status}).`)
    }
    if (!response.ok) throw new Error(`Course search failed (${response.status}).`)
    const places = (await response.json()) as NominatimPlace[]
    searchCache.set(cacheKey, places)
    return places
  }
  const next = searchChain.then(run, run)
  searchChain = next.catch(() => undefined)
  return next
}

const golfCoursesIn = (places: readonly NominatimPlace[]): GolfCourseSearchResult[] => {
  const seen = new Set<string>()
  const out: GolfCourseSearchResult[] = []
  for (const place of places) {
    if (place.category !== 'leisure' || place.type !== 'golf_course') continue
    if (place.osm_type !== 'way' && place.osm_type !== 'relation') continue
    const lat = Number(place.lat), lon = Number(place.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !place.osm_id) continue
    const key = `${place.osm_type}/${place.osm_id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name: place.name || (place.display_name ?? '').split(',')[0],
      location: placeLocation(place.address),
      lat, lon, osmType: place.osm_type, osmId: place.osm_id,
    })
  }
  return out
}

// About 6 km around a place: a resort's courses (Sand Valley: Mammoth Dunes).
const NEARBY_DEG = 0.06

export const searchGolfCourses = async (
  query: string,
  { nearby = true }: Readonly<{ nearby?: boolean }> = {},
): Promise<GolfCourseSearchResult[]> => {
  const q = query.trim()
  if (q.length < 3) return []
  const direct = golfCoursesIn(await nominatimSearch(/golf/i.test(q) ? q : `${q} golf`))
  if (direct.length || !nearby) return direct
  // Nothing tagged as a golf course by that name. OpenStreetMap often files a
  // resort course under the resort, or under a slightly different name: find
  // the place by name (any kind), then list the golf courses around it, best
  // name match first.
  const anyPlace = (await nominatimSearch(q.replace(/\bgolf\b/gi, ' ').replace(/\s+/g, ' ').trim() || q))
    .find((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)))
  if (!anyPlace) return []
  const lat = Number(anyPlace.lat), lon = Number(anyPlace.lon)
  const around = golfCoursesIn(await nominatimSearch('golf course', {
    viewbox: `${lon - NEARBY_DEG},${lat + NEARBY_DEG},${lon + NEARBY_DEG},${lat - NEARBY_DEG}`,
    bounded: '1',
  }))
  return around
    .map((result) => ({ result, score: courseNameMatchScore(result.name, q) }))
    .sort((a, b) => b.score - a.score)
    .map(({ result }) => result)
}

/** "Paynes Valley" -> also try "Payne's Valley", the way OpenStreetMap often spells it. */
const nameVariants = (name: string) => {
  const plain = name.replace(/[^\p{L}\p{N}'\s-]/gu, ' ').replace(/\s+/g, ' ').trim()
  const possessive = plain.replace(/\b([A-Za-z]{3,})s\b/g, "$1's")
  // GSPro designers often prefix their tag ("DPC Pebble"); also try without it.
  const untagged = plain.replace(/^[A-Z]{2,4}\s+(?=\S)/, '')
  return [...new Set([name.trim(), plain, possessive, untagged].filter((v) => v.length >= 3))]
}

const NOMINATIM_SPACING_MS = 1100 // Nominatim usage policy: at most one request per second.
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Best OpenStreetMap match for an installed GSPro course ("Name", "Town, ST").
 * Tries the name with and without the location, a possessive spelling, then
 * golf courses near the location, and keeps the closest name. A location-only
 * result is accepted only when its name clearly matches.
 */
export const findGolfCourseFor = async (
  name: string,
  location: string,
) => {
  const queries: Array<{ query: string; byName: boolean }> = []
  for (const variant of nameVariants(name)) {
    if (location) queries.push({ query: `${variant} ${location}`, byName: true })
    queries.push({ query: variant, byName: true })
  }
  if (location) queries.push({ query: `golf course ${location}`, byName: false })

  let best: { result: GolfCourseSearchResult; score: number } | null = null
  let fallback: GolfCourseSearchResult | null = null
  for (const { query, byName } of queries) {
    // A busy search is not "no match": let the page say so.
    // Name searches only: a nearby course must never stand in for this one.
    const results = await searchGolfCourses(query, { nearby: false }).catch((error: unknown) => {
      if (error instanceof CourseSearchBusyError) throw error
      return []
    })
    for (const result of results) {
      const score = courseNameMatchScore(result.name, name)
      if (!best || score > best.score) best = { result, score }
    }
    if (byName && !fallback && results.length) fallback = results[0]
    if (best && best.score >= 1) break
  }
  if (best && best.score >= 0.5) return best.result
  return fallback
}
