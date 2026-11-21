// A shared sim: which GSPro player's shots belong to this Looper account (Brian, 21 Nov).
// Run: node tools/test-gspro-players.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { archiveRoundsFromRecords, gsproPlayerOf } = await server.ssrLoadModule('/src/adapters/browserGsproCourseArchive.ts')
  const { decideRound, roundForPlayers } = await server.ssrLoadModule('/src/lib/gsproPlayers.ts')

  const pos = (x) => ({ x, y: 0, z: 0 })
  let n = 0
  const shot = (player, guid, extra = {}) => {
    n += 1
    return {
      ShotID: `s${n}`, RoundID: 7, Hole: 0, HoleShot: n, GlobalShotNumber: n, CourseKey: 'Test GC',
      BallSpeed: 100, TotalDistance: 100, StartingPOS: pos(n), EndingPOS: pos(n + 1),
      PlayerName: player, UserGuid: guid, ...extra,
    }
  }

  // Ids and names come off the record; an empty id falls back to the name.
  assert.deepEqual(gsproPlayerOf({ PlayerName: 'Brian', UserGuid: 'AB-12' }), { key: 'ab-12', name: 'Brian', guid: 'ab-12' })
  assert.equal(gsproPlayerOf({ PlayerName: 'Mike', UserGuid: '00000000-0000-0000-0000-000000000000' }).key, 'name:mike')
  assert.equal(gsproPlayerOf({}).key, 'unknown')

  // Two players taking turns in one round.
  const records = [shot('Brian', 'g-b'), shot('Mike', 'g-m'), shot('Brian', 'g-b'), shot('Mike', 'g-m'), shot('Brian', 'g-b',
    { activeShot: { sd: { isPutt: true, path: [] } }, StartingSurface: 5 })]
  const [round] = archiveRoundsFromRecords(records)
  assert.deepEqual(round.players.map((p) => [p.name, p.shots]), [['Brian', 3], ['Mike', 2]])

  const none = new Map()
  const brianClaimed = new Map([['g-b', { verdict: 'mine', name: 'Brian' }]])
  const mikeNotMe = new Map([['g-m', { verdict: 'not-mine', name: 'Mike' }]])

  // Fresh account, two players: ask.
  assert.equal(decideRound(round.players, none).kind, 'ask')
  // Brian claimed: only Brian's shots and putts, Mike's never asked about.
  const mine = decideRound(round.players, brianClaimed)
  assert.equal(mine.kind, 'mine')
  const part = roundForPlayers(round, mine.keys)
  assert.equal(part.shots.length, 3)
  assert.ok(part.shots.every((s) => s.player.name === 'Brian'))
  assert.equal(part.puttDetails.length, 1)

  // Fresh account, one player: claimed automatically.
  const [solo] = archiveRoundsFromRecords([shot('Brian', 'g-b')].map((r) => ({ ...r, RoundID: 8 })))
  const auto = decideRound(solo.players, none)
  assert.equal(auto.kind, 'mine')
  assert.equal(auto.claim?.key, 'g-b')
  // Someone else played alone on Brian's account: ask, don't take it.
  const [friend] = archiveRoundsFromRecords([shot('Mike', 'g-m')].map((r) => ({ ...r, RoundID: 9 })))
  assert.equal(decideRound(friend.players, brianClaimed).kind, 'ask')
  // ...unless he already said Mike isn't him.
  assert.equal(decideRound(friend.players, new Map([...brianClaimed, ...mikeNotMe])).kind, 'not-mine')
  // A claim made from a name alone matches that name.
  assert.equal(decideRound(round.players, new Map([['name:brian', { verdict: 'mine', name: 'Brian' }]])).kind, 'mine')
  // Old records with no player keep working as before.
  const [legacy] = archiveRoundsFromRecords([{ ...shot(undefined, undefined), RoundID: 10 }])
  assert.equal(decideRound(legacy.players, brianClaimed).kind, 'mine')

  console.log('gspro players ok')
} finally {
  await server.close()
}
