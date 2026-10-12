/**
 * Offline read-only web bridge tests. Mirrors saved Greywolf H8/H13 matrix
 * fixtures from tests/test_gspro_companion_minimap.py; no GSPro or browser.
 * TypeScript is transpiled to an ephemeral module; no second math engine.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const path = resolve('src/adapters/looperCompanionAimPreview.ts')
const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { prepareReadOnlyNativeAimPreview } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
)
const at = '2026-10-12T04:02:52.000Z'
const now = Date.parse(at)
const tran = (m, p) => ({ x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
  y: m[1][0] * p.x + m[1][1] * p.y + m[1][2] })
const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

function fixture([matrix, actualBall, tee, pin, ypp, expectedPixel]) {
  const ballCan = tran(matrix, actualBall)
  const axis = { x: (pin.x - tee.x) / len(tee, pin), y: (pin.y - tee.y) / len(tee, pin) }
  const delta = { x: ballCan.x - tee.x, y: ballCan.y - tee.y }
  const forward = (delta.x * axis.x + delta.y * axis.y) * ypp
  const right = (-delta.x * axis.y + delta.y * axis.x) * ypp
  const pinYds = len(tee, pin) * ypp
  const intent = {
    kind: 'looper-companion-native-aim-preview-v1',
    coordinateFrame: 'looper-hole-local-yards-unverified',
    nativeInputAuthorized: false,
    gsproCourseKey: 'GreyWolf_gsp', courseId: 'greywolf', roundId: 251,
    holeNumber: 8, nextShotNumber: 2, previousShotKey: '251:8:shot1',
    lastCompletedShotId: 'shot1', shotReference: '251:GreyWolf_gsp:8:2:shot1',
    observedAt: at, club: 'GW', teeLocalYds: [0, 0],
    pinLocalYds: [0, pinYds], ballLocalYds: [right, forward],
    targetLocalYds: [right + 10, forward + 75],
  }
  const native = {
    service: 'looper-companion', schemaVersion: 'native-observations-v1',
    version: 'autoaim-stage-c-preflight.1', stateAuthority: 'diagnostic-only',
    status: 'ready', observedAt: at, capabilities: { autoAim: false },
    gspro: { status: 'connected', window: { minimized: false, dpiAwareness: 'per-monitor' } },
    structured: {
      fileAgeMs: 2000,
      shot: { kind: 'last_completed', status: 'completed_record_only',
        shotNumber: 1, shotId: 'shot1', roundId: 251, holeNumber: 8, courseKey: 'GreyWolf_gsp' },
    },
    minimap: {
      status: 'markers_found', ballPixel: actualBall, pinPixel: { x: 280, y: 175 },
      minimapRoiWindowPixels: [3256, 1123, 564, 950],
      scale: { status: 'provisional_registered_tee', yardsPerPixel: ypp * Math.hypot(matrix[0][0], matrix[1][0]) },
      registration: {
        status: 'registered_candidate_unverified',
        canonicalTeePixel: tee, canonicalPinPixel: pin,
        currentToCanonicalMatrix: matrix,
        teeScaleYardsPerPixel: ypp,
        currentScaleYardsPerPixel: ypp * Math.hypot(matrix[0][0], matrix[1][0]),
        pinErrorPixels: 0.73,
      },
    },
  }
  const preview = prepareReadOnlyNativeAimPreview(intent, native, now)
  assert.equal(preview.status, 'candidate-unverified', preview.reason)
  assert.equal(preview.nativeInputAuthorized, false)
  assert.equal(preview.shotMatch, 'matching-last-completed')
  assert.ok(preview.projectedBallErrorYds < 0.01, String(preview.projectedBallErrorYds))
  assert.ok(preview.teePinAnchorErrorYds < 0.01)
  assert.ok(Math.abs(preview.targetPixel.x - expectedPixel.x) < 0.04)
  assert.ok(Math.abs(preview.targetPixel.y - expectedPixel.y) < 0.04)
  return { intent, native }
}

const { intent, native } = fixture([
  [[0.353548471, -0.157713020, 210.251806], [0.157713020, 0.353548471, 68.2961123]],
  { x: 277.6226784, y: 852.1339198 },
  { x: 275.9562842, y: 851.1857923 },
  { x: 281.0500183, y: 174.3500061 }, 0.5756693119,
  { x: 183.9537, y: 525.7971 },
])
fixture([
  [[0.291182836, -0.187250734, 230.715324], [0.187250734, 0.291182836, 71.2393193]],
  { x: 279.1972387, y: 852.6272189 },
  { x: 278.2912088, y: 852.5274725 },
  { x: 279.9500122, y: 173.25 }, 0.4788347688,
  { x: 86.2310, y: 438.9844 },
])

// Identity, freshness and independent pin gates: no target pixel should survive.
for (const change of [
  { intent: { holeNumber: 9 } },
  { intent: { roundId: 252 } },
  { native: { structured: { ...native.structured,
    shot: { ...native.structured.shot, shotId: 'wrong-shot' } } } },
  { native: { observedAt: '2026-10-12T04:00:00Z' } },
  { native: { minimap: { ...native.minimap,
    registration: { ...native.minimap.registration, pinErrorPixels: 5 } } } },
  { native: { minimap: { ...native.minimap,
    registration: { ...native.minimap.registration, canonicalPinPixel: { x: 280, y: 240 } } } } },
  { native: { minimap: { ...native.minimap, ballPixel: { x: 100, y: 100 } } } },
]) {
  const ci = { ...intent, ...(change.intent ?? {}) }
  const cn = { ...native, ...(change.native ?? {}) }
  const result = prepareReadOnlyNativeAimPreview(ci, cn, now)
  assert.equal(result.status, 'blocked', result.reason)
  assert.equal(result.targetPixel, null)
  assert.equal(result.nativeInputAuthorized, false)
}
const tee = {
  ...native,
  structured: { ...native.structured, shot: {
    ...native.structured.shot, kind: 'pre_shot', status: 'ready', shotNumber: 2,
  } },
}
assert.equal(prepareReadOnlyNativeAimPreview(intent, tee, now).shotMatch, 'matching-pre-shot')
const previousHole = { ...tee, structured: { ...tee.structured,
  shot: { ...tee.structured.shot, kind: 'last_completed', holeNumber: 7 } } }
assert.equal(prepareReadOnlyNativeAimPreview(intent, previousHole, now).status, 'blocked')
assert.equal(prepareReadOnlyNativeAimPreview(null, native, now).status, 'blocked')
console.log('PASS: H8/H13 read-only projection, active/completed shot reconciliation, stale and bad-anchor gating')
