import type { CoursePointYds, CourseTerrainGrid } from '../courseGeometry/types'

/**
 * A subtle hillshade of a hole's terrain grid for the live map, as a PNG
 * data URL laid over the surfaces: shadowed slopes darken, lit slopes
 * lighten, flat ground is transparent. The light comes from the top-left of
 * the screen (cartographic convention), so it is computed for the current
 * map orientation (`right`/`up` are the screen axes in hole-local yards).
 *
 * PNG row 0 is terrain row 0 (minY); the map's transform puts it at the
 * bottom, so no flip is needed.
 */

export type Hillshade = {
  dataUrl: string
  /** Hole-local yards of the image's outer edges (cell centres +/- half a cell). */
  x: number
  y: number
  width: number
  height: number
}

const FT_PER_YD = 3
/** Golf terrain is gentle; exaggerate relief so swales and ridges read. */
const EXAGGERATION = 2.2
const ALTITUDE = (40 * Math.PI) / 180
const MAX_DARK_ALPHA = 0.3
const MAX_LIGHT_ALPHA = 0.05
const ALPHA_GAIN = 1.6

export const buildHillshade = (
  terrain: CourseTerrainGrid,
  right: CoursePointYds,
  up: CoursePointYds,
): Hillshade | null => {
  const { width: w, height: h, values, nodata } = terrain
  const s = terrain.runtimeSpacingYds
  if (!(w >= 3 && h >= 3 && s > 0) || values.length < w * h) return null

  // Light from screen top-left, in hole-local axes.
  const lx = (-right[0] + up[0]) / Math.SQRT2
  const ly = (-right[1] + up[1]) / Math.SQRT2
  const L = [lx * Math.cos(ALTITUDE), ly * Math.cos(ALTITUDE), Math.sin(ALTITUDE)]
  const flat = L[2]

  const z = (col: number, row: number) => {
    const c = Math.min(w - 1, Math.max(0, col))
    const r = Math.min(h - 1, Math.max(0, row))
    const v = values[r * w + c]
    return v === nodata ? Number.NaN : v / 10
  }
  const rgba = new Uint8Array(w * h * 4)
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) {
      if (values[row * w + col] === nodata) continue
      const dzdx = (z(col + 1, row) - z(col - 1, row)) / (2 * s * FT_PER_YD) * EXAGGERATION
      const dzdy = (z(col, row + 1) - z(col, row - 1)) / (2 * s * FT_PER_YD) * EXAGGERATION
      if (!Number.isFinite(dzdx) || !Number.isFinite(dzdy)) continue
      const norm = Math.hypot(dzdx, dzdy, 1)
      const shade = (-dzdx * L[0] - dzdy * L[1] + L[2]) / norm
      const delta = (shade - flat) * ALPHA_GAIN
      const i = (row * w + col) * 4
      if (delta < 0) {
        rgba[i + 3] = Math.round(Math.min(MAX_DARK_ALPHA, -delta) * 255)
      } else {
        rgba[i] = 255
        rgba[i + 1] = 255
        rgba[i + 2] = 255
        rgba[i + 3] = Math.round(Math.min(MAX_LIGHT_ALPHA, delta) * 255)
      }
    }
  }
  return {
    dataUrl: `data:image/png;base64,${base64(encodePngRgba(w, h, rgba))}`,
    x: terrain.minX - s / 2,
    y: terrain.minY - s / 2,
    width: w * s,
    height: h * s,
  }
}

// --- minimal PNG encoder (RGBA, stored/uncompressed deflate) ----------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (bytes: Uint8Array, start: number, end: number) => {
  let c = 0xffffffff
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export const encodePngRgba = (width: number, height: number, rgba: Uint8Array): Uint8Array => {
  const rowLen = width * 4 + 1
  const raw = new Uint8Array(rowLen * height)
  for (let r = 0; r < height; r += 1) {
    raw[r * rowLen] = 0 // filter: none
    raw.set(rgba.subarray(r * width * 4, (r + 1) * width * 4), r * rowLen + 1)
  }
  // zlib stream of stored deflate blocks
  const blocks = Math.max(1, Math.ceil(raw.length / 65535))
  const zlib = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  zlib[0] = 0x78
  zlib[1] = 0x01
  let o = 2
  for (let b = 0; b < blocks; b += 1) {
    const start = b * 65535
    const len = Math.min(65535, raw.length - start)
    zlib[o++] = b === blocks - 1 ? 1 : 0
    zlib[o++] = len & 0xff
    zlib[o++] = len >>> 8
    zlib[o++] = ~len & 0xff
    zlib[o++] = (~len >>> 8) & 0xff
    zlib.set(raw.subarray(start, start + len), o)
    o += len
  }
  let a = 1
  let bsum = 0
  for (let i = 0; i < raw.length; i += 1) {
    a = (a + raw[i]) % 65521
    bsum = (bsum + a) % 65521
  }
  const adler = ((bsum << 16) | a) >>> 0
  zlib[o++] = adler >>> 24
  zlib[o++] = (adler >>> 16) & 0xff
  zlib[o++] = (adler >>> 8) & 0xff
  zlib[o++] = adler & 0xff

  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
    return out
  }
  const ihdr = new Uint8Array(13)
  const hv = new DataView(ihdr.buffer)
  hv.setUint32(0, width)
  hv.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib),
    chunk('IEND', new Uint8Array(0)),
  ]
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let p = 0
  for (const part of parts) {
    png.set(part, p)
    p += part.length
  }
  return png
}

const base64 = (bytes: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
