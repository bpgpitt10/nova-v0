// Untagged range swings sorted into runs the player names once (22 Nov).
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
  const { groupVisits, unsortedSwings, sessionFromVisit } = await load('/src/lib/rangeSort.ts')
  const t0 = Date.parse('2026-11-21T19:00:00Z')
  let n = 0
  const swing = (minutes, mph, launch, carry, guess) => ({
    id: `s${n += 1}`, seq: n, at: t0 + minutes * 60_000, ballSpeedMph: mph, launchDeg: launch, startDirectionDeg: 0,
    spinRpm: 6000, spinAxisDeg: 0, backSpinRpm: 6000, sideSpinRpm: 0, carryYds: carry, totalYds: carry + 8,
    offlineYds: 2, guess, guessConfidence: 0.5,
  })
  const swings = [
    // 7 irons, with a fat one in the middle that the guess calls a 9 iron
    swing(0, 118, 16, 160, '7i'), swing(1, 119, 16.5, 162, '7i'), swing(2, 117, 15.8, 158, '7i'),
    swing(3, 101, 18, 128, '9i'),
    swing(4, 118.5, 16.2, 161, '7i'), swing(5, 120, 16, 164, '7i'), swing(6, 118, 16.4, 159, '8i'),
    // wedges
    swing(8, 92, 26, 112, 'PW'), swing(9, 93, 27, 114, 'PW'), swing(10, 91, 26.5, 110, 'PW'), swing(11, 92.5, 25.5, 113, 'GW'),
    // drivers
    swing(13, 158, 12, 255, 'Driver'), swing(14, 160, 11.5, 262, 'Driver'), swing(15, 157, 12.5, 251, 'Driver'),
    // another visit, the day before
    swing(-1500, 118, 16, 160, '7i'), swing(-1499, 119, 16, 161, '7i'),
  ]
  const visits = groupVisits(swings)
  assert.equal(visits.length, 2)
  assert.equal(visits[0].swings.length, 14, 'newest visit first')
  const [irons, wedges, drivers] = visits[0].runs
  assert.equal(visits[0].runs.length, 3, 'three runs, the fat one folded back into the 7 irons')
  assert.equal(irons.swings.length, 7)
  assert.equal(irons.guess, '7i')
  assert.deepEqual([...irons.outlierIds], ['s4'], 'the fat one is left out by default')
  assert.equal(irons.carryLowYds, 158)
  assert.equal(irons.carryHighYds, 164)
  assert.equal(wedges.guess, 'PW')
  assert.equal(wedges.swings.length, 4)
  assert.equal(drivers.guess, 'Driver')

  // Saving: only kept swings, under the club the player named.
  const keepAll = (run) => new Set(run.swings.filter((s) => !run.outlierIds.has(s.id)).map((s) => s.id))
  const session = sessionFromVisit(visits[0], new Map([
    [irons.key, { club: '7i', keepIds: keepAll(irons) }],
    [wedges.key, { club: 'GW', keepIds: keepAll(wedges) }],
    [drivers.key, { club: null, keepIds: keepAll(drivers) }],
  ]))
  assert.equal(session.shots.length, 10)
  assert.equal(session.shots.filter((s) => s.club === '7i').length, 6)
  assert.equal(session.shots.filter((s) => s.club === 'GW').length, 4, 'the player’s club beats the guess')
  assert.ok(session.shots.every((s) => s.included && s.id.startsWith('range-')))
  assert.equal(session.metadata.includeInAnalysis, true)
  assert.equal(sessionFromVisit(visits[0], new Map()), null, 'nothing kept, nothing saved')

  // Already in the bag: sorted before, dismissed, or captured by a range session at the time.
  const captured = { id: 'cap', startedAt: '', endedAt: '', shots: [
    { id: 'x', club: 'PW', included: true, capturedAt: new Date(t0 + 8 * 60_000 + 4000).toISOString(), ballSpeedMph: 92.4, source: 'simread', enrichmentStatus: 'raw_only' },
  ] }
  const left = unsortedSwings(swings, [session, captured], new Set(['s12']))
  const leftIds = left.map((s) => s.id)
  assert.ok(!leftIds.includes('s1'), 'sorted swings are not offered again')
  assert.ok(leftIds.includes('s4'), 'the left-out fat one is still unsorted')
  assert.ok(!leftIds.includes('s8'), 'a swing the capture tool already saved is skipped')
  assert.ok(!leftIds.includes('s12'), 'a dismissed swing is skipped')
  assert.ok(leftIds.includes('s13'), 'a run left out without dismissing is still there')
  console.log('range sort ok')
} finally {
  await server?.close()
}
