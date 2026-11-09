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
  const folder = await load('/src/courseGeometry/nativeCourseFolder.ts')
  const runtime = await load('/src/courseGeometry/nativeCourseRuntime.ts')

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
  // Scene fingerprint (pins + green centres, no tees) matches Python too.
  assert.equal(layout.sceneFingerprintText, '1|300,1350;360,1500|300,1400')
  assert.equal(await gkd.sha256Hex(layout.sceneFingerprintText),
    'e356348e6071672d52bea988972af8030dee5e3c9197d9e38a39d7463e486508')
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
  // Inverse (Auto Aim targets): hole yards -> GSPro world round-trips to < 1 mm.
  const back = reg.nativeHoleLocalYdsToWorld(farmlinks, 1, r255)
  assert.ok(Math.abs(back.x - 1180.69287) < 1e-3 && Math.abs(back.z - 800.2199) < 1e-3, `inverse ${JSON.stringify(back)}`)
  assert.equal(reg.nativeHoleLocalYdsToWorld(farmlinks, 19, [0, 0]), null)
  assert.equal(reg.parseNativeRegistration({ ...farmlinks, layoutFingerprint: 'nope' }), null)

  // 5. Snapshot overlay on a synthetic registration (true-north, heading 0).
  const synthReg = reg.parseNativeRegistration({
    schemaVersion: 'looper-native-registration-v1', courseId: 'synthetic', gsproCourseKey: 'synthetic_gsp',
    layoutFingerprint: 'a9aebbc26134b714d8da4137b213a58d63f9c1ed6e4d7c334cbd6d62606ff53d', grade: 'A',
    reference: { latLon: [33.12, -86.42], worldXZ: [0, 0] }, worldYToElevationOffsetM: 100,
    holes: { 1: { anchorLatLon: [33.12, -86.42], headingDegreesTrue: 0 } },
  })
  const mainOption = { name: 'Synthetic Links', kind: 'main', layout }
  const context = {
    courseId: 'synthetic', courseKey: 'synthetic_gsp', layout, layoutName: 'Synthetic Links',
    layoutConfirmed: true, layouts: [mainOption], registration: synthReg,
  }
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

  // The pin day picked in GSPro's round setup names the pin before any shot
  // (Brian, 11/9), and beats a slot remembered from a distance match.
  assert.equal(gkd.normalizePinDay(' friday '), 'Friday')
  assert.equal(gkd.normalizePinDay('Mon'), null)
  assert.equal(gkd.nativePinForDay(hole, 'Friday').slot, 2)
  assert.equal(gkd.nativePinForDay(hole, 'Sunday'), null)
  const byDay = snap.applyNativeCourseSnapshot({
    base, context, holeNumber: 1, teeContext: true, preShotStart: null, normalizedTeeSet: 'black',
    rememberedPinSlot: 1, pinDay: 'Friday',
  })
  assert.equal(byDay.pinSlot, 2, "the player's pin day names the pin")
  assert.equal(byDay.snapshot.pinSource, 'native-gkd')
  assert.equal(byDay.snapshot.pinDistanceValidationErrorYds, null, 'exact, nothing measured')
  assert.ok(Math.abs(byDay.snapshot.distanceToPinYds - Math.hypot(36, 150) * Y) < 1e-6)
  // GSPro's own shot evidence still wins, and the disagreement is said.
  const dayVsShot = snap.applyNativeCourseSnapshot({
    base, context, holeNumber: 1, teeContext: true, preShotStart, normalizedTeeSet: 'black',
    rememberedPinSlot: null, pinDay: 'Friday',
  })
  assert.equal(dayVsShot.pinSlot, 1, 'GSPro says Thursday')
  assert.ok(dayVsShot.snapshot.warnings.some((w) => w.includes('Thursday position, not Friday')), dayVsShot.snapshot.warnings)

  const later = snap.applyNativeCourseSnapshot({
    base: { ...base, nextShotNumber: 2, latestShot: { holeNumber: 1, endWorld: pos(30, 100), distanceToPinYds: 35 * Y } },
    context, holeNumber: 1, teeContext: false, preShotStart: null, normalizedTeeSet: null, rememberedPinSlot: null,
  })
  assert.equal(later.pinSlot, 1, 'slot from the latest shot end and GSPro distance')
  assert.equal(later.snapshot.ballSource, 'unavailable', 'after shot 1 the core owns ball placement')

  // GSPro's round layout (output_log) is no longer a pin source (11/9: fewer
  // layers). Its tee still places the ball when its pin is one of this hole's
  // GKD pins (that match vouches for the layout belonging to this hole).
  const fromLayout = snap.applyNativeCourseSnapshot({
    base, context: { ...context, layoutConfirmed: false }, holeNumber: 1, teeContext: true, preShotStart: null,
    normalizedTeeSet: 'white', rememberedPinSlot: null,
    roundLayout: { tee: pos(0, 20, 9), pin: pos(36.2, 150.1, 8) },
  })
  assert.equal(fromLayout.pinSlot, null, 'the layout pin names no pin')
  assert.equal(fromLayout.snapshot.pinSource, 'unavailable')
  assert.equal(fromLayout.snapshot.teePlacement, 'mapped', 'the layout tee still places the ball')
  const strayLayout = snap.applyNativeCourseSnapshot({
    base, context: { ...context, layoutConfirmed: false }, holeNumber: 1, teeContext: true, preShotStart: null,
    normalizedTeeSet: 'white', rememberedPinSlot: null,
    roundLayout: { tee: pos(0, 20, 9), pin: pos(60, 170, 8) },
  })
  assert.equal(strayLayout.snapshot.ballSource, 'unavailable', 'a layout whose pin is not a GKD pin is not trusted for its tee either')
  // With a pin day, a slot remembered from an earlier guess is ignored.
  const dayOverRemembered = snap.applyNativeCourseSnapshot({
    base, context, holeNumber: 1, teeContext: true, preShotStart: null, normalizedTeeSet: 'black',
    rememberedPinSlot: 1, pinDay: 'Friday',
  })
  assert.equal(dayOverRemembered.pinSlot, 2)
  assert.equal(dayOverRemembered.snapshot.warnings.some((w) => w.includes('check the pin day')), false,
    'a remembered guess is not GSPro evidence, so no disagreement note')

  // Confirmed positions (11/9): GSPro's own record for both tee and pin is
  // shared; an inferred tee or pin is not.
  assert.ok(tee.confirmed, 'StartingPOS on a GKD tee + DistanceToPin naming a pin -> confirmed')
  assert.equal(tee.confirmed.pinSlot, 1)
  assert.equal(tee.confirmed.pinLabel, 'Thursday')
  assert.deepEqual(tee.confirmed.teeWorld, pos(0, 20, 9))
  assert.equal(byDay.confirmed, null, 'a day-picked pin with no shot evidence is not confirmed')
  assert.equal(noPreShot.confirmed, null)
  const cp = await load('/src/lib/confirmedPositions.ts')
  const rows = [
    { courseId: 'synthetic', courseKey: 'synthetic_gsp', holeNumber: 1, teeSet: 'white', pinDay: 'Thursday', layoutFingerprint: 'fp',
      teeName: 'White', teeWorld: pos(0.3, 20.2, 9), pinSlot: 1, pinLabel: 'Thursday', pinWorld: pos(30, 135, 8) },
    { courseId: 'synthetic', courseKey: 'synthetic_gsp', holeNumber: 1, teeSet: 'white', pinDay: 'Friday', layoutFingerprint: 'fp',
      teeName: 'White', teeWorld: pos(0.3, 20.2, 9), pinSlot: 2, pinLabel: 'Friday', pinWorld: pos(36, 150, 8) },
  ]
  assert.equal(cp.findConfirmedPosition(rows, { holeNumber: 1, teeSet: 'White', pinDay: 'friday', layoutFingerprint: 'fp' }).pinSlot, 2)
  assert.equal(cp.findConfirmedPosition(rows, { holeNumber: 1, teeSet: 'white', pinDay: null, layoutFingerprint: 'fp' }), null,
    'two days confirmed and no day picked: no guess')
  assert.equal(cp.findConfirmedPosition(rows.slice(0, 1), { holeNumber: 1, teeSet: 'white', pinDay: null, layoutFingerprint: 'fp' }).pinSlot, 1,
    'one day confirmed: it is the one')
  assert.equal(cp.findConfirmedPosition(rows, { holeNumber: 1, teeSet: 'white', pinDay: 'Thursday', layoutFingerprint: 'other' }), null,
    'another course-file version: not used')
  assert.equal(cp.findConfirmedPosition(rows, { holeNumber: 2, teeSet: 'white', pinDay: 'Thursday', layoutFingerprint: 'fp' }), null)
  // Cross-check with the file readable: a day-picked pin that disagrees with
  // what a round confirmed gets a note; GSPro's own record never does.
  assert.ok(cp.confirmedPinNote({ position: rows[0], pinSlot: 2, pinFromGsproRecord: false, pinDay: 'Thursday' })
    .includes('Check the pin day picked in GSPro'))
  assert.equal(cp.confirmedPinNote({ position: rows[0], pinSlot: 1, pinFromGsproRecord: false, pinDay: 'Thursday' }), null)
  assert.equal(cp.confirmedPinNote({ position: rows[0], pinSlot: 2, pinFromGsproRecord: true, pinDay: 'Thursday' }), null)
  assert.ok(cp.confirmedPinNote({ position: rows[0], pinSlot: 2, pinFromGsproRecord: false, pinDay: null })
    .includes('Pick the pin day in Start Round'))
  assert.equal(cp.confirmedPinNote({ position: null, pinSlot: 2, pinFromGsproRecord: false, pinDay: 'Thursday' }), null)
  // Placed without the course file, through the published registration.
  const placed = snap.applyConfirmedPosition({ base, registration: synthReg, holeNumber: 1, teeContext: true, position: rows[1] })
  assert.equal(placed.ballSource, 'native-gkd')
  assert.equal(placed.pinSource, 'native-gkd')
  assert.ok(Math.abs(placed.distanceToPinYds - Math.hypot(35.7, 129.8) * Y) < 1e-6, placed.distanceToPinYds)
  assert.ok(placed.warnings.some((w) => w.includes('a round that confirmed them')))
  const pinOnly = snap.applyConfirmedPosition({ base: { ...base, nextShotNumber: 3 }, registration: synthReg, holeNumber: 1, teeContext: false, position: rows[1] })
  assert.equal(pinOnly.ballSource, 'unavailable', 'after shot 1 only the pin is placed')
  assert.equal(pinOnly.pinSource, 'native-gkd')

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

  // Round Setup before GSPro is on the course: find it in the installed library by name.
  const library = [
    { courseKey: 'valhalla_gsp', courseName: 'Valhalla' },
    { courseKey: 'farmlinks_al_2_7_gsp', courseName: 'FarmLinks' },
    { courseKey: 'kiawah_b_01_gsp', courseName: 'Kiawah Island Ocean Course' },
    { courseKey: 'valley_club_gsp', courseName: 'The Valley Club' },
  ]
  assert.equal(runtime.pickInstalledCourseKey(['Valhalla Golf Club'], library), 'valhalla_gsp')
  assert.equal(runtime.pickInstalledCourseKey(['Kiawah Island Golf Resort - The Ocean Course', 'kiawah_b_01_gsp'], library),
    'kiawah_b_01_gsp')
  assert.equal(runtime.pickInstalledCourseKey(['Muirfield Village Golf Club'], library), null, 'not installed')
  assert.equal(runtime.pickInstalledCourseKey(['Valhalla'], [...library, { courseKey: 'valhalla2_gsp', courseName: 'Valhalla' }]),
    null, 'two equally good matches: do not guess')

  // GSPro tee sets for the round picker (synthetic course has one hole, so
  // the nine-hole floor filters everything; a 9-hole copy lists them).
  assert.deepEqual(gkd.nativeTeeSetOptions(layout), [])
  const nine = gkd.parseGkdLayout(JSON.stringify({ ...synthetic, Holes: Array.from({ length: 9 }, (_, i) => ({ ...synthetic.Holes[0], HoleNumber: i + 1 })) }))
  assert.deepEqual(gkd.nativeTeeSetOptions(nine).map((o) => o.name), ['Black', 'White', 'Red'])

  const otherHole = snap.applyNativeCourseSnapshot({
    base, context, holeNumber: 5, teeContext: true, preShotStart, normalizedTeeSet: 'black', rememberedPinSlot: null,
  })
  assert.equal(otherHole.snapshot, base, 'unknown hole passes the snapshot through unchanged')

  // 6. Course folder discovery. Layout of a real GSPro install (FarmLinks):
  //    C:\GSProV1\Courses\<folder>\<scene>.GKD + "<Alt name>.GKDalt" + GKD_BAK
  //    revisions. The alternate layout shares pins/greens, moves every tee.
  const alt = {
    ...synthetic, gkversion: 4.1, SceneFolderName: 'synthetic_gsp', CourseName: 'Synthetic Kids',
    Holes: [{ ...synthetic.Holes[0], Tees: [
      { TeeType: 'White', Enabled: true, Distance: 90.0, Position: pos(10, 60) },
      { TeeType: 'Red', Enabled: true, Distance: 80.0, Position: pos(15, 70) },
      { TeeType: 'AimPoint1', Enabled: true, Distance: 0.0, Position: pos(0, 100) },
      { TeeType: 'GreenCenterPoint', Enabled: false, Distance: 0.0, Position: pos(30, 140) },
    ] }],
  }
  const otherScene = { ...alt, SceneFolderName: 'other_course_gsp', CourseName: 'Other Kids' }
  let listings = 0
  const fakeDir = (name, tree) => ({
    kind: 'directory', name,
    async getFileHandle(n) {
      const v = tree[n]
      if (typeof v !== 'string') throw new Error('NotFoundError')
      return { getFile: async () => ({ name: n, size: v.length, lastModified: 1700000000000, text: async () => v }) }
    },
    async getDirectoryHandle(n) {
      const v = tree[n]
      if (!v || typeof v === 'string') throw new Error('NotFoundError')
      return fakeDir(n, v)
    },
    async *values() {
      listings += 1
      for (const [n, v] of Object.entries(tree)) yield typeof v === 'string' ? { kind: 'file', name: n } : fakeDir(n, v)
    },
  })
  const courseFolder = {
    'synthetic_gsp.GKD': JSON.stringify(synthetic),
    'Synthetic Kids.GKDalt': JSON.stringify(alt),
    'Other Kids.GKDalt': JSON.stringify(otherScene),
    'synthetic_gsp-1665162593.GKD_BAK': '{"Holes": []}',
    'synthetic_gsp.unity3d': 'binary',
    'broken.GKDalt': 'not json',
  }
  const install = fakeDir('GSProV1', {
    GSPro_Data: { a: { b: {} } },
    Courses: {
      'Aaa Course': { 'aaa_gsp.GKD': JSON.stringify(synthetic) },
      'Synthetic Links v2': courseFolder,
    },
  })
  const found = await folder.findNativeSceneFolder(install, 'SYNTHETIC_GSP')
  assert.deepEqual(found?.path, ['Courses', 'Synthetic Links v2'], 'install root -> Courses -> course folder (any case)')
  assert.equal(await folder.findNativeSceneFolder(install, 'missing_gsp'), null)
  assert.deepEqual((await folder.findNativeSceneFolder(fakeDir('x', courseFolder), 'synthetic_gsp'))?.path, [],
    'course folder itself')
  listings = 0
  assert.equal(await folder.findNativeSceneFolder(install, 'missing_gsp', 2), null)
  assert.ok(listings <= 2, 'folder walk is bounded')
  assert.ok(await folder.walkNativePath(install, ['Courses', 'Synthetic Links v2']))
  assert.equal(await folder.walkNativePath(install, ['Courses', 'Gone']), null)

  const files = await folder.listNativeLayoutFiles(found.dir)
  assert.deepEqual(files.map((f) => f.fileName), ['synthetic_gsp.GKD', 'broken.GKDalt', 'Other Kids.GKDalt', 'Synthetic Kids.GKDalt'],
    'GKD first, then GKDalt; GKD_BAK revisions ignored')
  assert.ok(folder.sameNativeLayoutFiles(files, await folder.listNativeLayoutFiles(found.dir)))
  assert.equal(folder.sameNativeLayoutFiles(files, [{ ...files[0], size: 1 }, ...files.slice(1)]), false)
  const sceneLayouts = await folder.readNativeSceneLayouts(found.dir, 'synthetic_gsp', files)
  assert.deepEqual(sceneLayouts.map(folder.nativeLayoutName), ['Synthetic Links', 'Synthetic Kids'],
    'malformed files and other scenes\' layouts are left out')

  // 7. Verification against the registration: scene fingerprint admits the
  //    alternate layout; old registrations (no scene fingerprint) only the main.
  const sceneReg = { ...synthReg, sceneFingerprint: await gkd.sha256Hex(layout.sceneFingerprintText) }
  const verified = await runtime.verifyNativeLayouts(sceneLayouts, sceneReg)
  assert.deepEqual(verified.map((l) => `${l.kind}:${l.name}`), ['main:Synthetic Links', 'alt:Synthetic Kids'])
  assert.deepEqual((await runtime.verifyNativeLayouts(sceneLayouts, { ...synthReg, sceneFingerprint: null })).map((l) => l.name),
    ['Synthetic Links'])
  const movedPins = gkd.parseGkdLayout(JSON.stringify({ ...synthetic, Holes: [{ ...synthetic.Holes[0], Pins: [{ Day: 'x', Position: pos(31, 135) }] }] }))
  assert.equal((await runtime.verifyNativeLayouts([{ file: files[0], layout: movedPins }], sceneReg)).length, 0,
    'a different pin layout is rejected')

  // 8. Which layout is in play.
  const twoLayouts = { ...context, registration: sceneReg, layouts: verified, layoutConfirmed: false }
  const pick = (inputs) => runtime.selectNativeLayout(twoLayouts, { holeNumber: 1, preShotWorld: null, normalizedTeeSet: null, rememberedLayoutName: null, ...inputs })
  assert.equal(pick({}).context.layoutConfirmed, false, 'two layouts and no evidence: unconfirmed')
  assert.equal(pick({ normalizedTeeSet: 'tee 3' }).context.layoutConfirmed, false, 'legacy OSM pick says nothing about the layout')
  const plainWhite = pick({ normalizedTeeSet: 'white' })
  assert.equal(plainWhite.context.layoutName, 'Synthetic Links', 'plain GSPro tee name = main layout')
  assert.equal(plainWhite.context.layoutConfirmed, true)
  const mainTee = snap.applyNativeCourseSnapshot({
    base, context: plainWhite.context, holeNumber: 1, teeContext: true, preShotStart: null,
    normalizedTeeSet: plainWhite.normalizedTeeSet, rememberedPinSlot: null,
  })
  assert.equal(mainTee.snapshot.teePlacement, 'mapped', 'White placed without a pre-shot record')
  const legacyNote = 'Provisional Hole 1 tee (existing-map-tee-anchor), ±50 yd. Existing approximate mapped tee anchor only.'
  const cleaned = snap.applyNativeCourseSnapshot({
    base: { ...base, warnings: [legacyNote, 'keep me'] }, context: plainWhite.context, holeNumber: 1, teeContext: true,
    preShotStart: null, normalizedTeeSet: 'white', rememberedPinSlot: null,
  })
  assert.ok(!cleaned.snapshot.warnings.includes(legacyNote) && cleaned.snapshot.warnings.includes('keep me'),
    'legacy provisional-tee note dropped once the native tee is placed')
  const byTeeSet = pick({ normalizedTeeSet: 'white (synthetic kids)' })
  assert.equal(byTeeSet.context.layoutName, 'Synthetic Kids')
  assert.equal(byTeeSet.normalizedTeeSet, 'white')
  assert.equal(byTeeSet.learnedLayoutName, 'Synthetic Kids')
  const byPosition = pick({ preShotWorld: pos(10, 60) })
  assert.equal(byPosition.context.layoutName, 'Synthetic Kids', 'StartingPOS on a Kids-only tee')
  assert.equal(pick({ preShotWorld: pos(0, 0) }).context.layoutName, 'Synthetic Links', 'Black exists only on the main layout')
  assert.equal(pick({ rememberedLayoutName: 'Synthetic Kids' }).context.layoutName, 'Synthetic Kids')
  assert.equal(runtime.nativeTeeSetValue('White', verified[1]), 'White (Synthetic Kids)')
  assert.equal(runtime.nativeTeeSetValue('White', verified[0]), 'White')

  // Unconfirmed layout: no by-name tee (main "White" is not Kids "White").
  const unconfirmed = snap.applyNativeCourseSnapshot({
    base, context: twoLayouts, holeNumber: 1, teeContext: true, preShotStart: null, normalizedTeeSet: 'white', rememberedPinSlot: null,
  })
  assert.equal(unconfirmed.snapshot.ballSource, 'unavailable')
  const kidsTee = snap.applyNativeCourseSnapshot({
    base, context: byTeeSet.context, holeNumber: 1, teeContext: true, preShotStart: null, normalizedTeeSet: byTeeSet.normalizedTeeSet, rememberedPinSlot: null,
  })
  const kidsWhite = reg.nativeWorldToHoleLocalYds(synthReg, 1, { x: 10, z: 60 })
  assert.ok(Math.hypot(kidsTee.snapshot.ballLocalYds[0] - kidsWhite[0], kidsTee.snapshot.ballLocalYds[1] - kidsWhite[1]) < 0.01,
    'Kids White tee placed from the Kids layout')

  // 9. Course files via the Windows Companion (no folder grant).
  const realFetch = globalThis.fetch
  const hadWindow = 'window' in globalThis
  const realWindow = globalThis.window
  globalThis.window = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  try {
    const companionReply = (body) => async (request) => {
      assert.equal(new URL(request.url).searchParams.get('courseKey'), 'synthetic_gsp')
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    globalThis.fetch = companionReply({
      service: 'looper-companion', version: 'x', schemaVersion: 'looper-companion-course-layouts-v1',
      courseKey: 'synthetic_gsp', status: 'ready', source: 'beside-gspro',
      layouts: [
        { fileName: 'synthetic_gsp.GKD', kind: 'main', size: 1, lastModified: 1, text: '\ufeff' + JSON.stringify(synthetic) },
        { fileName: 'Synthetic Kids.GKDalt', kind: 'alt', size: 1, lastModified: 1, text: JSON.stringify(alt) },
        { fileName: 'broken.GKDalt', kind: 'alt', size: 1, lastModified: 1, text: 'not json' },
      ],
    })
    const viaCompanion = await runtime.companionSceneLayouts('synthetic_gsp')
    assert.deepEqual(viaCompanion.map(folder.nativeLayoutName), ['Synthetic Links', 'Synthetic Kids'])
    assert.deepEqual((await runtime.verifyNativeLayouts(viaCompanion, sceneReg)).map((l) => l.kind), ['main', 'alt'])
    globalThis.fetch = companionReply({
      service: 'looper-companion', version: 'x', schemaVersion: 'looper-companion-course-layouts-v1',
      courseKey: 'synthetic_gsp', status: 'not-found', layouts: [],
    })
    assert.deepEqual(await runtime.companionSceneLayouts('synthetic_gsp'), [], 'companion up, course not installed')
    globalThis.fetch = companionReply({ service: 'looper-companion', version: 'old', status: 'ready' })
    assert.equal(await runtime.companionSceneLayouts('synthetic_gsp'), null, 'older companion -> folder grant')
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
    assert.equal(await runtime.companionSceneLayouts('synthetic_gsp'), null, 'no companion -> folder grant')
  } finally {
    globalThis.fetch = realFetch
    if (hadWindow) globalThis.window = realWindow
    else delete globalThis.window
  }

  // Published FarmLinks registration carries the scene fingerprint.
  assert.equal(farmlinks.sceneFingerprint, '0aecb74508c245b5f7071c8871f4dda9207fcb9f738004ca667a0681d5bd76ae')

  console.log('native course positions: all checks passed')
} finally {
  await server?.close()
}
