import { getSupabaseClient } from '../cloud/supabaseClient'

/**
 * The course crosswalk (Supabase `course_crosswalk`, built by
 * tools/course_model/build_crosswalk.py from SGT's public GSPro course
 * manifest): GSPro's course folder key -> the real course on OpenStreetMap,
 * matched once near the course's own coordinates. Loading a course reads this
 * before any name search, so "Greywolf" can't turn into Point Grey.
 */

export type CrosswalkStatus = 'matched' | 'review' | 'no-map' | 'fictional'

export type CrosswalkCandidate = Readonly<{
  type: 'way' | 'relation'
  id: number
  name: string
  distanceM: number
  score: number
}>

export type CrosswalkRow = Readonly<{
  sgt_id: number
  name: string
  location: string
  lat: number | null
  lon: number | null
  gspro_folder: string | null
  status: CrosswalkStatus
  osm_type: 'way' | 'relation' | null
  osm_id: number | null
  osm_name: string | null
  candidates: readonly CrosswalkCandidate[]
  verified: boolean
}>

const COLUMNS = 'sgt_id, name, location, lat, lon, gspro_folder, status, osm_type, osm_id, osm_name, candidates, verified'

/** The crosswalk row for a GSPro course key (GSPro's course folder), or null. */
export const crosswalkForGsproKey = async (courseKey: string): Promise<CrosswalkRow | null> => {
  const key = courseKey.trim()
  if (!key) return null
  const client = await getSupabaseClient()
  const { data, error } = await client
    .from<CrosswalkRow[]>('course_crosswalk')
    .select(COLUMNS)
    .eq('gspro_folder', key)
    .limit(1)
  if (error) throw new Error(error.message)
  return data?.[0] ?? null
}

export type CrosswalkDecision =
  | Readonly<{ kind: 'load'; name: string; location: string; lat: number; lon: number; osmType: 'way' | 'relation'; osmId: number }>
  | Readonly<{ kind: 'pick'; candidates: ReadonlyArray<{ name: string; location: string; lat: number; lon: number; osmType: 'way' | 'relation'; osmId: number }> }>
  | Readonly<{ kind: 'not-on-map'; reason: string }>
  | Readonly<{ kind: 'unknown' }>

/** What the Load button should do for this crosswalk row. */
export const crosswalkDecision = (row: CrosswalkRow | null): CrosswalkDecision => {
  if (!row) return { kind: 'unknown' }
  if (row.status === 'fictional') return { kind: 'not-on-map', reason: 'a fictional course (no real place to map)' }
  if (row.status === 'no-map') return { kind: 'not-on-map', reason: 'no golf course is mapped on OpenStreetMap at its location yet' }
  if (row.lat == null || row.lon == null) return { kind: 'unknown' }
  const { lat, lon } = row
  if (row.status === 'matched' && row.osm_type && row.osm_id) {
    return { kind: 'load', name: row.name, location: row.location, lat, lon, osmType: row.osm_type, osmId: row.osm_id }
  }
  const candidates = (row.candidates ?? []).filter((c) => (c.type === 'way' || c.type === 'relation') && c.id)
  if (candidates.length === 0) return { kind: 'unknown' }
  return {
    kind: 'pick',
    candidates: candidates.map((c) => ({
      name: c.name || `${row.name} (outline with no name, ${Math.round(c.distanceM / 100) / 10} km away)`,
      location: row.location,
      lat, lon, osmType: c.type, osmId: c.id,
    })),
  }
}
