// "Your courses" at sign-in: which loads show and how each reads. Run: node tools/test-course-loads-notice.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { unseenCourseLoads, myLoadLine, loadQuestion } = await server.ssrLoadModule('/src/courseLoading/courseLoads.ts')
  const base = { created_at: '2026-11-24T20:00:00Z', location: null, slug: null, gspro_course_key: null, stage: null, stage_index: null, stage_count: null, started_at: null, error: null, mode: null, error_code: null }
  const rows = [
    { ...base, id: 'k', course_name: 'Kenai Golf Course', status: 'failed', finished_at: '2026-11-24T21:01:55Z', acknowledged_at: null, error: 'validate failed: FAIL … area has 16 greens (min 18)' },
    { ...base, id: 's', course_name: 'We-Ko-Pa Saguaro Golf Course', status: 'ready', finished_at: '2026-11-24T22:52:27Z', acknowledged_at: null },
    { ...base, id: 'c', course_name: 'We-Ko-Pa Golf Club', status: 'failed', finished_at: '2026-11-24T23:00:00Z', acknowledged_at: null, error_code: 'multiple_courses', error: 'This outline holds more than one course (Cholla, Saguaro): each hole number is mapped twice. Search for the one course you play and load that.' },
    { ...base, id: 'r', course_name: 'Pine Needles', status: 'running', finished_at: null, acknowledged_at: null, stage_index: 5, stage_count: 9 },
    { ...base, id: 'old', course_name: 'Seen already', status: 'ready', finished_at: '2026-11-20T00:00:00Z', acknowledged_at: '2026-11-21T00:00:00Z' },
  ]
  assert.deepEqual(unseenCourseLoads(rows).map((r) => r.id), ['k', 's', 'c', 'r'], 'acknowledged loads stay away; running ones show')
  const [kenai, saguaro, club, running] = unseenCourseLoads(rows).map(myLoadLine)
  assert.equal(kenai.icon, '❌')
  assert.match(kenai.text, /^Kenai Golf Course couldn't load\. OpenStreetMap only has 16 of this course's 18 greens/)
  assert.match(kenai.text, /basic caddie/)
  assert.doesNotMatch(kenai.text, /validate|FAIL/)
  assert.equal(saguaro.icon, '✅')
  assert.match(saguaro.text, /ready\. Start a round in GSPro/)
  assert.equal(club.icon, '⚠️')
  assert.match(club.text, /Cholla, Saguaro/)
  assert.equal(running.text, 'Pine Needles is loading, step 5 of 9.')
  assert.match(myLoadLine({ ...base, id: 'a', course_name: 'Dunes West', status: 'ready', mode: 'area', finished_at: 'x', acknowledged_at: null }).text, /\(map area\)/)
  // The question: courses inside a multi-course outline, or nearby ones when the outline couldn't be built.
  const choices = [{ name: 'We-Ko-Pa Cholla', osmType: 'way', osmId: 11, lat: 33.59, lon: -111.69 }, { name: 'We-Ko-Pa Saguaro', osmType: 'way', osmId: 12, lat: 33.59, lon: -111.69 }]
  const q = loadQuestion({ status: 'failed', error_code: 'multiple_courses', course_choices: choices })
  assert.equal(q.prompt, 'Which course do you play?')
  assert.deepEqual(q.choices.map((c) => c.name), ['We-Ko-Pa Cholla', 'We-Ko-Pa Saguaro'])
  assert.equal(loadQuestion({ status: 'failed', error_code: 'holes_not_mapped', course_choices: choices }).prompt, 'Did you mean one of these?')
  assert.equal(loadQuestion({ status: 'ready', course_choices: choices }), null, 'nothing to ask about a ready load')
  assert.equal(loadQuestion({ status: 'failed', error_code: 'holes_not_mapped', course_choices: null }), null)
  assert.equal(loadQuestion({ status: 'failed', course_choices: [{ name: '', osmType: 'way', osmId: 0, lat: NaN, lon: 0 }] }), null, 'broken choices are dropped')
  console.log('course loads notice ok')
} finally { await server.close() }
