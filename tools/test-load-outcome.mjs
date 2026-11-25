// Plain-language outcomes for course loads (Kenai, We-Ko-Pa, 24 Nov). Run: node tools/test-load-outcome.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { loadOutcome } = await server.ssrLoadModule('/src/courseLoading/courseLoads.ts')
  const kenaiOld = loadOutcome({ status: 'failed', error: 'validate failed: FAIL /home/runner/.../course-area-v1.json (0.4 MB) | hard: area has 16 greens (min 18)' })
  assert.equal(kenaiOld.label, "Can't load yet · not fully mapped")
  assert.ok(kenaiOld.basicCaddie && /16 of this course's 18 greens/.test(kenaiOld.detail) && !/validate|FAIL/.test(kenaiOld.detail))
  const kenaiNew = loadOutcome({ status: 'failed', error_code: 'holes_not_mapped', error: "OpenStreetMap only has 16 of this course's 18 greens and none of its holes, so the map can't be built yet." })
  assert.equal(kenaiNew.label, "Can't load yet · not fully mapped")
  assert.match(kenaiNew.detail, /basic caddie/)
  const club = loadOutcome({ status: 'failed', error_code: 'multiple_courses', error: 'This outline holds more than one course (Cholla, Saguaro): each hole number is mapped twice. Search for the one course you play and load that.' })
  assert.equal(club.label, 'More than one course here')
  assert.match(club.detail, /Cholla, Saguaro/)
  assert.equal(loadOutcome({ status: 'ready', mode: 'area' }).label, 'Ready · map area')
  assert.equal(loadOutcome({ status: 'ready', mode: null }).label, 'Ready to play')
  assert.equal(loadOutcome({ status: 'running' }).tone, 'progress')
  assert.equal(loadOutcome({ status: 'failed', error: 'osm failed: timeout' }).label, "Didn't load")
  console.log('load outcome ok')
} finally { await server.close() }
