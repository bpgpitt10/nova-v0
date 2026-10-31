// The live map's hillshade: a valid PNG, transparent on flat ground, darker on
// slopes facing away from the (screen top-left) light.
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { buildHillshade, encodePngRgba } from '../src/liveCaddie/hillshade.ts'

const decode = (dataUrl) => {
  const png = Buffer.from(dataUrl.split(',')[1], 'base64')
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let o = 8; let w = 0; let h = 0; const idat = []
  while (o < png.length) {
    const len = png.readUInt32BE(o); const type = png.toString('ascii', o + 4, o + 8)
    const data = png.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4) }
    if (type === 'IDAT') idat.push(data)
    o += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  assert.equal(raw.length, h * (w * 4 + 1))
  return { w, h, alpha: (col, row) => raw[row * (w * 4 + 1) + 1 + col * 4 + 3], rgb: (col, row) => raw[row * (w * 4 + 1) + 1 + col * 4] }
}

// Encoder round-trips across multiple stored blocks.
const big = new Uint8Array(200 * 100 * 4).map((_, i) => i % 251)
const enc = encodePngRgba(200, 100, big)
const back = decode(`data:image/png;base64,${Buffer.from(enc).toString('base64')}`)
assert.equal(back.w, 200); assert.equal(back.h, 100)

// Terrain: flat west half, east half rising to the east (faces west = toward a
// top-left light when the map is pin-up with +x right). A ridge running north.
const w = 40; const h = 20; const values = new Uint16Array(w * h)
for (let r = 0; r < h; r += 1) for (let c = 0; c < w; c += 1) values[r * w + c] = 1000 + (c < 20 ? 0 : (c - 20) * 6)
const terrain = { source: 'lidar-dem', sourceResolutionMeters: 1, runtimeSpacingYds: 2, interpolation: 'bilinear', minX: 0, minY: 0, width: w, height: h, elevationOffsetFt: 500, nodata: 65535, values }
const up = [0, 1]; const right = [1, 0]
const shade = buildHillshade(terrain, right, up)
assert.ok(shade)
assert.deepEqual([shade.x, shade.y, shade.width, shade.height], [-1, -1, 80, 40])
const img = decode(shade.dataUrl)
assert.equal(img.alpha(5, 10), 0, 'flat ground is transparent')
// Rising to the east = facing west, toward the light: lit (white, faint).
assert.equal(img.rgb(30, 10), 255)
assert.ok(img.alpha(30, 10) > 0)
// Turn the map 180 degrees: the same slope now faces away from the light: shadow (black).
const flipped = decode(buildHillshade(terrain, [-1, 0], [0, -1]).dataUrl)
assert.equal(flipped.rgb(30, 10), 0)
assert.ok(flipped.alpha(30, 10) > img.alpha(30, 10), 'shadow is stronger than light')
// Nodata stays transparent.
values[10 * w + 30] = 65535
assert.equal(decode(buildHillshade(terrain, right, up).dataUrl).alpha(30, 10), 0)

console.log('hillshade: ok')
