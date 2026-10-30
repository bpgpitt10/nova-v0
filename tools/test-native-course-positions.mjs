// Native positions (beta): GKD parsing, fingerprint, registration and the
// snapshot overlay. Synthetic course only; no third-party GKD content.
// Cross-language expectations come from tools/course_model (Python) on
// course-model-prototype-v1.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

try {
  const gkd = await load('/src/courseGeometry/nativeGkd.ts')
  const reg = await load('/src/courseGeometry/nativeRegistration.ts')
  const snap = await load('/src/adapters/nativeCourseSnapshot.ts')

  const pos = (x, z, y = 10) => ({ x, y, z })
  // Same synthetic course as tools/course_model/test_gkd_native.py.
  const synthetic = {
    gkversion: 2.0, CourseName: 'Synthetic Links',
    Holes: [{
      HoleNumber: 1, Par: 4, Index: 7,
      Tees: [
        { TeeType: 'Black', Enabled: true, Distance: 150.0, Position: pos(0, 0) },
        { TeeType: 'White', Enabled: true, Distance: 130.0, Position: pos(0, 20) },
        { TeeType: 'Red', Enabled: true, Distance: 129.0, Position: pos(1, 21) },
        { TeeType: 'Yellow', Enabled: true, Distance: 0.0, Position: null },
        { TeeType: 'AimPoint1', Enabled: true, Distance: 0.0, Position: pos(0, 100) },
        { TeeType: 'AimPoint2', Enabled: true, Distance: 0.0, Position: null },
        { TeeType: 'GreenCenterPoint', Enabled: false, Distance: 0.0, Position: pos(30, 140) },
      ],
      Pins: [{ Day: 'Thursday', Position: pos(30, 135) }, { Day: 'Friday', Position: pos(36, 150) }],
    }],
  }
  const text = '﻿' + JSON.stringify(synthetic)
  const layout = gkd.parseGkdLayout(text)

  // 1. Fingerprint is byte-identical to the Python implementation.
  assert.equal(layout.fingerprintText, '1|Black:0,0;Red:10,210;White:0,200|300,1350;360,1500|300,1400')
  assert.equal(await gkd.sha256Hex(layout.fingerprintText),
    'a9aebbc26134b714d8da4137b213a58d63f9c1ed6e4d7c334cbd6d62606ff53d')
  const renamed = gkd.parseGkdLayout(JSON.stringify({ ...synthetic, CourseName: 'Renamed' }))
  assert.equal(renamed.fingerprintText, layout.fingerprintText, 'metadata does not change the fingerprint')

  // 2. Malformed files fail closed.
  assert.throws(() => gkd.parseGkdLayout('not json'), gkd.NativeGkdError)
  assert.throws(() => gkd.parseGkdLayout('{"CourseName":"x"}'), gkd.NativeGkdError)

  // 3. Tees, pins, routes.
  const hole = gkd.nativeHole(layout, 1)
  assert.equal(Object.keys(hole.tees).includes('Yellow'), false, 'null positions are skipped')
  assert.equal(gkd.resolveNativeTee(hole, { x: 0, z: 0 }).status, 'matched')
  const shared = gkd.resolveNativeTee(hole, { x: 0.3, z: 20.2 })
  assert.equal(shared.status, 'ambiguous-same-spot')
  assert.deepEqual([...shared.candidates].sort(), ['Red', 'White'])
  assert.equal(gkd.resolveNativeTee(hole, { x: 80, z: 80 }).status, 'no-match')
  const pin = gkd.resolveNativePinSlot(hole, { x: 30, z: 100 }, 35)
  assert.equal(pin.status, 'matched')
  assert.equal(pin.pin.slot, 1)
  assert.equal(gkd.resolveNativePinSlot(hole, { x: 30, z: 100 }, 999).status, 'no-match')
  assert.ok(Math.abs(gkd.nativeRouteDistanceM(hole.tees.Black, hole.aimPoints, hole.greenCenter) - 150) < 1e-9)
  assert.ok(Math.abs(gkd.nativeRouteDistanceM(pos(20, 120), hole.aimPoints, hole.greenCenter) - Math.hypot(10, 20)) < 1e-9,
    'forward tees skip aim points behind them')
  assert.equal(gkd.gkdTeeForTeeSet(hole, 'white').name, 'White')
  assert.equal(gkd.gkdTeeForTeeSet(hole, 'gold'), null)

  // 4. Published FarmLinks registration: GSPro world -> hole yards matches the
  //    Python generator (Round 255 shot 1 ending position, from currentRound.dat).
  const farmlinks = reg.parseNativeRegistration(JSON.parse(
    readFileSync(new URL('../public/course-geometry/farmlinks/native-registration-v1.json', import.meta.url), 'utf8')))
  assert.ok(farmlinks, 'registration parses')
  assert.equal(farmlinks.gsproCourseKey, 'farmlinks_al_2_7_gsp')
  const r255 = reg.nativeWorldToHoleLocalYds(farmlinks, 1, { x: 1180.69287, z: 800.2199 })
  assert.ok(Math.abs(r255[0] - -33.103) < 0.002 && Math.abs(r255[1] - 114.458) < 0.002, `R255 end ${r255}`)
  assert.equal(reg.nativeWorldToHoleLocalYds(farmlinks, 19, { x: 0, z: 0 }), null)
  assert.equal(reg.parseNativeRegistration({ ...farmlinks, layoutFingerprint: 'nope' }), null)

  // 5. Snapshot overlay on a synthetic registration (true-north, heading 0).
  const synthReg = reg.parseNativeRegistration({
    schemaVersion: 'looper-native-registration-v1', courseId: 'synthetic', gsproCourseKey: 'synthetic_gsp',
    layoutFingerprint: 'a9aebbc26134b714d8da4137b213a58d63f9c1ed6e4d7c334cbd6d62606ff53d', grade: 'A',
    reference: { latLon: [33.12, -86.42], worldXZ: [0, 0] }, worldYToElevationOffsetM: 100,
    holes: { 1: { anchorLatLon: [33.12, -86.42], headingDegreesTrue: 0 } },
  })
  const context = { courseId: 'synthetic', courseKey: 'synthetic_gsp', layout, registration: synthReg }
  const base = {
    courseKey: 'synthetic_gsp', roundId: 7, holeNumber: 1, ballLocalYds: null, ballSource: 'unavailable',
    surface: 'tee', surfaceSource: 'cached-tee', distanceToPinYds: null, nextShotNumber: 1,
    latestShot: null, latestShotKey: null, warnings: [], observedAt: '2026-10-30T00:00:00Z',
    preShotStart: null, pinLocalYds: null, pinSource: 'unavailable', pinDistanceValidationErrorYds: null,
  }
  const Y = gkd.NATIVE_METERS_TO_YARDS
  const preShotStart = {
    world: pos(0, 20, 9), holeNumber: 1, shotNumber: 1, shotId: null, roundId: 7, courseKey: 'synthetic_gsp',
    distanceToPinYds: Math.hypot(30, 115) * Y, surface: 'tee', surfaceRaw: 18, recordKey: 'k',
  }
  const tee = snap.applyNativeCourseSnapshot({
    base, context, holeNumber: 1, teeContext: true, preShotStart, normalizedTeeSet: 'black', rememberedPinSlot: null,
  })
  assert.equal(tee.pinSlot, 1)
  assert.equal(tee.snapshot.ballSource, 'native-gkd')
  assert.equal(tee.snapshot.teePlacement, 'mapped')
  assert.equal(tee.snapshot.pinSource, 'native-gkd')
  assert.ok(Math.abs(tee.snapshot.distanceToPinYds - Math.hypot(30, 115) * Y) < 1e-6, 'straight tee->pin in GSPro metres')
  assert.ok(Math.abs(tee.snapshot.ballLocalYds[0]) < 0.01 && Math.abs(tee.snapshot.ballLocalYds[1] - 20 * Y) < 0.1,
    `tee placed from pre-shot StartingPOS (not the Black tee), got ${tee.snapshot.ballLocalYds}`)

  const noPreShot = snap.applyNativeCourseSnapshot({
    base, context, holeNumber: 1, teeContext: true, preShotStart: null, normalizedTeeSet: 'black', rememberedPinSlot: 2,
  })
  assert.ok(Math.abs(noPreShot.snapshot.ballLocalYds[1]) < 0.01, 'falls back to the round tee set (Black at origin)')
  assert.equal(noPreShot.pinSlot, 2, 'keeps the slot learned earlier in the round')

  const later = snap.applyNativeCourseSnapshot({
    base: { ...base, nextShotNumber: 2, latestShot: { holeNumber: 1, endWorld: pos(30, 100), distanceToPinYds: 35 * Y } },
    context, holeNumber: 1, teeContext: false, preShotStart: null, normalizedTeeSet: null, rememberedPinSlot: null,
  })
  assert.equal(later.pinSlot, 1, 'slot from the latest shot end and GSPro distance')
  assert.equal(later.snapshot.ballSource, 'unavailable', 'after shot 1 the core owns ball placement')

  // Legacy OSM tee pick ("Tee 2") maps to the GKD tee at that map spot.
  const whiteLocal = reg.nativeWorldToHoleLocalYds(synthReg, 1, { x: 0, z: 20 })
  const legacy = snap.applyNativeCourseSnapshot({
    base, context, holeNumber: 1, teeContext: true, preShotStart: null, normalizedTeeSet: 'tee 2',
    rememberedPinSlot: null, legacyTeeLocal: [whiteLocal[0] + 2, whiteLocal[1] - 3],
  })
  assert.ok(Math.abs(legacy.snapshot.ballLocalYds[1] - whiteLocal[1]) < 0.01, 'legacy pick -> nearest GKD tee')
  const tooFar = snap.applyNativeCourseSnapshot({
    base, context, holeNumber: 1, teeContext: true, preShotStart: null, normalizedTeeSet: 'tee 2',
    rememberedPinSlot: null, legacyTeeLocal: [whiteLocal[0] + 40, whiteLocal[1]],
  })
  assert.equal(tooFar.snapshot.ballSource, 'unavailable', 'no GKD tee within 10 yd -> unchanged')

  // GSPro tee sets for the round picker (synthetic course has one hole, so
  // the nine-hole floor filters everything; a 9-hole copy lists them).
  assert.deepEqual(gkd.nativeTeeSetOptions(layout), [])
  const nine = gkd.parseGkdLayout(JSON.stringify({ ...synthetic, Holes: Array.from({ length: 9 }, (_, i) => ({ ...synthetic.Holes[0], HoleNumber: i + 1 })) }))
  assert.deepEqual(gkd.nativeTeeSetOptions(nine).map((o) => o.name), ['Black', 'White', 'Red'])

  const otherHole = snap.applyNativeCourseSnapshot({
    base, context, holeNumber: 5, teeContext: true, preShotStart, normalizedTeeSet: 'black', rememberedPinSlot: null,
  })
  assert.equal(otherHole.snapshot, base, 'unknown hole passes the snapshot through unchanged')

  console.log('native course positions: all checks passed')
} finally {
  await server?.close()
}
