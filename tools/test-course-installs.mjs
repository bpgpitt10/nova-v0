// Admin page /admin/courses: courses players have installed, most-installed first, and what loading takes.
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
try {
  const { classifyCourseInstalls, sortCourseInstalls } = await load('/src/courseLoading/courseInstalls.ts')
  const row = (key, over = {}) => ({ course_key: key, course_name: key, location: null, players: 1, crosswalk_status: 'matched',
    lat: 40, lon: -75, osm_type: 'way', osm_id: 1, ...over })
  const rows = [
    row('loaded_gsp', { players: 3 }),
    row('ready_gsp', { players: 2 }),
    row('review_gsp', { players: 2, crosswalk_status: 'review' }),
    row('nolatlon_gsp', { players: 2, lat: null }),
    row('fiction_gsp', { players: 5, crosswalk_status: 'fictional' }),
    row('nomap_gsp', { crosswalk_status: 'no-map' }),
    row('unknown_gsp', { crosswalk_status: null, osm_id: null }),
    row('loading_gsp'),
    row('gspro_range_legacy', { course_name: 'GSProRange22', players: 9 }),
    row('IronPeakRange_gsp', { course_name: 'Iron Peak Range' }),
    row('byname_gsp', { course_name: 'DPC Pebble' }),
    row('orange_gsp', { course_name: 'Orange County National' }),
  ]
  const isLoaded = (key, name) => key === 'loaded_gsp' || name === 'DPC Pebble'
  const got = Object.fromEntries(classifyCourseInstalls(rows, isLoaded, new Set(['loading_gsp'])).map((c) => [c.course_key, c.status]))
  assert.deepEqual(got, {
    loaded_gsp: 'loaded', ready_gsp: 'ready', review_gsp: 'pick', nolatlon_gsp: 'pick', fiction_gsp: 'fictional',
    nomap_gsp: 'no-map', unknown_gsp: 'pick', loading_gsp: 'loading', gspro_range_legacy: 'range',
    IronPeakRange_gsp: 'range', byname_gsp: 'loaded', orange_gsp: 'ready',
  })
  const sorted = sortCourseInstalls(classifyCourseInstalls(rows, isLoaded)).map((c) => c.course_key)
  assert.equal(sorted[0], 'gspro_range_legacy') // most players first, whatever it is
  assert.deepEqual(sorted.slice(3, 6), ['ready_gsp', 'nolatlon_gsp', 'review_gsp']) // within 2 players: loadable first
  console.log('course installs: ok')
} finally {
  await server?.close()
}
