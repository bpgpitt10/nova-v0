// Green slopes built in the browser from a hole's 2-yd LiDAR terrain (greenDetailFromTerrain.ts),
// checked against the shipped green-detail packages on every bundled full-map course.
//
// Two builds per green:
//   direct     the hole's own 2-yd terrain, as a full-map course has it
//   area-like  that terrain sampled onto a 2-yd grid turned 37 degrees and shifted, then back into
//              the hole's frame: what an area course goes through (its grid is in the course's
//              frame, not the hole's), and a little more smoothing than the real thing
// Two kinds of shipped package:
//   from the 2-yd hole terrain (FarmLinks, Kiawah, Muirfield, RNK, Valhalla): should match direct
//   from the 1 m DEM at 1 yd (Arcadia, Cabot, Payne's, Pebble, Triggs, Trosper, Wynn): what 2 yd loses
// What's compared is what a player sees: the putt's aim and the chip's break aim, in inches.
//
// Run: node tools/test-area-green-detail.mjs [--verbose]
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { createServer } from 'vite'

const verbose = process.argv.includes('--verbose')
const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { greenDetailFromTerrain } = await server.ssrLoadModule('/src/courseGeometry/greenDetailFromTerrain.ts')
  const { parsePackageTerrain } = await server.ssrLoadModule('/src/courseGeometry/routePackagedCourseLoader.ts')
  const { analyzeGreen } = await server.ssrLoadModule('/src/liveCaddie/greenRead.ts')
  const { slopeFieldFromGreenRead, aimPutt } = await server.ssrLoadModule('/src/liveCaddie/puttRead.ts')
  const { chipBreakAimFt } = await server.ssrLoadModule('/src/liveCaddie/chipOptions.ts')

  const COURSES = ['farmlinks', 'kiawah-island-ocean', 'muirfield-village', 'royal-new-kent', 'valhalla',
    'arcadia-bluffs', 'cabot-cliffs', 'paynes-valley', 'pebble-beach', 'triggs-memorial', 'trosper', 'wynn']

  let seed = 20261124
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }

  const shippedDetail = (raw, holeNumber) => {
    const g = raw.grid
    const buf = inflateSync(Buffer.from(g.valuesBase64, 'base64'))
    const values = new Uint16Array(g.width * g.height)
    for (let i = 0; i < values.length; i += 1) values[i] = buf.readUInt16LE(i * 2)
    return { holeNumber, greenBoundsYds: raw.greenBoundsYds, greenSampleCount: raw.greenSampleCount, greenSummary: raw.greenSummary,
      sectors: raw.sectors, grid: { minX: g.minX, minY: g.minY, spacingYds: g.spacingYds, width: g.width, height: g.height, elevationOffsetFt: g.elevationOffsetFt, nodata: 65535, values } }
  }

  // The area path: sample onto a turned 2-yd grid, then bilinear back into the hole's frame.
  const areaLike = (t) => {
    const th = (37 * Math.PI) / 180
    const cos = Math.cos(th), sin = Math.sin(th)
    const sp = t.runtimeSpacingYds
    const toArea = ([x, y]) => [cos * x - sin * y + 0.7, sin * x + cos * y + 1.3]
    const toHole = ([u, v]) => { const a = u - 0.7, b = v - 1.3; return [cos * a + sin * b, -sin * a + cos * b] }
    const sample = (grid, x, y) => {
      const gx = (x - grid.minX) / grid.sp, gy = (y - grid.minY) / grid.sp
      const c0 = Math.floor(gx), r0 = Math.floor(gy)
      if (c0 < 0 || r0 < 0 || c0 >= grid.w - 1 || r0 >= grid.h - 1) return NaN
      const v = (c, r) => grid.z[r * grid.w + c]
      const dc = gx - c0, dr = gy - r0
      return v(c0, r0) * (1 - dc) * (1 - dr) + v(c0 + 1, r0) * dc * (1 - dr) + v(c0, r0 + 1) * (1 - dc) * dr + v(c0 + 1, r0 + 1) * dc * dr
    }
    const hz = new Float64Array(t.width * t.height)
    for (let i = 0; i < hz.length; i += 1) hz[i] = t.values[i] === t.nodata ? NaN : t.elevationOffsetFt + t.values[i] / 10
    const holeGrid = { minX: t.minX, minY: t.minY, sp, w: t.width, h: t.height, z: hz }
    const corners = [[t.minX, t.minY], [t.minX + sp * (t.width - 1), t.minY], [t.minX, t.minY + sp * (t.height - 1)], [t.minX + sp * (t.width - 1), t.minY + sp * (t.height - 1)]].map(toArea)
    const aMinX = Math.min(...corners.map((p) => p[0])), aMaxX = Math.max(...corners.map((p) => p[0]))
    const aMinY = Math.min(...corners.map((p) => p[1])), aMaxY = Math.max(...corners.map((p) => p[1]))
    const aw = Math.ceil((aMaxX - aMinX) / sp) + 1, ah = Math.ceil((aMaxY - aMinY) / sp) + 1
    const az = new Float64Array(aw * ah)
    for (let r = 0; r < ah; r += 1) for (let c = 0; c < aw; c += 1) {
      const [x, y] = toHole([aMinX + c * sp, aMinY + r * sp])
      az[r * aw + c] = sample(holeGrid, x, y)
    }
    const areaGrid = { minX: aMinX, minY: aMinY, sp, w: aw, h: ah, z: az }
    let lo = Infinity
    const back = new Float64Array(t.width * t.height)
    for (let r = 0; r < t.height; r += 1) for (let c = 0; c < t.width; c += 1) {
      const [u, v] = toArea([t.minX + c * sp, t.minY + r * sp])
      const z = sample(areaGrid, u, v)
      back[r * t.width + c] = z
      if (z < lo) lo = z
    }
    const off = Math.floor(lo * 10) / 10
    const values = new Uint16Array(back.length)
    for (let i = 0; i < back.length; i += 1) values[i] = Number.isFinite(back[i]) ? Math.round((back[i] - off) * 10) : 65535
    return { ...t, elevationOffsetFt: off, values, nodata: 65535 }
  }

  const inside = (x, y, ring) => {
    let hit = false
    let [xj, yj] = ring[ring.length - 1]
    for (const [xi, yi] of ring) { if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) + 1e-12) + xi) hit = !hit; xj = xi; yj = yi }
    return hit
  }
  const pct = (list, q) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN }

  const groups = { terrain: { direct: [], area: [] }, dem: { direct: [], area: [] } }
  const elev = { terrain: { direct: [], area: [] }, dem: { direct: [], area: [] } }
  const tilt = { terrain: { direct: [], area: [] }, dem: { direct: [], area: [] } }
  let greensChecked = 0
  const flatHoles = []
  for (const slug of COURSES) {
    const dir = `public/course-geometry/${slug}`
    if (!existsSync(`${dir}/course-v1-lidar.json`) || !existsSync(`${dir}/green-detail-v1.json`)) continue
    const course = JSON.parse(readFileSync(`${dir}/course-v1-lidar.json`, 'utf8'))
    const shipped = JSON.parse(readFileSync(`${dir}/green-detail-v1.json`, 'utf8'))
    const kind = String(shipped.source?.crs ?? '').includes('packaged LiDAR') ? 'terrain' : 'dem'
    for (let holeNumber = 1; holeNumber <= 18; holeNumber += 1) {
      const hole = course.holes[String(holeNumber)]
      const raw = shipped.holes[String(holeNumber)]
      if (!hole?.terrain || !raw?.grid) continue
      const terrain = await parsePackageTerrain(hole.terrain, slug, holeNumber)
      const greens = (hole.surfaces.green ?? []).filter((r) => r.length >= 3)
      if (!terrain || !greens.length) continue
      const ref = shippedDetail(raw, holeNumber)
      // Terrain that is one height everywhere (Trosper and Wynn as bundled) builds no map at all.
      if (terrain.values.every((v) => v === terrain.values[0])) {
        assert.equal(greenDetailFromTerrain(holeNumber, terrain, greens), null, `${slug} H${holeNumber}: flat terrain builds nothing`)
        flatHoles.push(`${slug} H${holeNumber}`)
        continue
      }
      const builds = { direct: greenDetailFromTerrain(holeNumber, terrain, greens), area: greenDetailFromTerrain(holeNumber, areaLike(terrain), greens) }
      const refRead = analyzeGreen(ref, greens)
      if (!refRead) continue
      const refSlope = slopeFieldFromGreenRead(refRead)
      // The target green (largest ring), and points well inside it.
      const area = (r) => Math.abs(r.reduce((sum, p, i) => sum + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0)) / 2
      const ring = [...greens].sort((a, b) => area(b) - area(a))[0]
      const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1])
      const box = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      const onGreen = () => {
        for (let k = 0; k < 200; k += 1) {
          const p = [box[0] + rand() * (box[1] - box[0]), box[2] + rand() * (box[3] - box[2])]
          if (inside(p[0], p[1], ring) && refSlope(p)) return p
        }
        return null
      }
      const pairs = []
      for (let k = 0; k < 8; k += 1) {
        const pin = onGreen()
        const ball = onGreen()
        if (pin && ball) {
          const ft = Math.hypot(pin[0] - ball[0], pin[1] - ball[1]) * 3
          if (ft >= 8 && ft <= 50) pairs.push([ball, pin])
        }
      }
      // A patch of terrain that is one height over the green (a gap in the survey filled flat:
      // Payne's 1 and 15) builds no map, rather than a level one.
      if (!builds.direct) {
        const { terrainFt } = await server.ssrLoadModule('/src/courseGeometry/greenDetailFromTerrain.ts')
        const zs = []
        for (let x = box[0]; x <= box[1]; x += 1) for (let y = box[2]; y <= box[3]; y += 1) {
          if (inside(x, y, ring)) zs.push(terrainFt(terrain, x, y))
        }
        assert.ok(Math.max(...zs) - Math.min(...zs) < 0.15, `${slug} H${holeNumber}: no map built, yet the terrain over the green isn't flat`)
        flatHoles.push(`${slug} H${holeNumber}`)
        continue
      }
      greensChecked += 1
      for (const which of ['direct', 'area']) {
        const detail = builds[which]
        assert.ok(detail, `${slug} H${holeNumber} ${which}: no detail built`)
        // Heights on the green, offset removed (a single offset doesn't move a ball).
        const diffs = []
        for (let r = 0; r < ref.grid.height; r += 1) for (let c = 0; c < ref.grid.width; c += 1) {
          const x = ref.grid.minX + c * ref.grid.spacingYds, y = ref.grid.minY + r * ref.grid.spacingYds
          if (!inside(x, y, ring)) continue
          const a = ref.grid.values[r * ref.grid.width + c]
          const gc = Math.round((x - detail.grid.minX) / detail.grid.spacingYds), gr = Math.round((y - detail.grid.minY) / detail.grid.spacingYds)
          const b = detail.grid.values[gr * detail.grid.width + gc]
          if (a === 65535 || b === undefined || b === 65535) continue
          diffs.push(ref.grid.elevationOffsetFt + a / 10 - (detail.grid.elevationOffsetFt + b / 10))
        }
        const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length
        const rmsIn = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / diffs.length) * 12
        elev[kind][which].push(rmsIn)
        tilt[kind][which].push(Math.abs(detail.greenSummary.planeSlopePercent - ref.greenSummary.planeSlopePercent))
        const read = analyzeGreen(detail, greens)
        assert.ok(read, `${slug} H${holeNumber} ${which}: no read`)
        const slope = slopeFieldFromGreenRead(read)
        for (const [ball, pin] of pairs) {
          const a = aimPutt(refSlope, ball, pin, 11)
          const b = aimPutt(slope, ball, pin, 11)
          if (!a || !b) continue
          const chipA = chipBreakAimFt(refSlope, [ball[0] - 6, ball[1] - 6], pin, { flight: { carryYds: 6 }, runYds: Math.hypot(pin[0] - ball[0], pin[1] - ball[1]) }, 11)
          const chipB = chipBreakAimFt(slope, [ball[0] - 6, ball[1] - 6], pin, { flight: { carryYds: 6 }, runYds: Math.hypot(pin[0] - ball[0], pin[1] - ball[1]) }, 11)
          groups[kind][which].push({ slug, holeNumber, puttRef: a.aimOffsetFt * 12, putt: b.aimOffsetFt * 12, chipRef: chipA == null ? null : chipA * 12, chip: chipB == null ? null : chipB * 12 })
        }
      }
    }
  }

  const report = (label, rows, rmsList, tiltList) => {
    const puttErr = rows.map((r) => Math.abs(r.putt - r.puttRef))
    const chipRows = rows.filter((r) => r.chip != null && r.chipRef != null)
    const chipErr = chipRows.map((r) => Math.abs(r.chip - r.chipRef))
    // Same side: of the reads that break 6 in or more by the shipped map, how many break the same way.
    const big = rows.filter((r) => Math.abs(r.puttRef) >= 6)
    const sameSide = big.filter((r) => Math.sign(r.putt) === Math.sign(r.puttRef)).length
    const relErr = big.map((r) => Math.abs(r.putt - r.puttRef) / Math.abs(r.puttRef))
    const out = {
      label, greens: rmsList.length, putts: rows.length,
      heightRmsIn: { median: +pct(rmsList, 0.5).toFixed(2), p90: +pct(rmsList, 0.9).toFixed(2) },
      tiltDiffPct: { median: +pct(tiltList, 0.5).toFixed(2), p90: +pct(tiltList, 0.9).toFixed(2) },
      puttAimErrIn: { median: +pct(puttErr, 0.5).toFixed(1), p90: +pct(puttErr, 0.9).toFixed(1), max: +Math.max(...puttErr).toFixed(1) },
      puttBreak6inPlus: { n: big.length, sameSide: `${sameSide}/${big.length}`, relErrMedian: +pct(relErr, 0.5).toFixed(2), relErrP90: +pct(relErr, 0.9).toFixed(2) },
      chipAimErrIn: { n: chipRows.length, median: +pct(chipErr, 0.5).toFixed(1), p90: +pct(chipErr, 0.9).toFixed(1) },
    }
    console.log(JSON.stringify(out))
    if (verbose) {
      const worst = [...rows].sort((a, b) => Math.abs(b.putt - b.puttRef) - Math.abs(a.putt - a.puttRef)).slice(0, 5)
      for (const w of worst) console.log('   worst', w.slug, `H${w.holeNumber}`, 'ref', w.puttRef.toFixed(1), 'got', w.putt.toFixed(1))
    }
    return out
  }
  console.log(`greens checked: ${greensChecked}; terrain flat over the green, nothing built: ${flatHoles.length} holes (${[...new Set(flatHoles.map((h) => h.split(' ')[0]))].join(', ')})`)
  const tDirect = report('built from 2-yd terrain · direct', groups.terrain.direct, elev.terrain.direct, tilt.terrain.direct)
  const tArea = report('built from 2-yd terrain · area-like', groups.terrain.area, elev.terrain.area, tilt.terrain.area)
  const dDirect = report('built from 1 m DEM · direct', groups.dem.direct, elev.dem.direct, tilt.dem.direct)
  const dArea = report('built from 1 m DEM · area-like', groups.dem.area, elev.dem.area, tilt.dem.area)

  // Same input, same method: the browser build reproduces the packaged builder.
  // Heights agree to the packages' own rounding (a tenth of a foot, so about 0.35 in RMS).
  assert.ok(tDirect.heightRmsIn.p90 < 0.6, 'direct build matches the packaged builder')
  assert.ok(tDirect.puttAimErrIn.median < 1.5 && tDirect.puttAimErrIn.p90 < 5, 'direct build gives the same putt aims')
  // The area path against greens built the same way (2-yd terrain): the same reads, near enough.
  const sameShare = (r) => { const [same, of] = r.puttBreak6inPlus.sameSide.split('/').map(Number); return same / of }
  assert.ok(sameShare(tArea) >= 0.98, `area-like breaks the same way: ${tArea.puttBreak6inPlus.sameSide}`)
  assert.ok(tArea.puttAimErrIn.median <= 3, `area-like median aim error ${tArea.puttAimErrIn.median} in`)
  // Against greens built from the 1 m survey: 2 yd keeps the direction of nearly every putt that
  // breaks 6 in or more, and loses detail on the amount (reported, not held to the same line).
  assert.ok(sameShare(dArea) >= 0.93, `against the 1 m greens, breaks the same way: ${dArea.puttBreak6inPlus.sameSide}`)
  console.log('area green detail ok')
} finally {
  await server.close()
}
