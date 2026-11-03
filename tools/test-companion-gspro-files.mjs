// GSPro files through the Looper Companion: the companion-backed folder handle
// must behave like the browser folder grant for every existing reader, and
// recorded round records must parse with the same rules as the live file.
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

const companion = await load('/src/adapters/companionGsproFiles.ts')
const access = await load('/src/adapters/browserGsproAccess.ts')
const archive = await load('/src/adapters/browserGsproCourseArchive.ts')

const shot = (roundId, shotId, globalShot, extra = {}) => ({
  RoundID: roundId, ShotID: shotId, Hole: 0, HoleShot: globalShot, GlobalShotNumber: globalShot,
  CourseKey: 'Links_v1', StartingPOS: { x: 0, y: 0, z: 0 }, EndingPOS: { x: 0, y: 0, z: 150 },
  DistanceToPin: 20, BallSpeed: 50, TotalDistance: 150, ...extra,
})

// A fake companion on 127.0.0.1:8787 serving an in-memory GSPro folder.
const enc = new TextEncoder()
const files = new Map([
  ['currentRound.dat', { bytes: enc.encode(JSON.stringify([shot(41, 'a', 1), shot(42, 'b', 2)])), lastModified: 1700000000000 }],
  ['output_log.txt', { bytes: enc.encode('line one\nline two\nPenalty Surface X\n'), lastModified: 1700000000500 }],
])
const calls = []
let statusCalls = 0
let companionUp = true
companion.__setCompanionFetchForTests(async (request) => {
  const url = new URL(request.url)
  calls.push(url.pathname + url.search)
  assert.equal(url.host, '127.0.0.1:8787')
  if (!companionUp) throw new TypeError('fetch failed')
  if (url.pathname.endsWith('/status')) {
    statusCalls += 1
    return Response.json({ service: 'looper-companion', version: 'test', capabilities: { gsproFiles: true } })
  }
  if (url.pathname.endsWith('/gspro-file')) {
    const name = url.searchParams.get('name')
    const file = files.get(name)
    if (url.searchParams.get('stat') === '1') {
      return Response.json(file
        ? { status: 'ok', name, size: file.bytes.length, lastModified: file.lastModified }
        : { status: 'not-found', name })
    }
    if (!file) return Response.json({ status: 'not-found', name }, { status: 404 })
    const start = Number(url.searchParams.get('start') ?? 0)
    const end = url.searchParams.has('end') ? Number(url.searchParams.get('end')) : file.bytes.length
    return new Response(file.bytes.slice(start, end), {
      headers: { 'X-Looper-File-Size': String(file.bytes.length), 'X-Looper-Last-Modified': String(file.lastModified) },
    })
  }
  return new Response('{}', { status: 404 })
})

// 1. The loader every reader uses prefers the companion, with granted permission.
const handle = await access.loadGsproDirectoryHandle()
assert.ok(companion.isCompanionGsproDirectoryHandle(handle), 'companion handle is used')
assert.equal(await access.queryGsproDirectoryPermission(handle, 'readwrite'), 'granted')
assert.equal(await access.isGsproAccessAvailable(), true)

// 2. File semantics the readers rely on: size, lastModified, text, tail slices.
const log = await (await handle.getFileHandle('output_log.txt')).getFile()
const logText = new TextDecoder().decode(files.get('output_log.txt').bytes)
assert.equal(log.size, files.get('output_log.txt').bytes.length)
assert.equal(log.lastModified, 1700000000500)
assert.equal(await log.text(), logText)
assert.equal(await log.slice(Math.max(0, log.size - 18)).text(), logText.slice(-18))
assert.equal(await log.slice(5, 8).text(), logText.slice(5, 8))
assert.ok(calls.some((call) => call.includes('name=output_log.txt&start=')), 'tail is a ranged read')

// 3. Missing files fail like the browser (NotFoundError), and writes are refused.
await assert.rejects(async () => (await handle.getFileHandle('GSPro.db')).getFile(), { name: 'NotFoundError' })
await assert.rejects(() => handle.getFileHandle('looper-live-caddie-profiles.json', { create: true }))

// 4. The existing live reader works through the companion unchanged: newest round only.
const live = await archive.readBrowserGsproCourseRoundArchive()
assert.equal(live.roundId, 42)
assert.deepEqual(live.shots.map((s) => s.shotId), ['b'])

// 5. Availability is cached between polls.
const before = statusCalls
await access.loadGsproDirectoryHandle()
await access.loadGsproDirectoryHandle()
assert.equal(statusCalls, before, 'status is not re-probed on every poll')

// 6. Recorded records: every round, latest version of a shot wins, IDs may repeat across rounds.
const rounds = archive.archiveRoundsFromRecords([
  shot(7, '1', 1),
  shot(7, '2', 2, { DistanceToPin: 30 }),
  shot(8, '1', 1),
  shot(7, '2', 2, { DistanceToPin: 1, activeShot: { sd: { isHoled: true } } }),
  { ShotID: 'junk' },
  shot(9, 'no-flight', 1, { BallSpeed: 0, TotalDistance: 0 }),
])
const byRound = new Map(rounds.map((round) => [round.roundId, round]))
assert.deepEqual([...byRound.keys()].sort(), [7, 8])
assert.deepEqual(byRound.get(7).shots.map((s) => s.shotId), ['1', '2'])
assert.equal(byRound.get(7).shots[1].isHoled, true, 'later record version wins')
assert.equal(byRound.get(8).shots.length, 1, 'same ShotID in another round is kept')

// 7. Without the companion, the loader falls back (no saved folder here -> null).
companion.__setCompanionFetchForTests(async () => { throw new TypeError('fetch failed') })
assert.equal(await access.loadGsproDirectoryHandle(), null)

if (server) await server.close()
console.log('companion GSPro files: ok')
