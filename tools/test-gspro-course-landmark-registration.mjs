import assert from 'node:assert/strict'
import { createServer } from 'vite'

const vite = await createServer({
  appType: 'custom', logLevel: 'silent', server: { middlewareMode: true },
})

try {
  const {
    evaluateGsproToCourseLandmarkRegistration: evaluate,
    applyCourseLandmarkTransform: project,
  } = await vite.ssrLoadModule('/src/courseGeometry/gsproCourseLandmarkRegistration.ts')
  const at = '2026-10-12T15:00:00.000Z'
  const now = Date.parse(at)
  // Known, orientation-preserving 0.5 yard/pixel transform. The pixel y-axis
  // points DOWN; "forward" course yards need not follow the pixel y-axis.
  const truth = [[0.4, -0.3, 12], [0.3, 0.4, -75]]
  const nativePixels = [[65, 780], [95, 180], [260, 450], [150, 520]]
  const local = nativePixels.map(p => project(truth, p))
  const kinds = ['green-edge', 'bunker-edge', 'fairway-edge', 'water-edge']
  const landmarks = nativePixels.map((p, i) => ({
    featureId: 'osm-feature-' + i,
    nativeFeatureId: 'gspro-pixel-feature-' + i,
    kind: kinds[i],
    gsproCanonicalPixel: p,
    courseLocalYds: local[i],
    role: i < 2 ? 'fit' : 'holdout',
    evidence: 'independently-reviewed',
    spatialAccuracy: 'exact',
  }))
  const base = {
    expected: { courseId: 'valhalla-golf-club', gsproCourseKey: 'Valhalla_gsp', roundId: 77, holeNumber: 12 },
    native: {
      courseId: 'valhalla-golf-club', gsproCourseKey: 'Valhalla_gsp', roundId: 77, holeNumber: 12,
      observedAt: at, frame: 'canonical-tee-minimap-roi',
      minimapStatus: 'markers_found', registrationStatus: 'registered_candidate_unverified',
      teeScaleYardsPerPixel: 0.5, whitePinErrorPixels: 0.8,
    },
    landmarks,
  }
  const pass = evaluate(base, now)
  assert.equal(pass.status, 'research-candidate', pass.reason)
  assert.equal(pass.canPublishCourse, false)
  assert.equal(pass.authorizesNativeAim, false)
  assert.equal(pass.verifiedForPlay, false)
  assert.equal(pass.fitCount, 2)
  assert.equal(pass.holdoutCount, 2)
  assert.ok(pass.holdoutMaxErrorYds < 0.01)
  assert.ok(pass.fitRmsYds < 0.01)
  assert.ok(pass.holdoutOffAxisYds > 8)
  assert.equal(pass.scaleYardsPerPixel, 0.5)
  for (let i = 0; i < 4; i++) {
    const projected = project(pass.canonicalPixelToCourseLocal.matrix2x3, nativePixels[i])
    assert.ok(Math.hypot(projected[0] - local[i][0], projected[1] - local[i][1]) < 1e-6)
  }

  // Critically: no tee polygon, scorecard yardage, route geometry, hazard
  // reclassification or GSPro world rotation enters the *registration*.
  const dogleg = evaluate({ ...base, landmarks: landmarks.map(x => ({...x})) }, now)
  assert.equal(dogleg.status, 'research-candidate')

  const block = (state, phrase) => {
    const result = evaluate(state, now)
    assert.equal(result.status, 'blocked', phrase + ': ' + result.reason)
    assert.equal(result.canonicalPixelToCourseLocal, null)
    assert.equal(result.verifiedForPlay, false)
    assert.equal(result.authorizesNativeAim, false)
    assert.equal(result.canPublishCourse, false)
    assert.match(result.reason.toLowerCase(), new RegExp(phrase, 'i'))
  }
  block({ ...base, expected: { ...base.expected, holeNumber: 13 } }, 'course|hole')
  block({ ...base, native: { ...base.native, roundId: 78 } }, 'round')
  block({ ...base, native: { ...base.native, observedAt: '2026-10-12T14:55:00.000Z' } }, 'stale')
  block({ ...base, native: { ...base.native, whitePinErrorPixels: 8 } }, 'pin')
  block({ ...base, native: { ...base.native, teeScaleYardsPerPixel: 0.7 } }, 'scale')
  block({ ...base, landmarks: landmarks.slice(0, 2) }, 'holdout')
  block({ ...base, landmarks: landmarks.map((x,i) => i===2 ? { ...x, nativeFeatureId: landmarks[1].nativeFeatureId } : x) }, 'distinct')
  block({ ...base, landmarks: landmarks.map((x,i) => i===2 ? { ...x, evidence: 'inferred' } : x) }, 'inferred')
  // Imported green centroid is never a precise surrogate for a GSPro pin.
  block({ ...base, landmarks: landmarks.map((x,i) => i===0 ? { ...x, spatialAccuracy: 'estimated', kind: 'pin' } : x) }, 'centroid')
  // Dogleg or reverse-numbered hole, swapped feature ownership: two fit
  // anchors can fit falsely, but the untouched third must reject it.
  const reverse = landmarks.map((x,i) => i<2 ? { ...x, courseLocalYds: local[1-i] } : x)
  block({ ...base, landmarks: reverse }, 'residual')
  // A mirror across the fitted axis is not a rotation. Holdout rejects it.
  const mirror = landmarks.map(x => ({ ...x, courseLocalYds: [-x.courseLocalYds[0], x.courseLocalYds[1]] }))
  block({ ...base, landmarks: mirror }, 'residual')
  // A third source point ON the fit axis cannot distinguish reflection; the
  // evaluator must request a genuinely off-axis independent landmark.
  const first = landmarks[0], second = landmarks[1]
  const halfway = first.gsproCanonicalPixel.map((n,i) => (n + second.gsproCanonicalPixel[i])/2)
  const halfwayLocal = first.courseLocalYds.map((n,i) => (n + second.courseLocalYds[i])/2)
  const inline = { ...landmarks[2], gsproCanonicalPixel: halfway, courseLocalYds: halfwayLocal }
  block({ ...base, landmarks: [first, second, inline] }, 'axis')
  // An assumed but incorrect bunker/green correspondence fails holdout.
  block({ ...base, landmarks: landmarks.map((x,i) => i===2 ? {
    ...x, courseLocalYds: [x.courseLocalYds[0]+16, x.courseLocalYds[1]+8],
  } : x) }, 'residual')

  console.log('PASS: cross-frame GSPro/OSM research-only fit, dogleg, stale, wrong hole, bad pin/scale, reflection, duplicate, guessed centroid and independent holdout')
} finally {
  await vite.close()
}
