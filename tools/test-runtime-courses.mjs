// Courses published at run time by the one-click loader (Supabase
// loaded_courses) join the catalog without a site build: found by id, slug and
// GSPro alias; package files from their storage folder; built-in courses kept.
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
  const catalog = await load('/src/courseGeometry/courseCatalog.ts')
  const runtime = await load('/src/courseGeometry/runtimeCourses.ts')
  const before = catalog.courseRegistry.length
  const base = 'https://kdjfdchzfemjpmaqpobn.supabase.co/storage/v1/object/public/course-packages/bellerive'
  const row = {
    slug: 'bellerive', course_id: 'bellerive-country-club-town-and-country-missouri', name: 'Bellerive Country Club',
    location: 'Town and Country, Missouri', gspro_aliases: ['bellerive_gsp'], package_url: `${base}/course-v1.json`,
    lidar: true, hole_headings: [10, 20, 30, null, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180],
  }
  const pebble = catalog.courseRegistry.find((e) => e.slug === 'pebble-beach')
  assert.ok(pebble, 'Pebble Beach is built in')
  const added = runtime.applyLoadedCourseRows([
    row,
    { ...row, slug: 'pebble-beach', course_id: pebble.id, package_url: 'https://example.com/x/course-v1.json' },
    { slug: 'broken' },
  ])
  assert.equal(added, 1, 'one new course; the built-in Pebble Beach and the broken row are not added')
  assert.equal(catalog.courseRegistry.length, before + 1)
  assert.ok(catalog.courseCatalog.some((e) => e.slug === 'bellerive'), 'listed for players too')
  assert.equal(catalog.courseRegistry.find((e) => e.slug === 'pebble-beach').staticPackageUrl, pebble.staticPackageUrl)
  const entry = catalog.getCourseCatalogEntry(row.course_id)
  assert.equal(entry.name, 'Bellerive Country Club')
  assert.ok(catalog.isCourseId(row.course_id))
  assert.equal(catalog.resolveCourseIdFromGsproName('bellerive_gsp'), row.course_id)
  assert.equal(catalog.resolveCourseIdFromGsproName('Bellerive Country Club'), row.course_id, 'its own name is an alias')
  assert.equal(catalog.coursePackageBaseUrl('bellerive'), `${base}/`)
  assert.equal(catalog.coursePackageBaseUrl('pebble-beach'), '/course-geometry/pebble-beach/')
  assert.equal(catalog.getRuntimeHoleHeadingDegreesTrue(row.course_id, 3), 30)
  assert.equal(catalog.getRuntimeHoleHeadingDegreesTrue(row.course_id, 4), null)
  // A newer load of the same runtime course replaces it in place.
  runtime.applyLoadedCourseRows([{ ...row, name: 'Bellerive CC' }])
  assert.equal(catalog.courseRegistry.length, before + 1)
  assert.equal(catalog.getCourseCatalogEntry(row.course_id).name, 'Bellerive CC')
  console.log('PASS: runtime-loaded courses join the catalog (id, slug, alias, storage folder, headings); built-in courses kept.')
} finally {
  await server?.close()
}
