// Load page links: a GSPro course with a different name ("DPC Pebble")
// resolves to the loaded course it was linked to, and only that one.
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
  const { setGsproLinks } = await load('/src/courseGeometry/gsproLinks.ts')
  const { resolveCourseIdFromGsproName, courseGsproAliases, getCourseCatalogEntry, courseRegistry } =
    await load('/src/courseGeometry/courseCatalog.ts')
  const pebble = courseRegistry.find((e) => e.slug === 'pebble-beach')
  assert.ok(pebble, 'Pebble Beach is loaded')
  assert.equal(resolveCourseIdFromGsproName('dpc_pebble_gsp'), null, 'no link yet')
  setGsproLinks([{ gsproCourseKey: 'dpc_pebble_gsp', gsproCourseName: 'DPC Pebble', courseSlug: 'pebble-beach' }])
  assert.equal(resolveCourseIdFromGsproName('dpc_pebble_gsp'), pebble.id)
  assert.equal(resolveCourseIdFromGsproName('DPC Pebble'), pebble.id, 'by GSPro display name too')
  assert.ok(courseGsproAliases(getCourseCatalogEntry(pebble.id)).includes('dpc_pebble_gsp'))
  // A link to a course that isn't loaded resolves to nothing.
  setGsproLinks([{ gsproCourseKey: 'ghost_gsp', gsproCourseName: 'Ghost', courseSlug: 'not-loaded' }])
  assert.equal(resolveCourseIdFromGsproName('ghost_gsp'), null)
  assert.equal(resolveCourseIdFromGsproName('dpc_pebble_gsp'), null, 'unlinked')
  // The crossed links removed in #80 stay gone.
  assert.equal(resolveCourseIdFromGsproName('mammoth_dunes_gsp'), null)
  assert.equal(resolveCourseIdFromGsproName('Bellerive_gsp'), null)
  console.log('PASS: GSPro course links resolve to the linked loaded course.')
} finally {
  await server?.close()
}
