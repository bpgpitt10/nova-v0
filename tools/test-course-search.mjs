// Start a Round's course search: matches by name start, word start, location
// and GSPro name, best first.
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
  const { courseSearchScore } = await load('/src/courseGeometry/courseSearch.ts')
  const c = (name, location, aliases = []) => ({ name, location, gsproAliases: aliases })
  const kiawah = c('Kiawah Island Golf Resort - The Ocean Course', 'Kiawah Island, South Carolina', ['kiawah_b_01_gsp'])
  const pebble = c('Pebble Beach Golf Links', 'Pebble Beach, CA')
  const payne = c("Payne's Valley Golf Course", 'Hollister, MO')
  assert.equal(courseSearchScore(pebble, ''), 1, 'empty search lists everything')
  assert.equal(courseSearchScore(pebble, 'peb'), 4)
  assert.equal(courseSearchScore(kiawah, 'ocean'), 3, 'a word in the name')
  assert.equal(courseSearchScore(kiawah, 'kiawah_b'), 4, 'GSPro name')
  assert.ok(courseSearchScore(kiawah, 'south carolina') > 0, 'location')
  assert.equal(courseSearchScore(payne, 'paynes'), 4, 'apostrophes ignored')
  assert.equal(courseSearchScore(pebble, 'valhalla'), 0)
  console.log('PASS: course search matches name, words, GSPro name and location.')
} finally {
  await server?.close()
}
