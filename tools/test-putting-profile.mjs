// Putting profile: real putts only, finish measured against the cup, pace and
// line as size and lean. Checked on hand-built putts and on the Old Game round.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

try {
  const history = await load('/src/lib/roundHistory.ts')
  const profileLib = await load('/src/lib/puttingProfile.ts')
  const { buildPuttingProfile, profilePutts, summarizePace, summarizeLine } = profileLib

  // 1. One hole, putting due north at a cup 10 m away (32.8 ft).
  const cup = { x: 0, y: -0.165, z: 10 }
  const putt = (number, extra) => ({
    holeNumber: 1, number, isPutt: true, conceded: false, holed: false, startYds: 10.936, endYds: 1.2, sg: -0.2,
    start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 9 }, cup, ballSpeedMph: 7, startDirectionDeg: 1.5, aimDirectionDeg: null,
    ...extra,
  })
  const round = (shots, extra = {}) => ({
    roundId: 1, courseName: 'Test', playedAt: '2026-11-01', autoPutt: false, counts: true, completeHoles: 1,
    holes: [{ holeNumber: 1, complete: true, shots }], ...extra,
  })
  {
    const [p] = profilePutts(round([putt(3, {})]))
    assert.ok(Math.abs(p.lengthFt - 32.8) < 0.1)
    assert.ok(Math.abs(p.alongFt + 3.28) < 0.01, `1 m short: ${p.alongFt}`)
    assert.ok(Math.abs(p.lateralFt - 3.28) < 0.01, `1 m right of a northbound putt: ${p.lateralFt}`)
    assert.equal(p.pace, 'short')
    assert.equal(p.slope, 'flat', 'the cup point is the bottom of the hole, not a 6-inch drop')
    assert.equal(p.lengthBucket, '25-35')
    assert.equal(p.first, true)
  }
  // 2. Not putts: a gimme, a full swing from the green, anything inside 5 ft.
  {
    const kept = profilePutts(round([
      putt(3, {}), putt(4, { conceded: true }), putt(5, { ballSpeedMph: 80 }), putt(6, { startYds: 1.2 }),
    ]))
    assert.deepEqual(kept.map((p) => p.number), [3])
    assert.equal(kept[0].holePutts, 4, 'gimmes still count as putts taken on the hole')
    assert.equal(kept[0].leftGimme, true, 'the miss was followed by a conceded putt')
    assert.equal(profilePutts(round([putt(3, {}), putt(4, {})]))[0].leftGimme, false, 'followed by a real putt')
    assert.deepEqual(profilePutts(round([putt(3, {})], { autoPutt: true })), [], 'auto-putt rounds give nothing')
  }
  // 3. Uphill and downhill from the cup height; holed putts sit at the cup.
  {
    const [up] = profilePutts(round([putt(3, { cup: { ...cup, y: 0.2 - 0.165 } })]))
    assert.equal(up.slope, 'up')
    assert.ok(Math.abs(up.riseIn - 7.87) < 0.05)
    const [made] = profilePutts(round([putt(3, { holed: true, end: cup })]))
    assert.equal(made.pace, 'holed')
    assert.equal(made.alongFt, 0)
  }
  // 4. Positions that don't match the recorded distance: keep the putt, drop the geometry.
  {
    const [p] = profilePutts(round([putt(3, { startYds: 20 })]))
    assert.equal(p.alongFt, null)
    assert.equal(p.slope, null)
  }
  // 5. Size and lean. Opposite misses must not cancel into "fine".
  {
    const miss = (alongFt, deg) => ({ holed: false, alongFt, lengthFt: 20, pace: alongFt < 0 ? 'short' : alongFt > 3 ? 'long' : 'good', startDirectionDeg: deg })
    const scattered = [...Array(7)].flatMap(() => [miss(-4, -2), miss(6, 2)])
    const pace = summarizePace(scattered)
    assert.equal(pace.lean, null)
    assert.equal(pace.kind, 'scattered', 'four short and four long is not good pace')
    assert.ok(pace.size > 0.2)
    assert.ok(Math.abs(pace.sizeFt - 5) < 1e-9, 'typical pace miss in feet: 5 ft from the ideal finish either way')
    const line = summarizeLine(scattered)
    assert.equal(line.lean, null)
    assert.equal(line.kind, 'scattered')
    const shortHabit = summarizePace([...Array(12)].map(() => miss(-1, 0.1)))
    assert.deepEqual(shortHabit.lean, { side: 'short', count: 12, of: 12 })
    assert.equal(summarizePace([miss(-1, 0)]).kind, 'collecting')
    const pushes = summarizeLine([...Array(12)].map(() => miss(1, 0.8)))
    assert.equal(pushes.lean.side, 'right')
    assert.equal(pushes.kind, 'habit')
  }

  // 5b. Splitting one miss between read, pace and line. The three always add up to what the miss cost.
  {
    const { attributeMiss } = profileLib
    const near = (a, b) => Math.abs(a - b) < 1e-9
    const total = (c) => c.read + c.pace + c.line
    const benchmark = (ft) => history.tourExpectedStrokes('green', ft / 3)
    // Dead on line, two feet short: all pace.
    const short = attributeMiss(20, 0, -2, 0).costs
    assert.ok(near(short.read, 0) && near(short.line, 0), 'a putt on line and short is not a read or line miss')
    assert.ok(near(short.pace, benchmark(2)))
    // A foot right at perfect pace, and the start direction explains all of it: all line.
    const pushedDeg = (Math.atan(1 / 20) * 180) / Math.PI
    const pushed = attributeMiss(20, 1, 1, pushedDeg)
    assert.ok(near(pushed.readLateralFt, 0))
    assert.ok(near(pushed.costs.read, 0) && near(pushed.costs.pace, 0) && near(pushed.costs.line, benchmark(Math.hypot(1, 1))))
    // Same finish, started dead on the aim: all read.
    const misread = attributeMiss(20, 1, 1, 0).costs
    assert.ok(near(misread.line, 0) && near(misread.pace, 0) && misread.read > 1)
    // A mixed miss: shares are all positive and add up to the cost.
    const mixed = attributeMiss(30, 1.5, -3, 1).costs
    assert.ok(mixed.read > 0 && mixed.pace > 0 && mixed.line > 0)
    assert.ok(near(total(mixed), benchmark(Math.hypot(1.5, 3))))
    // A pull that rescued a bad read: fixing the line alone makes it worse, so line can come out negative, and it still adds up.
    const cancelling = attributeMiss(20, 0.5, 1, -2).costs
    assert.ok(near(total(cancelling), benchmark(Math.hypot(0.5, 1))))
    // With the roll path: read and line are judged where the ball passed the hole, not where it stopped.
    // Passed 6 in right, then broke on to finish 18 in right and 3 ft past; started on the aim.
    const drifted = attributeMiss(20, 1.5, 3, 0, 0.5)
    assert.ok(near(drifted.readLateralFt, 0.5), 'read is the miss at the hole')
    assert.ok(near(total(drifted.costs), benchmark(Math.hypot(1.5, 3))), 'still adds up to what the miss cost')
    assert.ok(drifted.costs.read > 0 && drifted.costs.pace > 0)
    // Passed over the middle of the hole but ran 6 ft by: read and line are clean.
    const overTheTop = attributeMiss(20, 1.5, 6, 0, 0)
    assert.ok(near(overTheTop.readLateralFt, 0) && near(overTheTop.costs.read, 0) && near(overTheTop.costs.line, 0))
    assert.ok(near(overTheTop.costs.pace, benchmark(Math.hypot(1.5, 6))), 'through the hole too fast is all pace')
    // No pass point: unchanged from before.
    assert.deepEqual(attributeMiss(30, 1.5, -3, 1, null), attributeMiss(30, 1.5, -3, 1))
    {
      const passed = buildPuttingProfile([round([putt(3, { end: { x: 0.5, y: 0, z: 11 }, passHole: { x: 0.1, y: 0, z: 10 }, startDirectionDeg: 0, endYds: 0.6 })])])
      assert.ok(near(passed.putts[0].readLateralFt, 0.1 * 3.280839895), 'the profile uses the pass point when the shot has one')
    }
    // In a round: the miss gets a cause, and with putting losing strokes the three strokes add up to the total.
    const built = buildPuttingProfile([round([putt(3, { end: { x: 0.05, y: 0, z: 9 }, startDirectionDeg: 0.2 })])])
    assert.equal(built.putts[0].cause, 'pace')
    assert.ok(built.skillShare && near(built.skillShare.read + built.skillShare.pace + built.skillShare.line, 1))
    assert.ok(built.skillStrokes && near(built.skillStrokes.read + built.skillStrokes.pace + built.skillStrokes.line, built.sgPer18))
    // Gaining strokes: the three still add up, and the skill that cost least gets the most credit.
    const gaining = buildPuttingProfile([round([
      putt(3, { end: { x: 0.05, y: 0, z: 9 }, startDirectionDeg: 0.2, sg: 0.1 }),
      putt(4, { holed: true, end: cup, sg: 0.9 }),
    ])])
    assert.ok(gaining.sgPer18 > 0)
    const g = gaining.skillStrokes
    assert.ok(g && near(g.read + g.pace + g.line, gaining.sgPer18))
    assert.ok(g.pace < g.read && g.pace < g.line && g.pace >= 0, 'pace cost the most, so it gets the least of the gain')
  }

  // 6. The Old Game (round 268): real putts only, every one of them 5 ft or longer.
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/round-history/rounds-268-269.json', import.meta.url), 'utf8'))
  const index = Object.fromEntries(fixture.columns.map((name, i) => [name, i]))
  const xyz = (value) => (value ? { x: value[0], y: value[1], z: value[2] } : null)
  const rows = fixture.rows.map((row) => ({
    gspro_round_id: row[index.gspro_round_id], course_key: row[index.course_key], hole_number: row[index.hole_number],
    hole_shot: row[index.hole_shot], observed_at: row[index.observed_at], starting_surface_raw: row[index.starting_surface_raw],
    ending_surface_raw: row[index.ending_surface_raw], distance_to_pin_yards: row[index.distance_to_pin_yards],
    carry_yards: row[index.carry_yards], total_yards: row[index.total_yards], spin_axis_degrees: row[index.spin_axis_degrees],
    gspro_club_index: row[index.gspro_club_index],
    raw_metrics: { isHoled: row[index.isHoled], isGimme: row[index.isGimme], startingPositionMeters: xyz(row[index.startingPositionMeters]), endingPositionMeters: xyz(row[index.endingPositionMeters]) },
    actual_club: row[index.actual_club], club_source: row[index.club_source], inferred_club: row[index.inferred_club],
    inference_confidence: row[index.inference_confidence], recommended_club: row[index.recommended_club],
  }))
  const rounds = history.buildRounds(rows.map(history.recordFromCloudRow), { Links_v1: { name: 'The Old Game' } })
  const profile = buildPuttingProfile(rounds)
  assert.equal(profile.rounds, 1)
  assert.equal(profile.holes, 18)
  assert.ok(profile.putts.length >= 10 && profile.putts.length <= 20, `real putts: ${profile.putts.length}`)
  assert.ok(profile.putts.every((p) => p.lengthFt >= 5))
  assert.equal(profile.lengths.reduce((sum, row) => sum + row.putts, 0), profile.putts.length, 'every putt is in one length bucket')
  assert.ok(profile.gimmes >= 10, `gimmes left out: ${profile.gimmes}`)
  assert.ok(profile.sgPer18 != null && Math.abs(profile.sgPer18) < 15)
  assert.equal(profile.readPutts, 0, 'old rounds carry no aim')
  assert.equal(profile.attributedPutts, 0, 'this fixture has no start directions, so nothing is split')
  assert.equal(profile.skillShare, null)
  // Misses are measured against where the gimme went in.
  const measured = profile.putts.filter((p) => !p.holed && p.alongFt != null)
  assert.ok(measured.length >= 8, `misses with a finish: ${measured.length}`)
  for (const p of measured) {
    assert.ok(Math.abs(Math.hypot(p.alongFt, p.lateralFt) - p.leaveFt) < 1, `finish matches the leave on hole ${p.holeNumber}`)
  }
  assert.equal(profile.trend.length, 1)
  console.log(`putting profile: ok (${profile.putts.length} real putts in the Old Game, ${measured.length} misses measured)`)
} finally {
  await server?.close()
}
