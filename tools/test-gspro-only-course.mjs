// GSPro-only courses: holes built from GSPro's course file alone (no map).
// src/courseGeometry/gsproOnlyCourse.ts, gsproOnlyCourses.ts.
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

try {
  const { parseGkdLayout, sha256Hex } = await load('/src/courseGeometry/nativeGkd.ts')
  const {
    buildGsproOnlyHoleGeometry, gsproOnlyCatalogEntry, gsproOnlyHoleHeadings, gsproOnlyRegistration,
    gsproOnlyCourseKey, isGsproOnlyCourseId,
  } = await load('/src/courseGeometry/gsproOnlyCourse.ts')
  const { nativeWorldToHoleLocalYds, nativeHoleLocalYdsToWorld } = await load('/src/courseGeometry/nativeRegistration.ts')
  const { estimateGreywolfTerrain: terrainAt } = await load('/src/courseGeometry/lidar.ts')
  const { pointInPolygon } = await load('/src/courseGeometry/geometry.ts')
  const { gkdHazardSurfaces, withGkdHazards } = await load('/src/courseGeometry/nativeHazards.ts')
  const { classifyTacticalLandingPoint } = await load('/src/courseGeometry/tacticalClassification.ts')

  // A two-hole course file. Hole 1: par 4 heading 30° true (NE), 380 m from the
  // back tee, rising 8 m. Hole 2: par 3 heading west over a pond.
  const along = (start, deg, m, dy = 0) => {
    const r = (deg * Math.PI) / 180
    return { x: start.x + Math.sin(r) * m, y: start.y + dy, z: start.z + Math.cos(r) * m }
  }
  const P = (p) => ({ x: p.x, y: p.y, z: p.z })
  const t1 = { x: 0, y: 10, z: 0 }
  const g1 = along(t1, 30, 380, 8)
  const a1 = along(t1, 30, 240, 4)
  const white1 = along(t1, 30, 40, 0.5)
  const t2 = { x: 300, y: 20, z: 300 }
  const g2 = along(t2, 270, 150, -5)
  const pinsAround = (g) => [[0, 6], [-5, -4], [7, -2], [2, 9]].map(([dx, dz]) => ({ Position: P({ x: g.x + dx, y: g.y + 0.2, z: g.z + dz }), Day: 'Thursday' }))
  const gkd = {
    CourseName: 'Test Links',
    Location: 'Nowhere, USA',
    Holes: [
      {
        HoleNumber: 1, Par: 4,
        Tees: [
          { TeeType: 'Black', Position: P(t1), Distance: 380 },
          { TeeType: 'White', Position: P(white1), Distance: 340 },
          { TeeType: 'AimPoint1', Position: P(a1) },
          { TeeType: 'GreenCenterPoint', Position: P(g1) },
        ],
        Pins: pinsAround(g1),
      },
      {
        HoleNumber: 2, Par: 3,
        Tees: [
          { TeeType: 'Black', Position: P(t2), Distance: 150 },
          { TeeType: 'GreenCenterPoint', Position: P(g2) },
        ],
        Pins: pinsAround(g2),
      },
    ],
    // A pond in front of hole 2's green, 60-100 m from the tee.
    Hazards: [{ coords: [[200, 240], [240, 240], [240, 360], [200, 360]].map(([x, z]) => ({ x, y: 12, z })) }],
  }
  const layout = parseGkdLayout(JSON.stringify(gkd))
  const entry = gsproOnlyCatalogEntry({ courseKey: 'test_links_gsp', courseName: 'Test Links', location: 'Nowhere, USA', altitude: 1000 })
  assert.ok(isGsproOnlyCourseId(entry.id) && gsproOnlyCourseKey(entry.id) === 'test_links_gsp')
  assert.equal(entry.source, 'gspro-only')
  assert.equal(entry.packageStatus, 'ready')

  const registration = gsproOnlyRegistration({
    courseId: entry.id, courseKey: 'test_links_gsp', layout, altitudeFt: 1000,
    layoutFingerprint: await sha256Hex(layout.fingerprintText),
    sceneFingerprint: await sha256Hex(layout.sceneFingerprintText),
  })

  // 1. Frames: the back tee is the origin; the hole runs straight up the frame.
  const local = (p, hole = 1) => nativeWorldToHoleLocalYds(registration, hole, p)
  const tee = local(t1)
  const green = local(g1)
  assert.ok(Math.hypot(...tee) < 0.01, `back tee at the origin, got ${tee}`)
  assert.ok(Math.abs(green[0]) < 1e-6, `green straight ahead, got ${green}`)
  const yds = 380 * 1.0936133
  assert.ok(Math.abs(Math.hypot(green[0] - tee[0], green[1] - tee[1]) - yds) < 0.01,
    `tee to green ${Math.hypot(green[0] - tee[0], green[1] - tee[1]).toFixed(2)} yd vs GSPro ${yds.toFixed(2)}`)
  // 20 m right of the line at 200 m reads right of the line.
  const right = local({ x: t1.x + Math.sin(Math.PI / 6) * 200 + Math.cos(Math.PI / 6) * 20, y: 0, z: t1.z + Math.cos(Math.PI / 6) * 200 - Math.sin(Math.PI / 6) * 20 })
  assert.ok(Math.abs(right[0] - 20 * 1.0936133) < 0.01 && Math.abs(right[1] - 200 * 1.0936133) < 0.01, `right of line ${right}`)
  // Round trip (Auto Aim targets go back to GSPro world).
  const back = nativeHoleLocalYdsToWorld(registration, 1, [10, 150])
  const again = local(back)
  assert.ok(Math.abs(again[0] - 10) < 1e-6 && Math.abs(again[1] - 150) < 1e-6)
  const headings = gsproOnlyHoleHeadings(registration)
  assert.ok(Math.abs(headings[0] - 30) < 1e-9 && Math.abs(headings[1] - 270) < 1e-9, `headings ${headings.slice(0, 2)}`)

  // 2. The hole.
  const hole1 = buildGsproOnlyHoleGeometry({ entry, layout, registration, holeNumber: 1 })
  assert.equal(hole1.par, 4)
  assert.deepEqual(hole1.teeCandidates.map((c) => c.teeSet).sort(), ['Black', 'White'])
  assert.ok(Math.hypot(...hole1.markers.tee) < 0.01, 'tee marker at the back tee')
  const whiteTee = hole1.teeCandidates.find((c) => c.teeSet === 'White').coursePoint
  assert.ok(Math.abs(whiteTee[1] - 40 * 1.0936133) < 0.2, `white tee 40 m up: ${whiteTee}`)
  const greenRing = hole1.surfaces.find((s) => s.kind === 'green').polygons[0]
  for (const pin of layout.holes[0].pins) assert.ok(pointInPolygon(local(pin), greenRing), 'every pin is on the green')
  assert.equal(classifyTacticalLandingPoint(hole1, green).kind, 'green')
  assert.equal(classifyTacticalLandingPoint(hole1, [0, 200]).kind, 'unknown', 'no fairway invented')
  assert.equal(hole1.availability.fairway, 'unavailable')
  assert.equal(hole1.provenance.geometrySource, 'gspro-course-file')

  // 3. Terrain from GSPro's heights: exact at the points, plays-like tee to green.
  assert.ok(hole1.terrain, 'terrain grid built')
  const atTee = terrainAt(hole1, tee)
  const atGreen = terrainAt(hole1, green)
  assert.equal(atTee.source, 'gspro-heights')
  assert.ok(Math.abs((atGreen.elevationFt - atTee.elevationFt) - 8 * 3.28084) < 1.5,
    `tee to green rise ${(atGreen.elevationFt - atTee.elevationFt).toFixed(1)} ft vs 26.2`)
  const atAim = terrainAt(hole1, local(a1))
  assert.ok(Math.abs((atAim.elevationFt - atTee.elevationFt) - 4 * 3.28084) < 2, `aim point rise ${(atAim.elevationFt - atTee.elevationFt).toFixed(1)}`)
  // Altitude: GSPro's ground sits at the course altitude (air density).
  assert.ok(Math.abs(atTee.elevationFt - 1000) < 60, `tee elevation ${atTee.elevationFt.toFixed(0)} ft near the 1000 ft course`)

  // 4. Hole 2: GSPro's pond becomes water on the hole, as for any course.
  const hole2 = buildGsproOnlyHoleGeometry({ entry, layout, registration, holeNumber: 2 })
  const hazards = gkdHazardSurfaces(layout, registration, hole2)
  assert.ok(hazards.summary.penaltyAreas >= 1, 'the pond is on hole 2')
  const withPond = withGkdHazards(hole2, hazards.surfaces)
  const inPond = local({ x: 220, y: 12, z: 300 }, 2)
  assert.ok(['water', 'penalty'].includes(classifyTacticalLandingPoint(withPond, inPond).kind),
    `pond classifies as water (${classifyTacticalLandingPoint(withPond, inPond).kind})`)
  assert.equal(classifyTacticalLandingPoint(withPond, local(g2, 2)).kind, 'green')

  // 4b. The engine on a GSPro-only hole: 164-yd par 3 over GSPro's pond
  //     (66–109 yd out). A wedge that comes up in the pond loses to the club
  //     that carries it, with no fairway map at all.
  const { evaluateAimLab } = await load('/src/liveCaddie/aimOptimization.ts')
  const NOW = Date.parse('2026-11-04T12:00:00Z')
  const shotsFor = (club, stock, speed, launch, spin) => Array.from({ length: 24 }, (_, i) => ({
    id: `${club}-${i}`, club, included: true, enrichmentStatus: 'enriched', source: 'simread',
    capturedAt: new Date(NOW - 86400000 * (1 + (i % 3)) + i * 1000).toISOString(),
    carryYards: stock + ((i % 7) - 3) * 1.5, totalYards: stock + ((i % 7) - 3) * 1.5 + 4, offlineYards: ((i % 5) - 2) * 2.5,
    ballSpeedMph: speed, launchAngleDeg: launch, spinRpm: spin,
  }))
  const sessions = [0, 1, 2].map((k) => ({
    id: `s${k}`, startedAt: new Date(NOW - 86400000 * (1 + k)).toISOString(),
    endedAt: new Date(NOW - 86400000 * (1 + k) + 3600000).toISOString(),
    shots: [...shotsFor('7i', 160, 114, 17, 6200), ...shotsFor('PW', 95, 84, 26, 9000)].filter((_, i) => i % 3 === k),
  }))
  const tee2 = local(t2, 2)
  const pin2 = local({ ...g2 }, 2)
  const evals = evaluateAimLab(sessions, withPond, tee2, pin2,
    { shotOrigin: 'tee', surfaceOverride: 'tee', exactPinLocalYds: pin2 }, NOW)
  const top = evals.find((e) => e.decisionRank === 1)
  const pw = evals.find((e) => e.club === 'PW')
  assert.equal(top?.club, '7i', `7i carries the pond (got ${top?.club})`)
  assert.ok((pw?.bestCandidate?.riskProfile?.bySurface?.water ?? 0) + (pw?.bestCandidate?.riskProfile?.bySurface?.penalty ?? 0) > 0.5,
    'the wedge finds the pond')

  // 5. Alternate layout tees answer to "White (Kids)".
  const alt = buildGsproOnlyHoleGeometry({ entry, layout, registration, holeNumber: 1, altLayoutName: 'Kids' })
  assert.ok(alt.teeCandidates.find((c) => c.teeSet === 'White').teeAliases.includes('White (Kids)'))

  // 6. Catalog: GSPro-only entries resolve from GSPro's key; a loaded map wins.
  const catalog = await load('/src/courseGeometry/courseCatalog.ts')
  const { gsproOnlyLoadedMatch } = await load('/src/courseGeometry/gsproOnlyCourses.ts')
  catalog.registerRuntimeCourses([entry])
  assert.equal(catalog.resolveCourseIdFromGsproName('test_links_gsp'), entry.id)
  assert.equal(gsproOnlyLoadedMatch(entry), null, 'no loaded map yet')
  catalog.registerRuntimeCourses([{
    id: 'test-links-loaded', name: 'Test Links Golf Club', location: 'Nowhere', slug: 'test-links',
    gsproAliases: ['Test Links Golf Club'], staticPackageUrl: 'https://example.invalid/test-links/course-v1.json',
    status: 'validated', packageStatus: 'ready', packageVersion: 'v1',
    packageCacheStatus: 'cached', osmCacheStatus: 'cached', lidarCacheStatus: 'cached',
  }])
  assert.equal(gsproOnlyLoadedMatch(entry), 'test-links-loaded', 'a loaded map with the same name takes over')
  catalog.registerRuntimeCourses([{ ...gsproOnlyCatalogEntry({ courseKey: 'pinehurst2_0_2_gsp', courseName: 'Pinehurst 2' }) }])
  assert.equal(catalog.resolveCourseIdFromGsproName('pinehurst2_0_2_gsp'), 'gspro:pinehurst2_0_2_gsp')

  console.log(`PASS: GSPro-only holes from the course file: tee-to-green ${Math.hypot(green[0], green[1]).toFixed(2)} yd vs GSPro ${yds.toFixed(2)}; `
    + `all pins on the green; GSPro heights give +${(atGreen.elevationFt - atTee.elevationFt).toFixed(1)} ft; pond is water; loaded map wins.`)
} finally {
  await server?.close()
}
