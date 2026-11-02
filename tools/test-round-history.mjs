// Round history: real captured rounds must rebuild exactly (The Old Game = 71,
// hole by hole, every putt and gimme), and test sessions whose shots don't
// chain must never be scored.
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

const history = await load('/src/lib/roundHistory.ts')
const fixture = JSON.parse(readFileSync(new URL('./fixtures/round-history/rounds-268-269.json', import.meta.url), 'utf8'))
const index = Object.fromEntries(fixture.columns.map((name, i) => [name, i]))
const xyz = (value) => (value ? { x: value[0], y: value[1], z: value[2] } : null)
const rows = fixture.rows.map((row) => ({
  gspro_round_id: row[index.gspro_round_id],
  course_key: row[index.course_key],
  hole_number: row[index.hole_number],
  hole_shot: row[index.hole_shot],
  observed_at: row[index.observed_at],
  starting_surface_raw: row[index.starting_surface_raw],
  ending_surface_raw: row[index.ending_surface_raw],
  distance_to_pin_yards: row[index.distance_to_pin_yards],
  carry_yards: row[index.carry_yards],
  total_yards: row[index.total_yards],
  spin_axis_degrees: row[index.spin_axis_degrees],
  gspro_club_index: row[index.gspro_club_index],
  raw_metrics: {
    isHoled: row[index.isHoled],
    isGimme: row[index.isGimme],
    startingPositionMeters: xyz(row[index.startingPositionMeters]),
    endingPositionMeters: xyz(row[index.endingPositionMeters]),
  },
  actual_club: row[index.actual_club],
  club_source: row[index.club_source],
  inferred_club: row[index.inferred_club],
  inference_confidence: row[index.inference_confidence],
  recommended_club: row[index.recommended_club],
}))
const records = rows.map(history.recordFromCloudRow)

const rounds = history.buildRounds(records, { Links_v1: { name: 'The Old Game' } })
const oldGame = rounds.find((round) => round.roundId === 268)
const farmlinksTest = rounds.find((round) => round.roundId === 269)
assert.ok(oldGame && farmlinksTest)

// --- The Old Game rebuilds to the exact score -------------------------------
assert.equal(oldGame.courseName, 'The Old Game')
assert.equal(oldGame.status, 'full')
assert.equal(oldGame.completeHoles, 18)
assert.equal(oldGame.brokenHoles, 0)
assert.equal(oldGame.strokes, 71, 'The Old Game scored 71 (GSPro Portal agrees)')
assert.deepEqual(
  oldGame.holes.map((hole) => hole.strokes),
  [4, 5, 3, 5, 4, 4, 4, 4, 2, 4, 5, 4, 3, 3, 4, 4, 5, 4],
)
assert.equal(oldGame.putts, 30)
const putts = oldGame.holes.flatMap((hole) => hole.shots).filter((shot) => shot.isPutt)
assert.ok(putts.every((shot) => shot.club === 'Putter'), 'putts are never labelled SW')
assert.equal(putts.filter((shot) => shot.conceded).length, 16, '16 gimmes, counted as strokes')
assert.equal(oldGame.par, null, 'no par without a course file')

// Hole 1: tee shot measured from the pin (the holed shot's rest), ~337 yd.
const h1 = oldGame.holes[0]
assert.ok(Math.abs(h1.shots[0].startYds - 337) < 2, `H1 length ${h1.shots[0].startYds}`)
assert.equal(h1.shots[1].startYds, 106.28, 'a shot starts where the previous one left off')
assert.equal(h1.shots[1].startLie, 'fairway')

// Hole 13: the 46-ft putt holed for birdie is a big gain; 17's escape is a loss.
const h13putt = oldGame.holes[12].shots[2]
assert.equal(h13putt.holed, true)
assert.ok(h13putt.sg > 1, `H13 putt SG ${h13putt.sg}`)
const h17escape = oldGame.holes[16].shots[1]
assert.equal(h17escape.startLie, 'deep-rough')
assert.ok(h17escape.sg < -0.5, `H17 escape SG ${h17escape.sg}`)
const { best, worst } = history.keyShots(oldGame)
assert.equal(best[0], h13putt)
assert.equal(worst[0], h17escape)

// Strokes gained is complete on a clean round and adds up by category.
const cats = oldGame.sg.categories
const catTotal = Object.values(cats).reduce((sum, entry) => sum + entry.sg, 0)
assert.ok(Math.abs(catTotal - oldGame.sg.total) < 1e-9)
assert.equal(cats.putting.shots, 30)
assert.equal(Object.values(cats).reduce((sum, entry) => sum + entry.shots, 0), 71)

// Par from a course file turns on GIR and fairways.
const withPar = history.buildRound(268, records.filter((r) => r.roundId === 268), {
  pars: { 1: 4, 2: 5, 3: 3, 4: 5, 5: 4, 6: 4, 7: 4, 8: 4, 9: 3, 10: 4, 11: 4, 12: 3, 13: 4, 14: 3, 15: 4, 16: 5, 17: 4, 18: 4 },
})
assert.equal(withPar.par, 71)
assert.equal(withPar.holes[0].gir, true)
assert.equal(withPar.holes[4].gir, false, 'H5 missed the green in regulation')
assert.equal(withPar.fir.of, 14)
assert.equal(withPar.holes[2].shots[0].category, 'approach', 'par-3 tee shots are approaches')
assert.equal(withPar.holes[0].shots[0].category, 'off-the-tee')

// Auto putt: score stays, putting drops out of strokes gained.
const autoPutt = history.buildRound(268, records.filter((r) => r.roundId === 268), {}, { autoPutt: true })
assert.equal(autoPutt.strokes, 71)
assert.equal(autoPutt.sg.categories.putting.shots, 0)
assert.ok(autoPutt.holes.every((hole) => hole.sg != null))

// Shot map: first shot at the origin, pin straight up the page.
const map = history.holeShotMap(h1)
assert.ok(Math.abs(map.tee.right) < 1e-9 && Math.abs(map.tee.forward) < 1e-9)
assert.ok(Math.abs(map.pin.right) < 1e-6)
assert.ok(Math.abs(map.pin.forward - 337) < 2)

// --- FarmLinks Live Caddie test session is never scored ----------------------
assert.equal(farmlinksTest.status, 'test')
assert.ok(farmlinksTest.brokenHoles >= 3, `broken holes ${farmlinksTest.brokenHoles}`)
assert.equal(farmlinksTest.completeHoles, 0)
assert.equal(farmlinksTest.strokes, 0)
assert.equal(farmlinksTest.sg.total, null)

// --- Small rules --------------------------------------------------------------
assert.equal(history.lieFromSurface(12), 'unknown')
assert.equal(history.isRangeRound('multi_range_gsp', -1), true)
assert.equal(history.prettifyCourseKey('GreyWolf_gsp'), 'Grey Wolf')
assert.equal(history.prettifyCourseKey('farmlinks_al_2_7_gsp'), 'Farmlinks')
assert.ok(Math.abs(history.tourExpectedStrokes('green', 1) - 1.053) < 1e-9, '3 ft putt')
assert.ok(history.tourExpectedStrokes('tee', 400) < history.tourExpectedStrokes('fairway', 400))

console.log(`round history ok: Old Game ${oldGame.strokes} (${oldGame.putts} putts, SG ${oldGame.sg.total.toFixed(2)}), FarmLinks test session excluded`)
await server?.close()
