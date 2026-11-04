// Map-area courses: GSPro's holes on an unnumbered map area (src/courseGeometry/areaCourse.ts).
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

try {
  const { parseGkdLayout } = await load('/src/courseGeometry/nativeGkd.ts')
  const { parseAreaPackage, fitRegistrationFromArea, buildAreaHoleGeometry } = await load('/src/courseGeometry/areaCourse.ts')
  const { holeLocalYdsToLatLon, nativeWorldToHoleLocalYds } = await load('/src/courseGeometry/nativeRegistration.ts')
  const { classifyTacticalLandingPoint } = await load('/src/courseGeometry/tacticalClassification.ts')
  const { estimateGreywolfTerrain: terrainAt } = await load('/src/courseGeometry/lidar.ts')

  const YD = 1.0936133
  // The map: an area frame (x east, y north yards) at a real latitude.
  const frame = { anchorLatLon: [43.186, -124.391], headingDegreesTrue: 0 }
  // GSPro's scene is turned 30° and shifted against the map: ground = R·(world - w0).
  const TURN = 30 * Math.PI / 180
  const w0 = { x: 5000, z: -3000 }
  const groundOf = (w) => {
    const dx = w.x - w0.x, dz = w.z - w0.z
    return [Math.cos(TURN) * dx - Math.sin(TURN) * dz, Math.sin(TURN) * dx + Math.cos(TURN) * dz] // east, north metres
  }
  const areaYds = (w) => groundOf(w).map((m) => m * YD)
  // Terrain: a tilted plane plus a hill, feet, over the area.
  const elevFt = (x, y) => 300 + 0.04 * x - 0.02 * y + 25 * Math.exp(-((x - 200) ** 2 + (y - 150) ** 2) / 20000)

  // Nine holes in GSPro's world, each ~380 m, laid out in a loop.
  const holes = []
  // Irregular, as real routings are (an even ring would look the same turned 40°).
  const radii = [520, 640, 700, 450, 610, 760, 530, 690, 580]
  const angles = [0, 0.55, 1.4, 2.0, 2.6, 3.5, 4.1, 4.9, 5.6]
  for (let i = 0; i < 9; i += 1) {
    const angle = angles[i]
    const tee = { x: w0.x + radii[i] * Math.cos(angle), z: w0.z + radii[i] * Math.sin(angle) }
    const dir = angle + Math.PI / 2 + 0.3
    const green = { x: tee.x + 380 * Math.cos(dir), z: tee.z + 380 * Math.sin(dir) }
    const aim = { x: tee.x + 240 * Math.cos(dir), z: tee.z + 240 * Math.sin(dir) }
    holes.push({ tee, green, aim })
  }
  const yOf = (w) => { const [x, y] = areaYds(w); return elevFt(x, y) / 3.28084 - 12 } // GSPro y = ground - 12 m
  const P = (w) => ({ x: w.x, y: yOf(w), z: w.z })
  const pinsAround = (g) => [[0, 6], [-5, -4], [7, -2], [2, 9], [-6, 3]].map(([dx, dz]) => ({ Position: P({ x: g.x + dx, z: g.z + dz }) }))
  const gkd = {
    CourseName: 'Area Test',
    Holes: holes.map((h, i) => ({
      HoleNumber: i + 1, Par: 4,
      Tees: [
        { TeeType: 'Black', Position: P(h.tee), Distance: 380 },
        { TeeType: 'AimPoint1', Position: P(h.aim) },
        { TeeType: 'GreenCenterPoint', Position: P(h.green) },
      ],
      Pins: pinsAround(h.green),
    })),
  }
  const layout = parseGkdLayout(JSON.stringify(gkd))

  // The map area: this course's greens plus a neighbouring course's (a resort),
  // hole 1's fairway, and another fairway 70 yd to its side.
  const ring = (cx, cy, r, n = 16) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos(2 * Math.PI * k / n), cy + r * Math.sin(2 * Math.PI * k / n)])
  const greensYds = holes.map((h) => areaYds(h.green))
  const neighbour = Array.from({ length: 12 }, (_, k) => [1500 + 140 * (k % 4), -900 + 160 * Math.floor(k / 4)])
  const [tx, ty] = areaYds(holes[0].tee)
  const [gx, gy] = areaYds(holes[0].green)
  const ux = (gx - tx) / Math.hypot(gx - tx, gy - ty), uy = (gy - ty) / Math.hypot(gx - tx, gy - ty)
  const strip = (off) => [[tx + 180 * ux - (17 - off) * uy, ty + 180 * uy + (17 - off) * ux], [tx + 380 * ux - (17 - off) * uy, ty + 380 * uy + (17 - off) * ux],
    [tx + 380 * ux - (-17 - off) * uy, ty + 380 * uy + (-17 - off) * ux], [tx + 180 * ux - (-17 - off) * uy, ty + 180 * uy + (-17 - off) * ux]]
  const own = strip(0)
  const other = strip(-70)
  const bunker = ring(tx + 260 * ux + 25 * uy, ty + 260 * uy - 25 * ux, 8)

  // 2-yd terrain grid over the area, deflate + base64 as the cloud builds it.
  const minX = -1200, minY = -1200, spacing = 2, width = 1601, height = 1601
  const values = new Uint16Array(width * height)
  for (let r = 0; r < height; r += 1) for (let c = 0; c < width; c += 1) values[r * width + c] = Math.round((elevFt(minX + c * spacing, minY + r * spacing) - 200) * 10)
  const terrain = {
    source: 'lidar-dem', sourceResolutionMeters: 1, runtimeSpacingYds: spacing, interpolation: 'bilinear',
    minX, minY, width, height, elevationOffsetFt: 200, nodata: 65535, compression: 'deflate',
    valuesBase64: deflateSync(Buffer.from(values.buffer)).toString('base64'),
  }
  const pkgJson = {
    schemaVersion: 'looper-course-area-v1', courseId: 'area-test', courseName: 'Area Test',
    enrichment: { schemaVersion: 'looper-course-enrichment-v1' },
    area: {
      coordinateFrame: { ...frame, origin: 'area-centre' },
      viewBounds: { minX, maxX: minX + spacing * (width - 1), minY, maxY: minY + spacing * (height - 1) },
      surfaces: {
        green: [...greensYds.map(([x, y]) => ring(x, y, 14)), ...neighbour.map(([x, y]) => ring(x, y, 13))],
        fairway: [own, other],
        bunker: [bunker],
      },
      context: { woods: [ring(tx + 200 * ux - 60 * uy, ty + 200 * uy + 60 * ux, 15)] },
      terrain,
      greens: [...greensYds, ...neighbour].map(([x, y], k) => ({ id: `way/${k}`, latLon: holeLocalYdsToLatLon(frame, [x, y]) })),
    },
  }
  const area = await parseAreaPackage('area-test', pkgJson)
  assert.equal(area.greens.length, 21)
  assert.ok(area.terrain && area.lidar)

  // 1. GSPro's greens find theirs among 21 unnumbered map greens; the scene's 30° turn is recovered.
  const fit = await fitRegistrationFromArea({ courseId: 'area-test', gsproCourseKey: 'area_test_gsp', layout, area })
  assert.ok(fit.registration, fit.reason)
  assert.equal(fit.paired, 9, fit.reason)
  assert.ok(Math.abs((fit.registration.rotationDeg ?? 0) - 30) < 0.2, `turn ${fit.registration.rotationDeg}`)
  assert.match(fit.registration.grade, /^[AB]$/)
  assert.ok(fit.registration.holes['1'].anchorWorldXZ, 'hole frames sit in GSPro metres')

  // 2. Hole 1 on the map area.
  const entry = { id: 'area-test', name: 'Area Test', location: '' }
  const hole = buildAreaHoleGeometry({ entry, layout, registration: fit.registration, holeNumber: 1, area })
  const local = (w) => nativeWorldToHoleLocalYds(fit.registration, 1, w)
  const tee = local(holes[0].tee)
  const green = local(holes[0].green)
  assert.ok(Math.abs(Math.hypot(green[0] - tee[0], green[1] - tee[1]) - 380 * YD) < 0.05, 'tee to green is GSPro\'s distance')
  assert.ok(Math.abs(green[0]) < 0.05, 'green straight up the frame')
  // Its own fairway is fairway; the neighbouring one is rough; its green is the map's green.
  const along = (d, side = 0) => local({ x: holes[0].tee.x + (d / 380) * (holes[0].green.x - holes[0].tee.x), z: holes[0].tee.z + (d / 380) * (holes[0].green.z - holes[0].tee.z) }).map((v, k) => v + (k === 0 ? side : 0))
  assert.equal(classifyTacticalLandingPoint(hole, along(250)).kind, 'fairway')
  // The other fairway runs 70 yd to the left (area yards = hole yards, turned).
  assert.equal(classifyTacticalLandingPoint(hole, [along(250)[0] - 70, along(250)[1]]).kind, 'rough',
    "the neighbouring hole's fairway is rough here, never a target")
  assert.equal(classifyTacticalLandingPoint(hole, green).kind, 'green')
  assert.ok(hole.surfaces.some((s) => s.kind === 'bunker'), 'map bunkers on the hole')
  assert.ok(hole.contextLayers?.some((l) => l.kind === 'woods'), 'map trees on the hole')
  // Terrain is the map's LiDAR, turned into the hole frame.
  const [teeX, teeY] = areaYds(holes[0].tee)
  const atTee = terrainAt(hole, tee)
  assert.equal(atTee.source, 'lidar-dem')
  assert.ok(Math.abs(atTee.elevationFt - elevFt(teeX, teeY)) < 0.3, `tee elevation ${atTee.elevationFt.toFixed(2)} vs ${elevFt(teeX, teeY).toFixed(2)}`)
  const [gX, gY] = areaYds(holes[0].green)
  assert.ok(Math.abs(terrainAt(hole, green).elevationFt - elevFt(gX, gY)) < 0.3)
  assert.equal(hole.provenance.geometrySource, 'osm-course-area+gspro-course-file')

  // 3. A course that isn't on this map area is refused with a reason.
  // Every hole moved by its own 120-300 m: a different course's green layout.
  const move = (h, i) => {
    const dx = 120 + 180 * Math.abs(Math.sin(i * 2.3)), dz = 150 * Math.cos(i * 1.9)
    const m = (p) => ({ ...p, x: p.x + dx, z: p.z + dz })
    return { ...h, Tees: h.Tees.map((t) => ({ ...t, Position: m(t.Position) })), Pins: h.Pins.map((p) => ({ ...p, Position: m(p.Position) })) }
  }
  const elsewhere = parseGkdLayout(JSON.stringify({ ...gkd, Holes: gkd.Holes.map(move) }))
  const refused = await fitRegistrationFromArea({ courseId: 'area-test', gsproCourseKey: 'other', layout: elsewhere, area })
  assert.equal(refused.registration, null)
  assert.ok(refused.reason.length > 10)

  // 4. Outside LiDAR coverage: a coarse 30 m model with errors of its own (a
  // surface model's trees, smoothing). The greens place the course, and the
  // grid takes GSPro's heights, so plays-like deltas follow the sim's ground.
  const errFt = (x, y) => 6 + 9 * Math.sin(x / 120) * Math.cos(y / 150)
  const coarseValues = new Uint16Array(width * height)
  for (let r = 0; r < height; r += 1) for (let c = 0; c < width; c += 1) {
    const x = minX + c * spacing, y = minY + r * spacing
    coarseValues[r * width + c] = Math.round((elevFt(x, y) + errFt(x, y) - 200) * 10)
  }
  const { enrichment: _lidar, ...noLidar } = pkgJson
  const coarseArea = await parseAreaPackage('area-test', {
    ...noLidar,
    area: { ...pkgJson.area, terrain: { ...terrain, source: 'global-dem', sourceResolutionMeters: 30,
      valuesBase64: deflateSync(Buffer.from(coarseValues.buffer)).toString('base64') } },
  })
  assert.equal(coarseArea.terrain?.source, 'global-dem')
  assert.equal(coarseArea.lidar, false)
  const coarseFit = await fitRegistrationFromArea({ courseId: 'area-test', gsproCourseKey: 'area_test_gsp', layout, area: coarseArea })
  assert.ok(coarseFit.registration, coarseFit.reason)
  assert.equal(coarseFit.paired, 9)
  assert.match(coarseFit.reason, /placed from the greens .*coarse terrain/)
  assert.ok(Math.abs((coarseFit.registration.rotationDeg ?? 0) - 30) < 0.5, `coarse turn ${coarseFit.registration.rotationDeg}`)
  const coarseHole = buildAreaHoleGeometry({ entry, layout, registration: coarseFit.registration, holeNumber: 1, area: coarseArea })
  const cLocal = (w) => nativeWorldToHoleLocalYds(coarseFit.registration, 1, w)
  const cTee = terrainAt(coarseHole, cLocal(holes[0].tee))
  const cGreen = terrainAt(coarseHole, cLocal(holes[0].green))
  const cAim = terrainAt(coarseHole, cLocal(holes[0].aim))
  assert.equal(cTee.source, 'global-dem')
  const [aX, aY] = areaYds(holes[0].aim)
  const trueDelta = elevFt(gX, gY) - elevFt(teeX, teeY)
  const rawDelta = (elevFt(gX, gY) + errFt(gX, gY)) - (elevFt(teeX, teeY) + errFt(teeX, teeY))
  assert.ok(Math.abs(rawDelta - trueDelta) > 2, `the coarse model alone is off by ${(rawDelta - trueDelta).toFixed(1)} ft`)
  assert.ok(Math.abs((cGreen.elevationFt - cTee.elevationFt) - trueDelta) < 0.5,
    `tee to green ${(cGreen.elevationFt - cTee.elevationFt).toFixed(2)} ft vs GSPro's ${trueDelta.toFixed(2)}`)
  assert.ok(Math.abs((cAim.elevationFt - cTee.elevationFt) - (elevFt(aX, aY) - elevFt(teeX, teeY))) < 0.5, 'tee to aim point')
  assert.match(coarseHole.terrain.note, /bent to \d+ GSPro heights/)

  console.log(`PASS: map-area course: ${fit.paired}/9 GSPro greens found among 21 map greens, turned ${(fit.registration.rotationDeg).toFixed(2)}°, grade ${fit.registration.grade}; `
    + 'own fairway kept, neighbour\'s demoted, map green, bunkers, trees and LiDAR terrain on GSPro\'s hole; '
    + `coarse 30 m terrain placed by the greens and bent to GSPro's heights (tee to green ${(cGreen.elevationFt - cTee.elevationFt).toFixed(1)} ft `
    + `vs GSPro ${trueDelta.toFixed(1)}; the raw model said ${rawDelta.toFixed(1)}).`)
} finally {
  await server?.close()
}
