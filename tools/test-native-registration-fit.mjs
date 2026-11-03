// Browser-side GSPro <-> real-world registration (for newly loaded courses).
// Synthetic terrain and course only; the real FarmLinks check (grade A, 14 cm
// from the 1 m Python fit, 0.7 s) was run offline with the player's GKD.
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
  const fit = await load('/src/courseGeometry/nativeRegistrationFit.ts')
  const reg = await load('/src/courseGeometry/nativeRegistration.ts')

  // Ground truth: GSPro origin placement + height offset.
  const truth = { latLon: [38.25, -85.48], worldXZ: [1210.37, 845.62], dy: 140.25 }
  const truthReg = reg.parseNativeRegistration({
    schemaVersion: 'looper-native-registration-v1', courseId: 't', gsproCourseKey: 't_gsp',
    layoutFingerprint: 'a'.repeat(64), grade: 'A',
    reference: { latLon: truth.latLon, worldXZ: truth.worldXZ }, worldYToElevationOffsetM: truth.dy,
    holes: { 1: { anchorLatLon: truth.latLon, headingDegreesTrue: 0 } },
  })
  // Rolling terrain (metres) as a function of lat/lon.
  const ground = (lat, lon) => {
    const n = (lat - 38.25) * 111000, e = (lon + 85.48) * 87000
    return 150 + 4 * Math.sin(e / 37) + 3 * Math.cos(n / 29) + 1.5 * Math.sin((e + n) / 11)
  }
  // GKD-like pins/green centres spread over ~1 km, at true ground height.
  const points = []
  const greens = []
  for (let i = 0; i < 18; i += 1) {
    const cx = 900 + (i % 6) * 160, cz = 500 + Math.floor(i / 6) * 300
    for (const [dx, dz] of [[0, 0], [6, 3], [-5, 4], [3, -6], [-4, -5]]) {
      const x = cx + dx, z = cz + dz
      const [lat, lon] = reg.nativeWorldToLatLon(truthReg, { x, z })
      points.push({ x, y: ground(lat, lon) - truth.dy, z })
    }
    const [glat, glon] = reg.nativeWorldToLatLon(truthReg, { x: cx, z: cz })
    // Mapped green centres are only roughly right (OSM): 4 m off.
    greens.push({ world: { x: cx, z: cz }, latLon: [glat + 4 / 111000, glon - 3 / 87000] })
  }
  const result = fit.fitNativeRegistration({
    courseId: 't', gsproCourseKey: 't_gsp', layoutFingerprint: 'a'.repeat(64), sceneFingerprint: 'b'.repeat(64),
    points, greens, holes: { 1: { anchorLatLon: truth.latLon, headingDegreesTrue: 0 } }, sampler: ground,
  })
  assert.equal(result.grade, 'A')
  assert.ok(result.medianAbsM < 0.02, `median ${result.medianAbsM}`)
  // The recovered registration places every point where the truth does.
  for (const p of points.slice(0, 20)) {
    const a = reg.nativeWorldToLatLon(truthReg, p), b = reg.nativeWorldToLatLon(result.registration, p)
    const m = Math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * 87000)
    assert.ok(m < 0.1, `point off by ${m.toFixed(3)} m`)
  }
  assert.ok(Math.abs(result.registration.worldYToElevationOffsetM - truth.dy) < 0.05)
  assert.ok(reg.parseNativeRegistration(result.registration), 'output is a valid registration file')

  // Flat terrain carries no horizontal information: halves disagree -> rejected.
  const flat = fit.fitNativeRegistration({
    courseId: 't', gsproCourseKey: 't_gsp', layoutFingerprint: 'a'.repeat(64), sceneFingerprint: 'b'.repeat(64),
    points: points.map((p) => ({ ...p, y: 10 })), greens, holes: {}, sampler: () => 10,
  })
  assert.equal(flat.registration, null, 'no terrain signal -> no registration')

  // Grid sampler: bilinear in feet with offset.
  const sampler = fit.terrainSamplerFromHoles([{
    frame: { anchorLatLon: [38.25, -85.48], headingDegreesTrue: 0 },
    terrain: { source: 'lidar-dem', sourceResolutionMeters: 1, runtimeSpacingYds: 2, interpolation: 'bilinear',
      minX: -10, minY: -10, width: 11, height: 11, elevationOffsetFt: 400, nodata: 65535,
      values: Uint16Array.from({ length: 121 }, (_, i) => (i % 11) * 10) },
  }])
  const [lat0, lon0] = [38.25, -85.48]
  const h = sampler(lat0, lon0) // local (0,0) -> column 5 -> 5 ft above offset
  assert.ok(Math.abs(h - 405 * 0.3048) < 0.01, `sampled ${h}`)
  assert.equal(sampler(39, -85.48), null, 'outside every hole grid')

  // Turned / scaled GSPro scenes (Valhalla is built at 180°, Royal New Kent at
  // about -12°). The greens give the turn roughly; the height fit refines it.
  const auto = await load('/src/courseGeometry/nativeRegistrationAuto.ts')
  for (const [rotationDeg, scale] of [[179.92, 1.0007], [-11.78, 1.0058]]) {
    const turned = reg.parseNativeRegistration({
      schemaVersion: 'looper-native-registration-v1', courseId: 't', gsproCourseKey: 't_gsp',
      layoutFingerprint: 'a'.repeat(64), grade: 'A',
      reference: { latLon: truth.latLon, worldXZ: truth.worldXZ }, rotationDeg, scale,
      worldYToElevationOffsetM: truth.dy, holes: { 1: { anchorLatLon: truth.latLon, headingDegreesTrue: 0 } },
    })
    assert.equal(turned.rotationDeg, rotationDeg)
    // Round trip world -> lat/lon -> world.
    const back = reg.nativeLatLonToWorld(turned, ...reg.nativeWorldToLatLon(turned, { x: 1500, z: 400 }))
    assert.ok(Math.hypot(back.x - 1500, back.z - 400) < 1e-6, 'round trip')
    const tPoints = [], tGreens = []
    for (let i = 0; i < 18; i += 1) {
      const cx = 900 + (i % 6) * 160, cz = 500 + Math.floor(i / 6) * 300
      for (const [dx, dz] of [[0, 0], [6, 3], [-5, 4], [3, -6], [-4, -5]]) {
        const x = cx + dx, z = cz + dz
        const [lat, lon] = reg.nativeWorldToLatLon(turned, { x, z })
        tPoints.push({ x, y: ground(lat, lon) - truth.dy, z })
      }
      const [glat, glon] = reg.nativeWorldToLatLon(turned, { x: cx, z: cz })
      // Mapped greens: a few metres of scatter, so the greens' turn is a bit off.
      const j = ((i * 7) % 5) - 2
      tGreens.push({ world: { x: cx, z: cz }, latLon: [glat + (3 * j) / 111000, glon - (2 * ((i % 3) - 1)) / 87000] })
    }
    const sim = auto.greenSimilarity(tGreens)
    assert.ok(Math.abs(sim.rotationDeg - rotationDeg) < 1, `greens rotation ${sim.rotationDeg}`)
    // Without the turn the true-north fit cannot place it.
    const plain = fit.fitNativeRegistration({
      courseId: 't', gsproCourseKey: 't_gsp', layoutFingerprint: 'a'.repeat(64), sceneFingerprint: 'b'.repeat(64),
      points: tPoints, greens: tGreens, holes: {}, sampler: ground,
    })
    assert.equal(plain.registration, null, `true-north fit should fail at ${rotationDeg}°`)
    const r = fit.fitNativeRegistration({
      courseId: 't', gsproCourseKey: 't_gsp', layoutFingerprint: 'a'.repeat(64), sceneFingerprint: 'b'.repeat(64),
      points: tPoints, greens: tGreens, holes: { 1: { anchorLatLon: truth.latLon, headingDegreesTrue: 0 } },
      sampler: ground, rotationDeg: sim.rotationDeg, scale: sim.scale,
    })
    assert.equal(r.grade, 'A', `grade at ${rotationDeg}°: ${r.grade} median ${r.medianAbsM} halves ${r.halvesAgreeM}`)
    let worst = 0
    for (const p of tPoints) {
      const a = reg.nativeWorldToLatLon(turned, p), b = reg.nativeWorldToLatLon(r.registration, p)
      worst = Math.max(worst, Math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * 87000))
    }
    assert.ok(worst < 0.15, `turned ${rotationDeg}°: worst point off by ${worst.toFixed(3)} m`)
    const parsed = reg.parseNativeRegistration(JSON.parse(JSON.stringify(r.registration)))
    assert.ok(Math.abs(parsed.rotationDeg - rotationDeg) < 0.01 && Math.abs(parsed.scale - scale) < 1e-4,
      `saved turn ${parsed.rotationDeg} / ${parsed.scale}`)
  }

  // GSPro's wind compass is the scene's: on a 180° scene "from N" is from true south.
  const wind = await load('/src/liveState/windProjection.ts')
  const w = { status: 'READY', speedMph: 10, directionDegrees: 0, convention: 'from', referenceFrame: 'compass' }
  assert.equal(wind.windInTrueCompass(w, 179.92).directionDegrees.toFixed(2), '180.08')
  assert.equal(wind.windInTrueCompass({ ...w, directionDegrees: 90 }, -11.78).directionDegrees.toFixed(2), '101.78')
  assert.equal(wind.windInTrueCompass(w, 0), w, 'true-north scene unchanged')
  assert.equal(wind.windInTrueCompass({ ...w, referenceFrame: 'shot-relative' }, 180).directionDegrees, 0)

  console.log('PASS: browser registration fit recovers a known GSPro placement within 10 cm (grade A), rejects flat terrain, grid sampling ok; turned scenes (180°, -12°, scaled) register within 15 cm.')
} finally {
  await server?.close()
}
