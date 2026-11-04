// Course loading: installed GSPro course names must find their OpenStreetMap
// course even when spelling differs ("Paynes Valley" vs "Payne's Valley"),
// and must never grab an unrelated nearby course.
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

const { courseNameMatchScore, findGolfCourseFor, CourseSearchBusyError } = await load('/src/courseLoading/courseLoads.ts')

// 1. Scoring ignores punctuation and filler words.
assert.equal(courseNameMatchScore("Payne's Valley", 'Paynes Valley'), 1)
assert.equal(courseNameMatchScore("Payne's Valley Golf Course", 'Paynes Valley'), 1)
assert.equal(courseNameMatchScore('The Old Game', 'Old Game Golf Club'), 1)
assert.ok(courseNameMatchScore('Mountain Top Golf Course', 'Paynes Valley') < 0.5)

// A fake Nominatim: tokens with apostrophes only match the apostrophe spelling.
const place = (name, id, town = 'Hollister') => ({
  name, display_name: `${name}, ${town}`, lat: '36.6', lon: '-93.2', osm_type: 'way', osm_id: id,
  category: 'leisure', type: 'golf_course', address: { town, state: 'Missouri' },
})
const OSM = [place("Payne's Valley", 101), place('Mountain Top', 102), place('Top of the Rock', 103),
  place('Ozarks National', 104)]
const queries = []
globalThis.fetch = async (url) => {
  const q = new URL(url).searchParams.get('q').toLowerCase()
  queries.push(q)
  const hits = OSM.filter((p) => {
    if (q.includes('hollister') && q.startsWith('golf course')) return true // nearby search
    if (q.includes(p.name.toLowerCase())) return true
    // Like Nominatim: every searched word (but "golf") is a word of the name.
    const words = q.split(/\s+/).filter((w) => w && w !== 'golf')
    const nameWords = p.name.toLowerCase().split(/\s+/)
    return words.length > 0 && words.every((w) => nameWords.includes(w))
  })
  return new Response(JSON.stringify(hits), { headers: { 'Content-Type': 'application/json' } })
}

// 2. "Paynes Valley" finds Payne's Valley through the possessive spelling.
let match = await findGolfCourseFor('Paynes Valley', '')
assert.equal(match?.osmId, 101)
assert.ok(queries.some((q) => q.includes("payne's valley")), 'tried the possessive spelling')

// 3. With a location, the closest name wins even among nearby courses.
queries.length = 0
OSM[0] = place("Payne's Valley at Big Cedar", 101)
match = await findGolfCourseFor('Paynes Valley', 'Hollister, MO')
assert.equal(match?.osmId, 101, 'nearby search plus name match')

// 4. A course that isn't on the map never borrows a nearby course's identity.
queries.length = 0
match = await findGolfCourseFor('Ashen Cliffs', 'Hollister, MO')
assert.equal(match, null)

// 5. A designer tag in GSPro's name ("DPC Pebble") is also tried without it.
queries.length = 0
OSM.push(place('Pebble Beach Golf Links', 105, 'Pebble Beach'))
match = await findGolfCourseFor('DPC Pebble', '')
assert.equal(match?.osmId, 105, 'found without the designer tag')

// 6. OpenStreetMap refusing (429) is reported as busy, not as "no match".
globalThis.fetch = async () => new Response('Too Many Requests', { status: 429 })
await assert.rejects(findGolfCourseFor('Bethpage Black', 'Farmingdale, NY'), (error) => error instanceof CourseSearchBusyError)

if (server) await server.close()
console.log('course name match: ok')
