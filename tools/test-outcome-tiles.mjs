// Outcome tiles always add to 100: off-map landings count as Trouble.
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
const { outcomeTiles } = await load('/src/liveCaddie/outcomeShares.ts')

// FarmLinks H1 Driver: 75 / 20 / <1 trouble / 0, plus ~5% past the mapped hole.
const tiles = outcomeTiles({ success: 0.746, manageable: 0.199, seriousTrouble: 0.004, catastrophe: 0, unknown: 0.051 })
assert.deepEqual(tiles.map((t) => t.text), ['75%', '20%', '5%', '0%'])
assert.equal(tiles.reduce((s, t) => s + t.percent, 0), 100)

// Rounding never leaves 99 or 101.
for (const risk of [
  { success: 0.333, manageable: 0.333, seriousTrouble: 0.334, catastrophe: 0, unknown: 0 },
  { success: 0.995, manageable: 0.003, seriousTrouble: 0.001, catastrophe: 0.001, unknown: 0 },
]) {
  const t = outcomeTiles(risk)
  assert.equal(t.reduce((s, x) => s + x.percent, 0), 100, JSON.stringify(t))
}
const tiny = outcomeTiles({ success: 0.995, manageable: 0.003, seriousTrouble: 0.001, catastrophe: 0.001, unknown: 0 })
assert.equal(tiny[3].text, '<1%', 'a real but tiny chance is not shown as 0%')
assert.equal(outcomeTiles(null), null)

// GSPro-only course (no map): unmapped ground is "In play", not trouble (Pinehurst 2 tee showed 99% trouble).
const unmapped = outcomeTiles({ success: 0, manageable: 0.002, seriousTrouble: 0, catastrophe: 0.01, unknown: 0.988 }, 'in-play')
assert.deepEqual(unmapped.map((x) => x.label), ['Success', 'In play', 'Trouble', 'Catastrophe'])
assert.equal(unmapped[1].percent, 99)
assert.equal(unmapped[2].text, '0%')

if (server) await server.close()
console.log('outcome tiles: ok')
