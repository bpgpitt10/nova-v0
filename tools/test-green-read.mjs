// Green read: steepness kept at full strength, overall tilt, tiers and spines,
// and a one-line read relative to the shot.
import assert from 'node:assert/strict'
let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
const { analyzeGreen, greenReadLine, greenSlopeImage, greenHeightImage } = await load('/src/liveCaddie/greenRead.ts')

const W = 40; const H = 40
const make = (fz) => {
  const values = new Uint16Array(W * H)
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) values[y * W + x] = Math.round(fz(x, y) * 10) + 500
  return { grid: { minX: -20, minY: 100, spacingYds: 1, width: W, height: H, elevationOffsetFt: 0, nodata: 65535, values } }
}
const green = [[[-16, 104], [16, 104], [16, 136], [-16, 136]]] // 32 x 32 yd
const ball = [0, 0]
const pin = [0, 120]

// 1. Flat: nothing to play around.
let a = analyzeGreen(make(() => 0), green)
assert.ok(a.tiltPercent < 0.1 && a.features.length === 0)
assert.equal(greenReadLine(a, ball, pin), 'Flat green: nothing to play around. Aim at the pin.')

// 2. One steady 4% tilt back toward the player (falls toward -y): full-strength
// steepness everywhere, no tier invented, and the spin-back warning.
a = analyzeGreen(make((x, y) => y * 3 * 0.04), green)
assert.ok(Math.abs(a.tiltPercent - 4) < 0.2, String(a.tiltPercent))
assert.equal(a.features.length, 0)
const mid = 20 * W + 20
assert.ok(a.slopePercent[mid] > 3.8, String(a.slopePercent[mid]))
let line = greenReadLine(a, ball, pin)
assert.match(line, /^Tilts [34]\.\d% back toward you: wedges will spin back\. Land it past the hole\./)
assert.match(line, /Leave it short of the hole for an uphill putt\./)
// Same green, approached from the other side: it now releases away.
assert.match(greenReadLine(a, [0, 240], pin), /^Tilts [34]\.\d% away from you: it will release/)
// From the side: it feeds.
assert.match(greenReadLine(a, [-120, 120], pin), /^Tilts [34]\.\d% left to right: it will feed right after it lands\. Leave it right of the hole/)

// Pin cut 2 yd from the low (front) edge: no room to leave it short of the hole.
const edgeLine = greenReadLine(a, ball, [0, 106])
assert.doesNotMatch(edgeLine, /uphill putt/, edgeLine)
assert.match(edgeLine, /Pin is near the front edge: favor the middle of the green\./)

// 3. A 1.2 ft tier across the middle: flat below, a 6-yd face, flat above.
const tierZ = (x, y) => (y < 17 ? 0 : y > 23 ? 1.2 : ((y - 17) / 6) * 1.2)
a = analyzeGreen(make(tierZ), green)
const tiers = a.features.filter((f) => f.kind === 'tier')
assert.equal(tiers.length, 1, JSON.stringify(a.features))
assert.ok(tiers[0].riseFt > 0.9 && tiers[0].riseFt < 1.3, String(tiers[0].riseFt))
line = greenReadLine(a, ball, [0, 130])
assert.match(line, /Pin on the upper tier \(1\.\d ft step\): stay on its level\./)
assert.match(greenReadLine(a, ball, [0, 108]), /Pin on the lower tier/)

// 4. A spine down the middle: falls off both sides.
a = analyzeGreen(make((x) => 1.5 - Math.abs(x - 20) * 3 * 0.025), green)
assert.ok(a.features.some((f) => f.kind === 'spine'), JSON.stringify(a.features))
assert.match(greenReadLine(a, ball, pin), /Spine in the green/)

// Heatmap image: a PNG the size of the grid.
const img = greenSlopeImage(analyzeGreen(make((x, y) => y * 3 * 0.04), green))
assert.ok(img.dataUrl.startsWith('data:image/png;base64,'))
assert.deepEqual([img.x, img.y, img.width, img.height], [-20.5, 99.5, 40, 40])

// Height map (GSPro style): coloured on a tilted green, nothing on a flat one.
const tilted = greenHeightImage(analyzeGreen(make((x, y) => y * 3 * 0.04), green))
assert.ok(tilted && tilted.dataUrl.startsWith('data:image/png;base64,') && tilted.reliefFt > 3, String(tilted?.reliefFt))
assert.equal(greenHeightImage(analyzeGreen(make(() => 0), green)), null)

console.log('green read: ok')
await server?.close()
