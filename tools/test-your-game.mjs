// Your game (where you lose strokes): built from real captured rounds. The
// Old Game alone gives early reads, no "vs your normal", and putting without
// the 16 gimmes; a second round turns on the comparison.
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
  const { buildYourGame, FIRM_SHOTS } = await load('/src/lib/yourGame.ts')
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
  const records = rows.map(history.recordFromCloudRow)
  const rounds = history.buildRounds(records, { Links_v1: { name: 'The Old Game' } })

  const game = buildYourGame(rounds)
  assert.equal(game.rounds, 1, 'the FarmLinks test session is left out')
  assert.equal(game.holes, 18)
  assert.deepEqual(game.courses, ['The Old Game'])
  assert.ok(game.typical != null && game.typical < 0.5 && game.typical > -1, `typical ${game.typical}`)
  // Every field shot lands in exactly one rung.
  const old = rounds.find((r) => r.roundId === 268)
  const field = history.scoredShots(old).filter((s) => s.sg != null && (s.category === 'approach' || s.category === 'around-green'))
  assert.equal(game.ladder.reduce((sum, r) => sum + r.shots, 0), field.length)
  assert.ok(game.ladder.every((r) => r.dots <= 5 && r.onGreen <= r.shots))
  // Leaks and strengths are strokes per round vs your typical shot, early reads under 30 shots.
  for (const s of [...game.leaks, ...game.strengths]) {
    assert.equal(s.early, s.shots < FIRM_SHOTS)
    assert.ok(Math.abs(s.perRound - (s.sgPerShot - game.typical) * s.shots) < 1e-9, '18 holes: per round = per shot gap × shots')
  }
  assert.ok(game.leaks.every((s) => s.perRound < 0) && game.strengths.every((s) => s.perRound > 0))
  // Putting: 30 putts, 16 gimmes -> 14 real putts across the buckets.
  assert.equal(game.putting.reduce((sum, b) => sum + b.putts, 0), 14)
  assert.ok(game.putting[3].made >= 1, 'the 46-footer on 13')
  // One round: nothing to compare with yet.
  assert.equal(game.vsNormal, null)

  // A second, later copy of the round: the comparison turns on and reads even.
  const later = { ...old, roundId: 999, playedAt: '2099-01-01T00:00:00Z' }
  const two = buildYourGame([old, later])
  assert.equal(two.vsNormal.normalHoles, 18)
  assert.ok(two.vsNormal.rows.every((r) => r.perShot == null || Math.abs(r.perShot) < 1e-9), 'same shots -> no change')
  // Auto putt rounds keep putting out.
  assert.equal(buildYourGame([{ ...old, autoPutt: true }]).putting.reduce((sum, b) => sum + b.putts, 0), 0)

  console.log(`PASS: your game from the Old Game: typical ${game.typical.toFixed(2)}, leaks [${game.leaks.map((s) => `${s.label} ${s.perRound.toFixed(2)}`).join('; ')}], strengths [${game.strengths.map((s) => `${s.label} ${s.perRound.toFixed(2)}`).join('; ')}], putts ${game.putting.map((b) => `${b.label} ${b.made}/${b.putts}`).join(', ')}.`)
} finally {
  await server?.close()
}
