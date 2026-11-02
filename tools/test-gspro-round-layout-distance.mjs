// Shot 1 distance: GSPro's round layout (output_log) beats the pixel-measured
// minimap ruler when the two agree, e.g. FarmLinks H1 White: ruler 497, GSPro 492.6.
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

const { layoutTeeForHole, refineTeeDistanceWithLayout, createOutputLogLayoutReader } =
  await load('/src/adapters/gsproRoundLayoutDistance.ts')

const M = 1 / 1.0936132983377078
const hole = (par, yds, dy = 0, pinX = 0) => ({
  active: true, par, teePos: { x: 0, y: 10, z: 0 }, pinPos: { x: pinX, y: 10 + dy, z: yds * M },
})
const layout = (firstHoleYds, pinX = 0) => [hole(5, firstHoleYds, -12, pinX),
  ...Array.from({ length: 17 }, (_, i) => hole(4, 380 + i))]

// 1. Horizontal distance (GSPro's DistanceToPin), not 3D.
const rows = layout(492.6)
const h1 = layoutTeeForHole(rows, 1)
assert.equal(h1.distanceYds, 492.6)
assert.equal(h1.par, 5)
assert.equal(layoutTeeForHole(rows, 19), null)

// 2. Agreeing ruler -> exact GSPro number; disagreeing or wrong par -> ruler.
assert.deepEqual(refineTeeDistanceWithLayout(497, h1, 1, 5), { distanceYds: 492.6, source: 'gspro-round-layout' })
assert.equal(refineTeeDistanceWithLayout(530, h1, 1, 5).source, 'minimap-ruler', 'stale or other course')
assert.equal(refineTeeDistanceWithLayout(497, h1, 1, 4).source, 'minimap-ruler', 'par mismatch')
assert.equal(refineTeeDistanceWithLayout(497, h1, 2, 5).source, 'minimap-ruler', 'other hole')
assert.equal(refineTeeDistanceWithLayout(497, null, 1, 5).distanceYds, 497)

// 3. Incremental output_log reader: finds the layout, picks up a newer round's
// layout appended later, and starts over on a new GSPro session.
const fakeFile = (text) => {
  const bytes = Buffer.from(text, 'utf8')
  const reads = []
  return {
    size: bytes.length, reads,
    slice: (start = 0, end = bytes.length) => ({
      text: async () => { reads.push([start, end]); return bytes.subarray(start, end).toString('utf8') },
    }),
  }
}
const log1 = 'GSPro started\nnoise\n' + JSON.stringify(layout(492.6)) + '\nmore log lines\n'
const read = createOutputLogLayoutReader()
let got = await read(fakeFile(log1))
assert.equal(layoutTeeForHole(got, 1).distanceYds, 492.6)

const same = fakeFile(log1)
await read(same)
assert.equal(same.reads.length, 0, 'unchanged size: no re-read')

const log2 = log1 + 'x'.repeat(100_000) + JSON.stringify(layout(488.1)) + '\n'
const grown = fakeFile(log2)
got = await read(grown)
assert.equal(layoutTeeForHole(got, 1).distanceYds, 488.1, 'new round, new pin')
assert.ok(grown.reads.every(([s, e]) => e - s <= 64_000 + 200_000), 'reads only appended bytes')

const grownNoLayout = fakeFile(log2 + 'y'.repeat(50))
got = await read(grownNoLayout)
assert.equal(layoutTeeForHole(got, 1).distanceYds, 488.1, 'keeps the last layout')

const restarted = fakeFile('GSPro restarted\n' + 'z'.repeat(400_000))
got = await read(restarted)
assert.equal(got, null, 'new session without a layout yet')

if (server) await server.close()
console.log('gspro round layout distance: ok')
